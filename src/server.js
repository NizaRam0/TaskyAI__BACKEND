import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();

// Render runs behind a reverse proxy; this preserves correct client IP handling.
app.set('trust proxy', 1);

/**
 * ========================
 * ENV CONFIG
 * ========================
 */
const openaiApiKey = process.env.OPENAI_API_KEY ?? '';
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey })
  : null;// If no API key, we'll log a warning and use the fallback generator for all requests. so no api calls will be attempted.
  
// CORS origins can be configured via the CORS_ORIGINS env variable as a comma-separated list. 
// If not set, all origins are allowed (with a warning).
const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

  

/**
 * ========================
 * MIDDLEWARE
 * ========================
 */

// Logging (minimal but useful)
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});//shows in logs which endpoints are being hit, useful for monitoring and debugging

// Rate limiting (protect OpenAI usage)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min 60 sec x 1000 ms
  max: 20, // max 20 requests/min per IP
});
app.use('/ai/', limiter);
//limier is applied only to routes starting with /ai/, which currently includes the /ai/planner endpoint.
// Apply rate limiting only to AI-related endpoints to protect against abuse and control costs, 
// while keeping the health endpoint and others unaffected.

// CORS-
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.length === 0) {
        console.warn('⚠️ CORS_ORIGINS not set — allowing all origins');
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('CORS not allowed'));
    },
  }),
);

app.use(express.json()); //makes sure that JSON request bodies are parsed and available on req.body and can be used in the route handlers. This is essential for the /ai/planner endpoint which expects a JSON payload with prompt, startDate, and endDate.

/**
 * ========================
 * CONSTANTS
 * ========================
 */

const PRIORITIES = ['Low', 'Medium', 'High'];
const DEFAULT_CATEGORY = 'Work';
const CATEGORIES = ['Personal', 'Work', 'Learning', 'Sport/Activity', 'Errands'];
const AI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
const AI_RETRY_COUNT = Number(process.env.OPENAI_RETRY_COUNT || 2);
const AI_CHOICES_COUNT = clampInt(Number(process.env.OPENAI_CHOICES_COUNT) || 2, 1, 4);
// Default to 20 seconds if not set, but can be configured via env variable.
//  This is the maximum time we'll wait for a response from OpenAI before falling back to the built-in plan generator.

const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false, // strict field validation
  required: ['planTitle', 'subtasks'], // top-level fields are required without which the response is considered invalid
  properties: {
    planTitle: { type: 'string' },
    subtasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',//each subtask must be an object with specific fields
        additionalProperties: false, // strict field validation
        required: ['title', 'description', 'dueDateIso', 'priority', 'category'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          dueDateIso: { type: 'string' },
          priority: { type: 'string', enum: PRIORITIES },
          category: { type: 'string', enum: CATEGORIES },
        },
      },
    },
  },
};

/**
 * ========================
 * HELPERS
 * ========================
 */

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
  // if the input not a valid date string, getTime() will return NaN, so we check for that and return null for invalid dates.
  //only valid date strings will be parsed into Date objects, invalid ones will result in null, 
  // which we can handle gracefully in the rest of the code.
}

function clampInt(value, min, max) { 
  return Math.max(min, Math.min(max, value));
}

//Normalization functions ensure that even if the AI returns unexpected values for priority or category,
//  we can default to safe values and prevent issues in the client app that consumes this API.

function normalizePriority(value) {
  return PRIORITIES.includes(value) ? value : 'Medium'; 
}

function normalizeCategory(value) {
  return CATEGORIES.includes(value) ? value : DEFAULT_CATEGORY;
}

// clamp the datwe ensures that all due dates for subtasks are within the user-specified start and end date range,
//in a graceful way. If the AI returns a due date outside the range, 
// we adjust it to the nearest boundary (start or end date) instead of rejecting the entire response. 
// This helps maintain the integrity of the plan while still respecting user constraints.
function clampDateToRange(date, startDate, endDate) {
  if (date < startDate) return new Date(startDate);
  if (date > endDate) return new Date(endDate);
  return date;
}

function extractResponseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }


  //treat the case where response.output is an array of items, each potentially containing content with text.
  // This is to handle variations in how the AI might format its response, especially if it includes multiple sections or items.
  // We look for the first non-empty text content we can find in the output structure, which increases our chances of successfully extracting the intended JSON string 
  // even if the formatting isn't exactly as expected.

  const outputItems = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputItems) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const content of contentItems) {
      const text = content?.text;
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
  }

  return '';
}
///comeback
function parseJsonResponse(text) { // text is the raw string output from the AI that we expect to be JSON, 
// but we handle it flexibly to account for variations in formatting.
// We first trim the text to remove any leading/trailing whitespace, which can often cause JSON parsing to fail if not handled. 
// If the cleaned text is empty, we return null immediately.
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Handle occasional fenced output even with strict instructions.
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (!fenced?.[1]) {
      return null;
    }

    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
}

function parseCandidateContent(text) {
  const direct = parseJsonResponse(text);
  if (direct && typeof direct === 'object') {
    return direct;
  }

  const cleaned = typeof text === 'string' ? text.trim() : '';
  if (!cleaned) {
    return null;
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = cleaned.slice(firstBrace, lastBrace + 1);
    const slicedParsed = parseJsonResponse(sliced);
    if (slicedParsed && typeof slicedParsed === 'object') {
      return slicedParsed;
    }

    // Recover from common malformed JSON issue: trailing commas.
    const noTrailingCommas = sliced.replace(/,\s*([}\]])/g, '$1');
    const parsedNoTrailingCommas = parseJsonResponse(noTrailingCommas);
    if (parsedNoTrailingCommas && typeof parsedNoTrailingCommas === 'object') {
      return parsedNoTrailingCommas;
    }
  }

  return null;
}

function recoverPartialPlanFromText(text, prompt, startDate, endDate) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const normalizedText = text.trim();
  const titleMatch = normalizedText.match(/"planTitle"\s*:\s*"([^"]+)"/i);
  const fallbackTitleMatch = normalizedText.match(/plan\s*title\s*[:\-]\s*(.+)/i);
  const planTitle =
    (titleMatch?.[1] || fallbackTitleMatch?.[1] || `${prompt.trim()} plan`).trim();

  const bulletTitles = normalizedText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 50);

  if (bulletTitles.length === 0) {
    return { planTitle, subtasks: [] };
  }

  const totalDays = Math.max(
    1,
    Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1,
  );
  const subtasks = bulletTitles.map((title, index) => {
    const dayOffset = Math.floor((index * totalDays) / bulletTitles.length);
    const due = new Date(startDate);
    due.setDate(startDate.getDate() + dayOffset);

    return {
      title,
      description: `Complete: ${title}.`,
      dueDateIso: clampDateToRange(due, startDate, endDate).toISOString(),
      priority: 'Medium',
      category: DEFAULT_CATEGORY,
    };
  });

  return { planTitle, subtasks };
}

function extractPlanCandidates(response) {
  const candidates = [];
  const choices = Array.isArray(response?.choices) ? response.choices : [];

  for (let i = 0; i < choices.length; i++) {
    const message = choices[i]?.message;
    if (!message) {
      continue;
    }

    if (message.parsed && typeof message.parsed === 'object') {
      candidates.push({
        payload: message.parsed,
        text: typeof message.content === 'string' ? message.content : '',
        source: `choices[${i}].message.parsed`,
      });
      continue;
    }

    const text = typeof message.content === 'string' ? message.content : '';
    const parsed = parseCandidateContent(text);
    if (parsed && typeof parsed === 'object') {
      candidates.push({
        payload: parsed,
        text,
        source: `choices[${i}].message.content`,
      });
    } else if (text.trim()) {
      candidates.push({
        payload: null,
        text,
        source: `choices[${i}].message.content_unparsed`,
      });
    }
  }

  return candidates;
}

/**
 * ========================
 * FALLBACK PLAN GENERATOR
 * ========================
 */

function buildPlan({ prompt, startDate, endDate, tasksPerDay = 2 }) {
  const cleanedPrompt = prompt.trim();
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const safeTasksPerDay = clampInt(Number(tasksPerDay) || 2, 1, 10);

  const daySpan = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
  const totalDays = daySpan + 1;

  const totalTasks = clampInt(totalDays * safeTasksPerDay, 3, 50);

  const subtasks = [];

  for (let i = 0; i < totalTasks; i++) {
    const dayOffset = Math.floor(i / safeTasksPerDay);

    const due = new Date(start);
    due.setDate(start.getDate() + dayOffset);

    const clampedDue = clampDateToRange(due, startDate, endDate);

    let priority="ERROR";

    subtasks.push({
      title: `${cleanedPrompt} - Step ${i + 1}`,
      description: `ERROR: Failed to generate description for step ${i + 1}.`,
      dueDateIso: clampedDue.toISOString(),
      priority,
      category: DEFAULT_CATEGORY,
    });
  }

  return {
    planTitle: `${cleanedPrompt} plan`,
    subtasks,
  };
}

/**
 * ========================
 * NORMALIZATION
 * ========================
 */

function normalizePlanPayload(raw, prompt, startDate, endDate) {
  const fallback = buildPlan({ prompt, startDate, endDate });

  if (!raw || typeof raw !== 'object') return fallback;

  const planTitle =
    typeof raw.planTitle === 'string' && raw.planTitle.trim()
      ? raw.planTitle.trim()
      : fallback.planTitle;

  if (!Array.isArray(raw.subtasks) || raw.subtasks.length === 0) {
    return { planTitle, subtasks: fallback.subtasks };
  }

  const subtasks = raw.subtasks
    .map((item, i) => {
      if (!item || typeof item !== 'object') return null;

      const fallbackItem = fallback.subtasks[i % fallback.subtasks.length];

      const parsedDue = parseDate(item.dueDateIso);
      const title =
        typeof item.title === 'string' && item.title.trim().length
          ? item.title.trim()
          : fallbackItem.title;
      const description =
        typeof item.description === 'string'
          ? item.description.trim()
          : fallbackItem.description;

      return {
        title,
        description,
        dueDateIso: clampDateToRange(
          parsedDue || new Date(fallbackItem.dueDateIso),
          startDate,
          endDate,
        ).toISOString(),
        priority: normalizePriority(item.priority),
        category: normalizeCategory(item.category),
      };
    })
    .filter(Boolean);

  return { planTitle, subtasks: subtasks.length ? subtasks : fallback.subtasks };
}

/**
 * ========================
 * OPENAI CALL (WITH TIMEOUT)
 * ========================
 */
//use async/await syntax to call OpenAI's API to generate a task plan based on the user's prompt and date range.
//what are we awaiting for? We're waiting for the OpenAI API to respond with a generated plan,
//  which we expect to be in JSON format.
async function buildPlanWithOpenAI({ prompt, startDate, endDate }) {
  if (!openai) {
    console.warn('OPENAI_API_KEY is missing; using fallback plan generator.');
    return null;
  }

  let lastRecoverableText = '';
  const maxAttempts = AI_RETRY_COUNT + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

    console.info('OpenAI planner attempt started.', {
      attempt,
      maxAttempts,
      choicesRequested: AI_CHOICES_COUNT,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
    });

    try {
      const response = await openai.chat.completions.create({
        model: openaiModel,
        temperature: 0.3,
        n: AI_CHOICES_COUNT,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'task_plan',
            strict: true,
            schema: PLAN_RESPONSE_SCHEMA,
          },
        },
        messages: [
          {
            role: 'system',
            content:
              'Generate a practical task plan from the user prompt. '
              + 'Return JSON only and ensure every dueDateIso is within the provided startDate and endDate. '
              + 'Prefer 3 to 50 subtasks with specific, non-generic titles.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              prompt,
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString(),
            }),
          },
        ],
      }, {
        signal: controller.signal,
      });

      const candidates = extractPlanCandidates(response);

      if (candidates.length === 0) {
        console.warn('OpenAI planner returned no candidates.', { attempt, maxAttempts });
      }

      for (const candidate of candidates) {
        if (candidate.payload && typeof candidate.payload === 'object') {
          console.info('OpenAI planner candidate accepted.', {
            attempt,
            source: candidate.source,
          });
          return candidate.payload;
        }

        if (candidate.text?.trim()) {
          lastRecoverableText = candidate.text;
          console.warn('OpenAI planner candidate was not directly parseable.', {
            attempt,
            source: candidate.source,
            outputPreview: candidate.text.slice(0, 220),
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.toLowerCase().includes('abort');
      console.error('OpenAI planner request failed.', {
        attempt,
        maxAttempts,
        reason: isTimeout ? 'timeout' : 'request_failed',
        message,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  const recovered = recoverPartialPlanFromText(lastRecoverableText, prompt, startDate, endDate);
  if (recovered) {
    console.warn('Using partially recovered OpenAI output after all retries.', {
      outputPreview: lastRecoverableText.slice(0, 220),
    });
    return recovered;
  }

  console.error('OpenAI planner exhausted retries and recovery.');
  return null;
}

/**
 * ========================
 * ROUTES
 * ========================
 */

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/ai/planner', async (req, res) => {
  const { prompt, startDate, endDate } = req.body ?? {};

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }

  const parsedStart = parseDate(startDate);
  const parsedEnd = parseDate(endDate);

  if (!parsedStart || !parsedEnd) {
    return res.status(400).json({ error: 'Invalid dates' });
  }

  if (parsedEnd < parsedStart) {
    return res.status(400).json({ error: 'endDate < startDate' });
  }

  try {
    const aiPayload = await buildPlanWithOpenAI({
      prompt,
      startDate: parsedStart,
      endDate: parsedEnd,
    });

    const payload = normalizePlanPayload(
      aiPayload,
      prompt,
      parsedStart,
      parsedEnd,
    );

    if (!aiPayload) {
      console.warn('Using fallback plan because AI output was unavailable or invalid.');
    }

    return res.json(payload);
  } catch (err) {
    console.error(err);

    return res.json(
      buildPlan({
        prompt,
        startDate: parsedStart,
        endDate: parsedEnd,
      }),
    );
  }
});

/**
 * ========================
 * SERVER START
 * ========================
 */

const port = Number(process.env.PORT || 8787);

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${port}`);
});
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
  : null;

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
});

// Rate limiting (protect OpenAI usage)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 20, // max 20 requests/min per IP
});
app.use('/ai/', limiter);

// CORS
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

app.use(express.json());

/**
 * ========================
 * CONSTANTS
 * ========================
 */

const PRIORITIES = ['Low', 'Medium', 'High'];
const DEFAULT_CATEGORY = 'Work';
const CATEGORIES = ['Personal', 'Work', 'Learning', 'Sport/Activity', 'Errands'];

/**
 * ========================
 * HELPERS
 * ========================
 */

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePriority(value) {
  return PRIORITIES.includes(value) ? value : 'Medium';
}

function normalizeCategory(value) {
  return CATEGORIES.includes(value) ? value : DEFAULT_CATEGORY;
}

function clampDateToRange(date, startDate, endDate) {
  if (date < startDate) return new Date(startDate);
  if (date > endDate) return new Date(endDate);
  return date;
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

    let priority;
    if (i === 0 || i === totalTasks - 1) priority = 'High';
    else if (i < totalTasks / 3) priority = 'Medium';
    else priority = 'Low';

    subtasks.push({
      title: `${cleanedPrompt} - Step ${i + 1}`,
      description: `Complete step ${i + 1} of "${cleanedPrompt}".`,
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

async function buildPlanWithOpenAI({ prompt, startDate, endDate }) {
  if (!openai) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await openai.responses.create({
      model: openaiModel,
      temperature: 0.3,
      signal: controller.signal,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                'Return ONLY valid JSON: {"planTitle":"","subtasks":[{"title":"","description":"","dueDateIso":"","priority":"Low|Medium|High","category":"Personal|Work|Learning|Sport/Activity|Errands"}]}',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                prompt,
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
              }),
            },
          ],
        },
      ],
    });

    const text = response.output_text?.trim();
    if (!text) return null;

    return JSON.parse(text);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
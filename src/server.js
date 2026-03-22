import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const openaiApiKey = process.env.OPENAI_API_KEY ?? '';
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

app.use(cors());
app.use(express.json());

const PRIORITIES = ['Low', 'Medium', 'High'];
const DEFAULT_CATEGORY = 'Work';
const CATEGORIES = ['Personal', 'Work', 'Learning', 'Sport/Activity', 'Errands'];

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
  if (date < startDate) {
    return new Date(startDate);
  }
  if (date > endDate) {
    return new Date(endDate);
  }
  return date;
}

function buildPlan({ prompt, startDate, endDate, tasksPerDay = 2 }) {
  const cleanedPrompt = prompt.trim();

  // Normalize start date to midnight (no timezone/time component interference)
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());

  // Calculate the span in days between startDate and endDate
  const daySpan = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));

  // Total days is inclusive of both start and end dates (e.g., same day = 1 day)
  const totalDays = daySpan + 1;

  // Scale total tasks based on density (tasksPerDay), but enforce hard bounds
  // Min 3 ensures meaningful plans, max 50 prevents performance issues
  // Formula: totalTasks = clamp(totalDays * tasksPerDay, 3, 50)
  const totalTasks = clampInt(totalDays * tasksPerDay, 3, 50);

  const subtasks = [];

  for (let i = 0; i < totalTasks; i += 1) {
    // Distribute tasks evenly across days using density
    // Example: tasksPerDay=2, i=0→day 0, i=1→day 0, i=2→day 1, i=3→day 1
    const dayOffset = Math.floor(i / tasksPerDay);

    // Calculate the base due date by adding dayOffset days to start
    const due = new Date(start);
    due.setDate(start.getDate() + dayOffset);

    // Safety clamp: ensure due date never exceeds the [startDate, endDate] range
    // Protects against edge cases (1-day spans, rounding artifacts)
    const clampedDue = clampDateToRange(due, startDate, endDate);

    // Priority assignment strategy:
    // - First task (i===0): High — critical setup/kickoff
    // - Last task (i===totalTasks-1): High — critical finalization/wrap-up
    // - Early tasks (i < totalTasks/3): Medium — foundation/important groundwork
    // - Remaining tasks: Low — supporting work
    let priority;
    if (i === 0 || i === totalTasks - 1) {
      priority = 'High';
    } else if (i < totalTasks / 3) {
      priority = 'Medium';
    } else {
      priority = 'Low';
    }

    subtasks.push({
      title: `${cleanedPrompt} - Step ${i + 1}`,
      description: `Complete step ${i + 1} of "${cleanedPrompt}" and prepare the next step.`,
      dueDateIso: clampedDue.toISOString(),
      priority: PRIORITIES.includes(priority) ? priority : 'Medium',
      category: DEFAULT_CATEGORY,
    });
  }

  return {
    planTitle: `${cleanedPrompt} plan`,
    subtasks,
  };
}

function normalizePlanPayload(rawPayload, prompt, startDate, endDate) {
  const fallback = buildPlan({ prompt, startDate, endDate });
  if (!rawPayload || typeof rawPayload !== 'object') {
    return fallback;
  }

  const planTitle = typeof rawPayload.planTitle === 'string' && rawPayload.planTitle.trim().length
    ? rawPayload.planTitle.trim()
    : fallback.planTitle;

  if (!Array.isArray(rawPayload.subtasks) || rawPayload.subtasks.length === 0) {
    return { planTitle, subtasks: fallback.subtasks };
  }

  const subtasks = rawPayload.subtasks
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const fallbackItem = fallback.subtasks[index % fallback.subtasks.length];

      const title =
        typeof item.title === 'string' && item.title.trim().length
          ? item.title.trim()
          : fallbackItem.title;
      const description =
        typeof item.description === 'string'
          ? item.description.trim()
          : fallbackItem.description;
      const parsedDue = parseDate(item.dueDateIso);
      const dueDate = clampDateToRange(parsedDue || parseDate(fallbackItem.dueDateIso), startDate, endDate);

      return {
        title,
        description,
        dueDateIso: dueDate.toISOString(),
        priority: normalizePriority(item.priority),
        category: normalizeCategory(item.category),
      };
    })
    .filter(Boolean);

  if (!subtasks.length) {
    return { planTitle, subtasks: fallback.subtasks };
  }

  return { planTitle, subtasks };
}

async function buildPlanWithOpenAI({ prompt, startDate, endDate }) {
  if (!openai) {
    return null;
  }

  const systemPrompt = [
    'You are a project planning assistant.',
    'Return ONLY valid JSON with this exact shape:',
    '{"planTitle":"string","subtasks":[{"title":"string","description":"string","dueDateIso":"ISO string","priority":"Low|Medium|High","category":"Personal|Work|Learning|Sport/Activity|Errands"}]}',
    'No markdown, no extra keys, no prose.',
    'Every dueDateIso must be within the provided startDate and endDate.',
    'Return 3 to 50 subtasks.',
  ].join(' ');

  const userPrompt = JSON.stringify({
    prompt,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  });

  const response = await openai.responses.create({
    model: openaiModel,
    temperature: 0.3,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      { role: 'user', content: [{ type: 'input_text', text: userPrompt }] },
    ],
  });

  const text = response.output_text?.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/ai/planner', async (req, res) => {
  const { prompt, startDate, endDate } = req.body ?? {};

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'prompt is required and must be a non-empty string' });
  }

  const parsedStart = parseDate(startDate);
  const parsedEnd = parseDate(endDate);

  if (!parsedStart || !parsedEnd) {
    return res.status(400).json({ error: 'startDate and endDate must be valid ISO date strings' });
  }

  if (parsedEnd < parsedStart) {
    return res.status(400).json({ error: 'endDate must be greater than or equal to startDate' });
  }

  let payload;
  try {
    const aiPayload = await buildPlanWithOpenAI({
      prompt,
      startDate: parsedStart,
      endDate: parsedEnd,
    });

    payload = normalizePlanPayload(aiPayload, prompt, parsedStart, parsedEnd);
  } catch {
    payload = buildPlan({
      prompt,
      startDate: parsedStart,
      endDate: parsedEnd,
    });
  }

  return res.status(200).json(payload);
});

const port = Number(process.env.PORT || 8787);
app.listen(port, '0.0.0.0', () => {
  console.log(`AI planner backend running on http://192.168.100.196:${port}`);
});

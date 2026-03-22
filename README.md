# AI Planner Backend

## Environment

Create `backend/.env` from `backend/.env.example`:

```env
PORT=8787
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4.1-mini
```

Notes:

- If `OPENAI_API_KEY` is missing or request fails, server falls back to local mock planner.
- Flutter app should only know backend URL, never OpenAI key.

## Run

1. Install deps:

```bash
npm install
```

2. Start server:

```bash
npm run dev
```

Server runs on `http://localhost:8787` by default.

## Endpoint

### POST /ai/planner

Request body:

```json
{
  "prompt": "Plan exam week",
  "startDate": "2026-03-24T00:00:00.000Z",
  "endDate": "2026-03-28T00:00:00.000Z"
}
```

Response body:

```json
{
  "planTitle": "Plan exam week plan",
  "subtasks": [
    {
      "title": "Plan exam week - Step 1",
      "description": "Complete step 1 of \"Plan exam week\" and prepare the next step.",
      "dueDateIso": "2026-03-24T00:00:00.000Z",
      "priority": "High",
      "category": "Work"
    }
  ]
}
```

The response shape is always:

- `planTitle: string`
- `subtasks: Array<{ title, description, dueDateIso, priority, category }>`

## Health check

### GET /health

Response:

```json
{
  "ok": true
}
```
# TaskyAi_BACKEND

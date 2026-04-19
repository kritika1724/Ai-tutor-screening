# AI Tutor Screener

A deployable, voice-first tutor screening app for Cuemath. The product runs a short spoken interview, adapts the difficulty based on answer quality, and returns a recruiter-ready scorecard with evidence by dimension.

## Highlights

- Voice-first candidate experience with microphone capture and spoken interviewer prompts
- Adaptive interview flow with follow-ups for weak answers and stretch prompts for strong answers
- Structured assessment across clarity, warmth, simplicity, patience, and English fluency
- Mandatory candidate name and email capture before the interview begins
- Graceful fallback mode when OpenAI is unavailable
- Production setup where the Express server can serve the built frontend directly

## Stack

- Frontend: React 19 + Vite
- Backend: Express 5
- AI: OpenAI responses plus transcription when `OPENAI_API_KEY` is configured
- Persistence: MongoDB when `MONGO_URI` is set, otherwise local JSON archives in [ai-tutor-backend/data/interviews](/Users/kritikatrivedi/Desktop/ai tutor/ai-tutor-backend/data/interviews)

## Quick Start

1. Create `ai-tutor-backend/.env` from [ai-tutor-backend/.env.example](/Users/kritikatrivedi/Desktop/ai tutor/ai-tutor-backend/.env.example:1).
2. From the project root, run:

```bash
npm install
npm run dev
```

3. Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

Root `npm install` installs both the backend and frontend automatically.

## Environment

Recommended backend variables:

```bash
PORT=5001
CLIENT_URL=http://localhost:5173,http://127.0.0.1:5173
OPENAI_API_KEY=your_openai_api_key
OPENAI_TEXT_MODEL=gpt-5.4-mini
OPENAI_EVAL_MODEL=gpt-5.4-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
MONGO_URI=your_optional_mongodb_connection_string
```

Notes:

- `OPENAI_API_KEY` is optional, but without it the app falls back to a lighter browser-assisted mode.
- `MONGO_URI` is optional. If Mongo is unavailable, the server still runs and archives interviews locally.
- `VITE_API_BASE_URL` is only needed when the frontend is hosted separately from the backend.

## Root Commands

- `npm run dev` starts backend and frontend together for local development
- `npm run build` builds the frontend for production
- `npm start` starts the backend, which serves the built frontend when [ai-tutor-frontend/dist](/Users/kritikatrivedi/Desktop/ai tutor/ai-tutor-frontend/dist) exists
- `npm run check` runs lint, production build, and backend syntax checks

## Production Deployment

This repository is now set up for a simple single-service deployment:

1. Run `npm install`
2. Run `npm run build`
3. Run `npm start`

The backend serves the frontend build in production, so you can deploy this as one Node service on platforms like Render, Railway, Fly.io, or any VPS.

If you host the frontend separately, set `VITE_API_BASE_URL` during the frontend build to point at your deployed backend.

## Render Deployment

This repo now includes [render.yaml](/Users/kritikatrivedi/Desktop/ai tutor/render.yaml:1), so Render can auto-detect the service settings.

### Recommended Render flow

1. Push the repo to GitHub.
2. In Render, choose `New +` -> `Blueprint`.
3. Connect your GitHub repo.
4. Render will pick up:
   - build command: `npm install && npm run build`
   - start command: `npm start`
   - health check: `/health`
5. Add these environment variables in Render:

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_TEXT_MODEL=gpt-5.4-mini
OPENAI_EVAL_MODEL=gpt-5.4-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
MONGO_URI=your_optional_mongodb_connection_string
```

Notes:

- You do not need `VITE_API_BASE_URL` on Render when using the single-service setup, because the backend serves the frontend and the frontend uses same-origin API calls.
- You usually do not need `CLIENT_URL` for the same reason.
- If `MONGO_URI` is missing, the app still works and stores completed interviews locally on the server.
- Never paste API keys into frontend code or commit them to GitHub.

## Candidate Flow

1. Enter the candidate name and email.
2. The app clearly tells the candidate to answer in English.
3. The interviewer asks spoken questions and adapts based on answer strength.
4. The final screen returns a structured recommendation with evidence quotes.

## Security

- No API keys are exposed in the frontend bundle
- `.env` files are ignored by git
- The example environment file contains placeholders only
- Completed interview data stays on the server side

## Current Limitations

- Best browser experience is still Chrome or Edge
- Browser fallback transcription is less reliable than OpenAI transcription
- Full production quality is best when an OpenAI API key is configured

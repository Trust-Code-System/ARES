# ARES Web (Phase 5)

Next.js (App Router) + Tailwind front end for ARES. It is a **thin client** over
the ARES API server — all behaviour lives in the backend (`src/server`). This app
only renders and calls endpoints.

## Run it

ARES is two processes: the API server, and this UI.

```bash
# 1. from the repo root — start the API (default :3001)
npm run serve

# 2. in another terminal — start the UI (default :3000)
cd web
npm install
npm run dev
```

Point the UI at the API with `NEXT_PUBLIC_ARES_API` if it isn't on
`http://localhost:3001`:

```bash
NEXT_PUBLIC_ARES_API=http://localhost:3001 npm run dev
```

## What's here

- **`/` — Chat.** Streams answers from `POST /api/chat/stream` (SSE), shows live
  tool activity, supports specialist modes, push-to-talk transcription, optional
  automatic speech playback, and speech interruption.
- **`/dashboard` — Dashboard.** Kill switch toggle, the confirmation queue
  (approve/deny), runtime/capability status, tool toggles, scheduled jobs, the
  activity feed, explicit remember/forget controls, and memory search. Polls the
  API every 5s.

## Voice mode

The mic button posts recorded audio to `POST /api/voice/transcribe`; assistant
answers can be played through `POST /api/voice/speak`. The server's
bundled `OpenAiVoiceProvider` (Whisper STT + TTS, see `src/server/voice.ts`)
activates when `OPENAI_API_KEY` is set on the API server; without it the endpoint
returns `501` and the button shows a hint. Override the models/voice with the
`ARES_VOICE_*` env vars (see the root README).

> Note: this front end is scaffolding that targets the tested API. Its endpoints
> are covered by `tests/server.test.ts`; the React app itself is run with
> `npm run dev` (it is intentionally outside the root TypeScript build).

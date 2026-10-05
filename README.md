# Live Chat POC

Standalone proof of concept for real-time speech-to-speech voice chat using
the Gemini Live API, built to match Kyros's existing tutor persona with
mock tool-calling. It now includes a DialogLab-derived 3D tutor avatar whose
mouth movement follows the amplitude of Gemini's streamed audio. See
`../docs/superpowers/specs/2026-09-23-live-chat-poc-design.md` (a sibling
directory one level up from `live-chat-poc/`) for the full design.

## Run it

### Backend
```bash
cd backend
cp .env.example .env   # fill in GEMINI_API_KEY
uv sync
uv run uvicorn app.main:app --port 8100
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000, click "Start conversation", grant mic access.

## Manual test checklist

1. Speak — confirm you hear a spoken response with reasonably low latency
   and a tutor-like tone.
2. Say "can you quiz me on photosynthesis?" — confirm a `generate_quiz` card
   renders and the assistant verbally acknowledges it.
3. Say "show me a mindmap of cell biology" — confirm a `generate_mindmap`
   card renders.
4. Start speaking while the assistant is talking (barge-in) — confirm it
   stops and starts listening again.
5. Ask a follow-up that depends on something said earlier in the same
   session — confirm the assistant still has that context.
6. While the tutor speaks, confirm the 3D avatar changes expression and its
   mouth follows the audio; interrupt it and confirm the mouth returns to idle.

## Known limitations (by design — see spec's Non-goals)

- Mock tools only, no real content generation.
- No context persistence across reconnects.
- No auth, no retry/reconnect logic, no deployment config.
- Lip movement is audio-amplitude driven rather than phoneme/viseme accurate.
- The included Ready Player Me model is a DialogLab evaluation asset only;
  production needs a separately licensed Kyros avatar.

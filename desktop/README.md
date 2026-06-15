# ARES Desktop

Cross-platform PySide6 command center for the existing ARES API.

## Setup

```powershell
npm run desktop:setup
npm run serve
npm run desktop
```

The launcher creates a project-local `.venv` and selects the correct Python
interpreter on Windows, macOS, and Linux.

Set `ARES_API_URL` only when the API is not at `http://127.0.0.1:3001`.

Features:

- Streaming text conversation and specialist modes
- Push-to-talk WAV recording and transcription
- Automatic TTS playback with interruption
- Pulsing 3D-style HUD avatar reflecting listening/thinking/speaking/error state
- Live tool and safety activity
- Provider/model/STT/TTS runtime telemetry

Voice is currently turn-based push-to-talk with interruptible playback. An
always-open full-duplex Gemini Live session is a separate future transport.

The desktop client does not bypass ARES safety. Python execution, file writes,
application launches, and URL launches still pass through the backend
confirmation queue and audit log.

# Local AI Engine Setup

MeetingScribe is a browser-only Progressive Web App. It ships with a
built-in heuristic summarizer and works for recording/transcript editing
with zero setup, but the strongest offline transcription engine (Whisper
WASM) and local LLM summaries both need a short one-time setup, described
below.

**If you used the desktop (Electron) version before:** whisper.cpp and
faster-whisper setup (previously Options A and B here) are gone. Neither
can run in a browser under any circumstances — both require spawning a
native binary/subprocess, which no browser sandbox permits, for any web
page, ever. Whisper WASM is now the primary offline engine.

## Option A — Whisper WASM (runs inside the browser tab, fully offline)

This runs whisper.cpp compiled to WebAssembly, entirely inside a Web
Worker in this page, via a vendored library
([@timur00kh/whisper.wasm](https://github.com/timur00kh/whisper.wasm),
MIT) — no external process, no network request once the model is cached.

**No computer, no manual file setup needed at all — this can be done
entirely from your phone.** Unlike the very first version of this setup:

1. Open **Settings → AI Engines**.
2. Under **Whisper WASM**, pick a model size from the dropdown. `base.en`
   is a reasonable default balance of speed/accuracy/size; `tiny.en` is
   smaller and faster but less accurate; `small.en` is the most accurate
   but the slowest and largest download.
3. Click **Download & enable**.
4. Wait for the progress bar — this is a real download (75MB-466MB
   depending on the model you picked), so it'll take a while on a slow
   connection, but it only happens once. The model is cached in this
   browser's own storage afterward.
5. Once it finishes, "Whisper WASM" shows as detected, and it becomes the
   active transcription engine automatically the next time you record.

**Why this used to require a computer, and doesn't anymore:** the earlier
approach required manually building or extracting three specific files
(`whisper.js`, `whisper.wasm`, a renamed model file) and pushing them into
this repo by hand. This library instead fetches model weights directly
from Hugging Face and caches them in this browser's IndexedDB storage
itself — so the "one-time setup" now happens on whatever device is
actually running the app, no separate computer step required.

**If you want to switch models later** (e.g. try a more accurate one),
just pick a different one in the dropdown and click **Download & enable**
again — each model size is cached independently, so switching back is
instant if you've downloaded it before.

## Option B — Web Speech API (last resort — reads the disclosure first)

Uses the browser's built-in speech recognition. **This is the one feature
in MeetingScribe that is not offline** — your microphone audio is sent to
Google's servers. Off by default.

1. Open **Settings → AI Engines → Web Speech API**.
2. Check **Enable Web Speech fallback**.
3. Read the disclosure dialog and confirm — this step cannot be skipped or
   pre-approved, by design.

Only microphone-mode recording is meaningfully supported — the standard
`SpeechRecognition` API has no way to accept a custom audio stream, so it
can't usefully process system-audio or mixed-mode recordings.

## Local LLM summaries — Ollama (recommended)

1. Install Ollama from [ollama.com](https://ollama.com) and pull a model,
   e.g. `ollama pull llama3.1` or `ollama pull mistral`.
2. **Browser-specific requirement that didn't exist in the desktop
   version:** Ollama's server needs to allow requests from this app's exact
   origin, or your browser's CORS policy will silently block every
   summarization request. Set the `OLLAMA_ORIGINS` environment variable to
   this app's origin before starting Ollama, for example:
   ```sh
   OLLAMA_ORIGINS="http://localhost:5173" ollama serve
   ```
   (adjust the origin to match whatever URL you actually load this app
   from — check your browser's address bar).
3. In MeetingScribe: **Settings → AI Engines → Re-scan** — "Ollama" should
   turn green. MeetingScribe automatically uses whichever model you've
   pulled (the first one Ollama reports if you have several); it only ever
   talks to Ollama via `http://127.0.0.1:11434`, never over the internet.

If "Ollama" still shows as not detected after installing it, the most
common cause is the CORS/origin step above — check your browser's
developer console for a blocked-by-CORS error to confirm.

## Local LLM summaries — llama.cpp server (alternative)

1. Build `llama.cpp` and run its server mode with a GGUF model, enabling
   CORS:
   ```sh
   ./llama-server -m /path/to/model.gguf --port 8080 --cors
   ```
2. In **Settings → AI Engines → Summaries (local LLM)**, set the *llama.cpp
   port* field if you changed it from 8080, then click **Re-scan**.

## Nothing installed?

MeetingScribe still works fully: recording, the transcript editor, meeting
library, search, playback, and all 7 export formats all work with zero
setup. Summaries fall back automatically to a built-in heuristic summarizer
(word-frequency scoring, keyword clustering, and pattern matching for
decisions/risks/questions/action items) — no LLM, no network, no setup.
Live transcription will show a banner explaining that no engine is
configured until you complete Option A or B above.

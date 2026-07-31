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
Worker in this page — no external process, no network request once the
files below are in place.

You'll need a build of whisper.cpp's `examples/whisper.wasm` target. If you
have `git`, `cmake`, and the Emscripten SDK (`emsdk`) installed:

```sh
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
source /path/to/emsdk/emsdk_env.sh
emcmake cmake -B build-wasm
cmake --build build-wasm --target whisper.wasm
```

The build output includes an Emscripten-generated glue script and a
compiled `.wasm` binary. Copy (renaming as needed) exactly these three
files into this app's `assets/whisper-wasm/` directory:

```
assets/whisper-wasm/whisper.js       <- the Emscripten glue/loader script
assets/whisper-wasm/whisper.wasm     <- the compiled WASM binary (same basename as whisper.js)
assets/whisper-wasm/ggml-model.bin   <- a GGML model file, renamed to exactly this
```

**The model filename must be exactly `ggml-model.bin`.** The desktop
version could scan the directory for any `ggml-*.bin` file; a browser
cannot list directory contents at all, so detection instead checks this
one fixed path. Download a small model to start with (`ggml-base.en.bin`
or `ggml-tiny.en.bin` from the whisper.cpp model repository) and rename it.

Once the three files are in place, open **Settings → AI Engines → Re-scan**
— no restart needed, since detection re-checks these files every time you
click it. You should see "Whisper WASM — detected". Start a short recording
to confirm transcribed text appears in the Transcript tab.

**Version sensitivity:** whisper.cpp's exported JS function names
(`Module.init`, `Module.full_default`) have changed shape across releases.
`whisperWasmWorker.js` defensively handles both the older single-context
and current multi-context shapes, but a very different or much newer build
may need small adjustments to that file.

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

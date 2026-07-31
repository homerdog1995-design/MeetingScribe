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
files below are in place. **This setup needs a computer** (it involves
downloading files and pushing them to this repo) — once done, it works on
every device that loads this app, phone included.

You need exactly three files in `assets/whisper-wasm/`:

```
assets/whisper-wasm/whisper.js        <- Emscripten-generated glue/loader script
assets/whisper-wasm/whisper.wasm      <- compiled WASM binary (only if your build produces one separately — see note below)
assets/whisper-wasm/ggml-model.bin    <- a GGML model file, renamed to exactly this
```

**The model filename must be exactly `ggml-model.bin`, and the glue script
must be exactly `whisper.js`.** A browser can't scan a directory for "any
file matching a pattern" the way a desktop app can, so detection checks
these exact paths.

### Path 1 — extract from the official live demo (no building required)

whisper.cpp's maintainers host a continuously-updated live demo at
**https://whisper.ggerganov.com/**. You can pull the already-compiled files
straight from it instead of building anything:

1. On a desktop browser (Chrome or Edge), open that URL.
2. Open DevTools (F12) → **Network** tab → reload the page.
3. Filter by **JS**, find the main script (likely named `libmain.js` — by
   default this build embeds the WASM binary inside it as base64, so
   there's often no separate `.wasm` file to find), right-click it →
   **Save response as...** → rename it to `whisper.js`. If a separate
   `.wasm` file also loads, save and rename that to `whisper.wasm` too.
4. On the same page, pick a model from the dropdown (start with
   **tiny.en**, 75MB) — clicking it downloads the model file directly.
   Rename whatever you get to `ggml-model.bin`.
5. Upload all files you have to `assets/whisper-wasm/` in this repo
   (github.com's web UI: **Add file → Upload files** works fine, no git
   needed) and commit to `main`.

### Path 2 — build from source with Emscripten (if Path 1 doesn't work for you)

Requires `git`, `cmake`, and the Emscripten SDK (`emsdk`) installed:

```sh
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
mkdir build-em && cd build-em
emcmake cmake ..
make -j
```

The build output lands in `build-em/bin/`. Copy it into this repo's
`assets/whisper-wasm/`, renaming as you go:

```sh
cp bin/libmain.js  /path/to/this/repo/assets/whisper-wasm/whisper.js
# Only present if you built with -DWHISPER_WASM_SINGLE_FILE=OFF:
cp bin/libmain.wasm /path/to/this/repo/assets/whisper-wasm/whisper.wasm
```

By default (`WHISPER_WASM_SINGLE_FILE=ON`) the WASM binary is embedded as
base64 inside `libmain.js` itself, so there's no separate `.wasm` file to
copy — that's expected, not an error. Then add a model file (download one
from the whisper.cpp model repository, e.g. `ggml-tiny.en.bin`) renamed to
`ggml-model.bin`, and push everything to `main`.

Once the files are in place (either path), open **Settings → AI Engines →
Re-scan** — no restart needed, since detection re-checks these files every
time you click it. You should see "Whisper WASM — detected". Start a short
recording
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

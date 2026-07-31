# Local AI Engine Setup

MeetingScribe records, organizes, edits, searches, backs up, and exports
meetings with **zero setup**. This document covers the *optional* one-time
steps for the two things that genuinely require a real AI model on disk:
high-accuracy transcription and LLM-generated summaries. Every option below
runs entirely on your machine — nothing here is a MeetingScribe server, and
none of it is contacted by the app except over `127.0.0.1`.

Open **Settings → AI Engines → Re-scan** in the app at any time after
completing a setup below; MeetingScribe will detect it automatically.

---

## Option A — whisper.cpp (recommended: no Python, fastest to set up)

1. Download a release build for your OS from
   `https://github.com/ggml-org/whisper.cpp/releases`, **or** build from
   source:
   ```bash
   git clone https://github.com/ggml-org/whisper.cpp.git
   cd whisper.cpp
   cmake -B build
   cmake --build build --config Release
   ```
   This produces `build/bin/whisper-cli` (`whisper-cli.exe` on Windows).
2. Download a model (this is the only step that needs an internet
   connection — it is a one-time manual download, not something the running
   app does for you):
   ```bash
   ./models/download-ggml-model.sh base.en
   ```
   For speaker-turn detection, use a `tinydiarize` model instead:
   ```bash
   ./models/download-ggml-model.sh small.en-tdrz
   ```
3. In MeetingScribe: **Settings → AI Engines → whisper.cpp**, set:
   - *Binary path* → the full path to `whisper-cli` / `whisper-cli.exe`
   - *Model path* → the full path to the downloaded `ggml-*.bin` file
   - Tick *"This model supports tinydiarize speaker turns"* only if you
     downloaded a `-tdrz` model and pass `-tdrz` automatically.
4. Click **Re-scan** — the status dot next to "whisper.cpp" should turn
   green ("detected"). Start a short recording; transcribed text should
   begin appearing in the Transcript tab within a few seconds of speaking.

## Option B — faster-whisper (GPU-friendly, needs Python)

1. Install Python 3.9+ and:
   ```bash
   pip install faster-whisper
   ```
2. MeetingScribe ships a small bridge script that faster-whisper uses to talk
   to the app over stdin/stdout JSON — no changes needed, it is already at
   `scripts/faster_whisper_bridge.py` in this project.
3. In **Settings → AI Engines → faster-whisper**, set:
   - *Python executable* → e.g. `python3` or the full path to your venv's
     `python`
   - *Model size* → `tiny` / `base` / `small` / `medium` / `large-v3`
     (downloaded automatically by faster-whisper itself, cached under
     `~/.cache/huggingface`, on first use — subsequent runs are fully
     offline)
   - *Device* → `cpu` or `cuda` if you have an NVIDIA GPU with CUDA installed
4. Click **Re-scan** — the status dot next to "Faster-Whisper" should turn
   green ("detected"). Start a short recording to confirm transcribed text
   appears in the Transcript tab.

## Option C — Whisper WASM (runs inside the app, no external process)

This is the most "batteries included" offline option because MeetingScribe
never has to spawn an external binary — but it requires you to build the
WebAssembly bundle yourself once, because shipping a compiled `.wasm` binary
in application source is not appropriate here.

1. Install the Emscripten SDK: `https://emscripten.org/docs/getting_started/downloads.html`
2. Build whisper.cpp's WASM example:
   ```bash
   git clone https://github.com/ggml-org/whisper.cpp.git
   cd whisper.cpp
   source /path/to/emsdk/emsdk_env.sh
   cmake -B build-wasm -DCMAKE_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake
   cmake --build build-wasm --target whisper.wasm
   ```
3. Copy the produced `whisper.wasm` and its JS glue file, plus a small model
   (e.g. `ggml-tiny.en.bin` — small models are strongly recommended here
   since the model is loaded into the renderer's memory) into
   `assets/whisper-wasm/` in this project:
   ```
   assets/whisper-wasm/whisper.wasm
   assets/whisper-wasm/whisper.js
   assets/whisper-wasm/ggml-tiny.en.bin
   ```
4. Click **Re-scan** in **Settings → AI Engines** — no restart needed, since
   detection re-checks the filesystem every time. You should see
   "Whisper WASM — detected" once all three files are present.

## Option D — Web Speech API (last resort — reads the disclosure first)

**This is the one engine that is not offline.** Chromium sends microphone
audio to Google's servers to perform recognition; there is no local mode for
this browser API. It exists purely as a convenience fallback if you have no
other engine installed and explicitly accept that trade-off.

To enable it: **Settings → AI Engines → Web Speech API → toggle on**, then
confirm the acknowledgement dialog. It stays off across restarts by default;
you must re-confirm after every reinstall.

---

## Local LLM summaries — Ollama (recommended)

1. Install Ollama from `https://ollama.com` (native installer for your OS).
2. Pull a model, e.g.:
   ```bash
   ollama pull mistral
   # or: ollama pull gemma2   /   ollama pull llama3.1
   ```
3. Make sure the Ollama daemon is running (it normally runs automatically as
   a background service after install; `ollama serve` starts it manually).
4. In MeetingScribe: **Settings → AI Engines → Re-scan** — "Ollama" should
   turn green. MeetingScribe automatically uses whichever model you've
   pulled (the first one Ollama reports if you have several); it talks to
   Ollama only via `http://127.0.0.1:11434`, never over the internet.

## Local LLM summaries — llama.cpp server (alternative)

1. Build `llama.cpp` (`https://github.com/ggml-org/llama.cpp`) and download a
   GGUF model (Mistral/Gemma/Llama family all work).
2. Start the server:
   ```bash
   ./llama-server -m /path/to/model.gguf --port 8080
   ```
3. In **Settings → AI Engines → Summaries (local LLM)**, set the *llama.cpp
   port* field if you changed it from 8080, then click **Re-scan**.

---

## Nothing installed?

MeetingScribe still works. Recording, the library, the transcript editor,
search, export, and backups all function fully offline with zero setup.
Summaries fall back automatically to the built-in heuristic summarizer
(extractive, TF‑IDF/TextRank-based — see `ARCHITECTURE.md §6`), and live
transcription simply shows a "no transcription engine configured" state in
the recording view with a link back to this document, rather than pretending
to transcribe with nothing behind it.

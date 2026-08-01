# Local AI Engine Setup

MeetingScribe is a browser-only Progressive Web App. It ships with a
built-in heuristic summarizer, real on-device speaker diarization, and the
primary offline transcription engine (Sherpa-ONNX ASR) all with **zero
setup** — every model is committed directly into this repo. Only local LLM
summaries (optional, via Ollama or llama.cpp) need any setup at all,
described below.

**If you used the desktop (Electron) version before:** whisper.cpp and
faster-whisper setup (previously Options A and B here) are gone. Neither
can run in a browser under any circumstances — both require spawning a
native binary/subprocess, which no browser sandbox permits, for any web
page, ever.

**If you tried the Whisper WASM setup from an earlier version of this
app:** it's been removed entirely. It relied on a third-party WebAssembly
build (`@timur00kh/whisper.wasm`) that crashed reliably and immediately on
real device testing — confirmed not to be a configuration problem on our
end (short chunks, thread count, and model size were all ruled out one by
one with real evidence) but a deeper incompatibility with the compiled
binary itself. Sherpa-ONNX ASR replaces it.

## Sherpa-ONNX ASR — the primary offline transcription engine

Runs entirely inside a Web Worker in this page — no external process, no
network request, no setup. The engine and its model are committed
directly into this repo (`assets/speech-recognition/`), so there is
nothing to download, configure, or enable; it's simply on by default (see
Settings → AI Engines to turn it off if you ever need to).

This is a genuinely different kind of engine from the old Whisper WASM
integration, not just a replacement with the same shape: it has **real,
built-in endpoint detection** — an acoustic signal for "this utterance just
ended" — rather than guessing from silence gaps the way both the old
Whisper integration and Web Speech's continuous mode effectively did. That
built-in detection is what actually fixes repeated/stacked words in the
live transcript: text is only ever committed once the engine itself
confirms an utterance boundary, not as a still-growing, not-yet-finalized
guess.

It's also the same underlying toolkit
([k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0)
as the speaker-diarization feature — already proven to run successfully in
this exact browser/device environment before this integration was ever
attempted, which is part of why it was chosen over other options.

**Why the model is split into multiple files:** the model data is
~191MB, which exceeds GitHub's 100MB-per-file limit for a normal git push.
Confirmed directly (checking response headers) that GitHub's release-asset
host doesn't send CORS headers either, so the browser couldn't fetch it
from there at runtime — the same class of problem that blocked the old
Whisper model's Hugging Face download path. Splitting the file into
`<100MB` parts, committing them into this same repo, and reassembling them
via same-origin `fetch()` calls at load time sidesteps depending on any
third-party host's CORS policy at all — see `sherpaAsrWorker.js`'s file
header for the implementation.

## Option A — Web Speech API (last resort — reads the disclosure first)

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

MeetingScribe works fully with zero setup: recording, live transcription
(Sherpa-ONNX ASR, on by default), speaker diarization, the transcript
editor, meeting library, search, playback, and all 7 export formats.
Summaries fall back automatically to a built-in heuristic summarizer
(word-frequency scoring, keyword clustering, and pattern matching for
decisions/risks/questions/action items) if no local LLM is configured —
no LLM, no network, no setup.

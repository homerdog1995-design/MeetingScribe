# MeetingScribe — Architecture Reference

This document describes *how* the application is built and *why* it is built that
way. Read this before modifying the code. It is the single source of truth for
module boundaries, the IPC contract between processes, the data model, and the
security posture. Keeping it in sync with the code is part of the definition of
"done" for any change.

## 1. Process model

Electron gives you two process types and MeetingScribe uses the boundary
deliberately, not incidentally:

```
┌─────────────────────────────┐        IPC (contextBridge)        ┌──────────────────────────────┐
│           Main process        │ <───────────────────────────────> │        Renderer process        │
│  (Node.js — full OS access)  │                                    │  (Chromium — no Node access)  │
│                               │                                    │                               │
│  main.js         orchestrator│                                    │  index.html                   │
│  security.js     hardening   │                                    │  renderer.js   bootstrap       │
│  logger.js       logging     │                                    │  state.js      app state       │
│  storage.js      SQLite DB   │                                    │  audio.js      capture/mixing  │
│  settingsStore.js settings   │                                    │  recording.js  record lifecycle│
│  modelDetection.js AI probes │                                    │  transcription.js  (+providers)│
│  backup.js       backup/restore│                                  │  speakers.js   diarization UI  │
│  summaryEngine.js LLM/heuristic│                                  │  editor.js     rich text editor│
│  exportEngine.js  file writers│                                   │  summary.js    summary UI       │
│  shortcuts.js    global hotkeys│                                  │  library.js    meeting library │
│  ipcHandlers.js  wiring       │                                   │  search.js     search UI        │
│  preload.js      contextBridge│                                   │  timeline.js   waveform/markers │
└─────────────────────────────┘                                    │  playback.js   audio playback   │
                                                                     │  export.js     export UI        │
                                                                     │  settings.js   settings UI      │
                                                                     │  utils.js      shared helpers   │
                                                                     └──────────────────────────────┘
```

**Rule:** only the main process touches `fs`, `child_process`, `net`/`http`, or
`better-sqlite3`. The renderer never does. This is not stylistic — it is the
mechanism that makes the "no network requests, no telemetry" promise
*enforceable* rather than just a policy statement. `security.js` installs a
`session.webRequest.onBeforeRequest` handler that denies every request except
`file://`, `devtools://`, and loopback calls to a small allow-list of
127.0.0.1 ports used to talk to a locally-running Ollama/llama.cpp daemon. See
§7 for details. Because the renderer has `nodeIntegration: false`,
`contextIsolation: true`, and no direct `ipcRenderer` access (only the curated
surface in `preload.js`), a bug or a compromised third-party script pasted
into the transcript editor cannot open a socket, read a file outside the
sandbox, or shell out to a process.

## 2. Why vanilla JS instead of a framework

The brief asked for vanilla JS "unless absolutely necessary," and nothing in
this application needs a virtual DOM or a component compiler:

- The UI is a single long-lived window with a handful of stable views (Library,
  Meeting, Recording, Settings) rather than a large tree of interchangeable
  components — a hand-rolled view controller per screen is simpler to reason
  about than framework state management here.
- `state.js` implements a minimal pub/sub store (subscribe/emit) that is
  enough to keep the Library list, the transcript view, and the recording
  toolbar in sync without a reactive framework.
- Avoiding a bundler/framework keeps the dependency surface (and therefore the
  audit surface, for a "privacy-first" app) as small as possible: the only
  runtime dependencies are `better-sqlite3`, `docx`, `archiver`, and
  `extract-zip` (backup restore).

## 3. Data model (SQLite via better-sqlite3)

better-sqlite3 was chosen over a JSON-file datastore because the brief
explicitly requires scaling to **thousands of meetings and hundreds of hours
of recordings with low memory use** — that is a full-text-search and
indexed-query problem, not a "load the whole file into memory" problem.
better-sqlite3 is synchronous (simpler correctness reasoning, no race
conditions between reads/writes), ships prebuilt binaries for the common
desktop targets, and its native module is rebuilt for Electron's ABI via
`@electron/rebuild` in the `postinstall` script.

Schema (created and migrated in `storage.js`, see `MIGRATIONS` array):

| Table                | Purpose |
|----------------------|---------|
| `meetings`           | One row per meeting: title, timestamps, duration, status, recording path/format/quality, archived flag, and **cache columns** (`transcript_cache`, `tags_cache`, `speakers_cache`, `summary_cache`) that are kept in sync by application code so full-text search never has to join across tables. |
| `speakers`           | Per-meeting speaker rows: label (`Speaker 1`), display name, colour, cumulative speaking time. |
| `transcript_segments`| One row per utterance: start/end ms, speaker id, text, confidence, paragraph-break flag, edited flag, sequence number. Indexed on `(meeting_id, sequence)` and `(meeting_id, start_ms)`. |
| `tags` / `meeting_tags` | Many-to-many tagging. |
| `bookmarks`          | Timestamped markers within a meeting. |
| `comments`           | Threaded comments anchored to a segment (or to the meeting generally). |
| `transcript_versions`| Gzip-compressed full snapshots of the segment array (see §3.1) plus a note and timestamp, for version history / undo-across-sessions. |
| `summaries`          | One row per meeting: structured summary sections, generation source (`llm` or `heuristic`), model name. |
| `recording_sessions` | Crash-recovery bookkeeping: session status, last chunk index, last heartbeat, chunk directory. |
| `meetings_fts`       | An FTS5 virtual table synced from `meetings` via `AFTER INSERT/UPDATE` triggers, indexing title, transcript, tags, speakers and summary text for the search module. |

### 3.1 Why gzip snapshots instead of a diff engine for version history

A "proper" version history would store diffs and replay them. For a
meeting-transcript editor, the failure mode of a buggy diff-replay engine is
silently corrupted history, which is worse than the cost of a slightly larger
database. Each version snapshot is the full segment array serialized to JSON
and compressed with Node's built-in `zlib.gzipSync` (typically 5-10x smaller
for natural-language text) before being stored as a `BLOB`. Restoring a
version is a single `gunzipSync` + `JSON.parse` — no replay logic, no
accumulated-diff bugs. If profiling on real-world usage shows this is too
large for extremely long meetings, the column is isolated enough to swap for
a diff-based scheme later without touching any other table.

## 4. The transcription provider pattern

`transcription.js` (renderer) defines the engine-agnostic contract and never
changes its UI regardless of which engine answers it. Each concrete provider
implements the same interface (`js/transcription/providerBase.js`):

```js
class TranscriptionProvider {
  async isAvailable() { }                 // capability probe
  async start(meetingId, options) { }     // begin a transcription session
  async submitAudioChunk(chunk) { }       // { pcmWav: ArrayBuffer, startMs, endMs }
  async stop() { }
  // Emits 'segment' events via a shared EventTarget: { text, startMs, endMs,
  // confidence, speakerHint, isFinal }
}
```

Providers, in priority order (`transcriptionManager.js` probes them in this
order at startup and whenever the user forces a re-probe from Settings):

1. **`whisperCpp.js`** — spawns the user's local `whisper-cli` binary (from
   [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)) via
   `child_process.execFile` **in the main process** (`ipcHandlers.js` exposes
   `transcription:runWhisperCpp`) against a short WAV chunk written to a temp
   directory, parses the bracketed `[hh:mm:ss.mmm --> hh:mm:ss.mmm] text`
   stdout format (stable across whisper.cpp releases) with a fallback JSON
   parser for `--output-json`, and — if the configured model is a
   `tinydiarize` (`-tdrz`) build — treats emitted `[SPEAKER_TURN]` markers as
   speaker-change hints.
2. **`fasterWhisper.js`** — spawns a bundled helper script
   (`scripts/faster_whisper_bridge.py`, included in `docs/MODEL_SETUP.md`)
   with the user's Python interpreter, reads newline-delimited JSON segments
   from stdout.
3. **`whisperWasm.js`** — runs entirely inside a Web Worker in the renderer
   using a locally-supplied `whisper.wasm` build (see §8, this is the one
   engine that requires no separate OS process). No audio ever leaves the
   worker's memory.
4. **`webSpeech.js`** — wraps the browser's `SpeechRecognition`. **This engine
   is disabled by default and requires an explicit opt-in**, because
   Chromium's implementation streams audio to Google's servers for
   recognition. It is included only as a last-resort convenience fallback for
   users who knowingly accept that trade-off; enabling it is a deliberate
   exception to the "no cloud" rule and the UI labels it as such at every
   point it can be enabled. See §9 for the full disclosure.

The UI (`transcription.js`) only ever consumes `segment` events and a
`currentEngineName` property — it has no branches per engine.

## 5. Speaker identification

There is no bundled neural diarization model (that would require shipping a
multi-hundred-MB embedding model, which is out of scope for a source
deliverable — see §8). Speaker turns are produced by, in priority order:

1. whisper.cpp `tinydiarize` markers, if the configured model supports `-tdrz`.
2. A pause-based heuristic in `audio.js`: a voice-activity detector (RMS
   energy over a sliding window via `AnalyserNode`) marks a candidate speaker
   boundary whenever a silence gap exceeds a configurable threshold
   (default 700 ms) *and* the two neighbouring chunks differ in average pitch
   proxy (zero-crossing rate) beyond a threshold — a deliberately simple,
   fully offline heuristic, not a claim of real diarization accuracy.
3. Manual reassignment in the editor always overrides both of the above and is
   the label persisted to `transcript_segments.speaker_id`.

`speakers.js` renders detected boundaries as `Speaker 1..N`, lets the user
rename/recolour/merge speakers, and computes speaking-time statistics
directly from `SUM(end_ms - start_ms) GROUP BY speaker_id`. The architecture
document explicitly does **not** claim voice-print-based re-identification
across meetings — that is a real capability gap versus a cloud product like
Otter.ai, and a natural extension point if a local embedding model (e.g. a
small ONNX speaker-embedding model run via `onnxruntime-node`) is added later.

## 6. Summarization

`main/summaryEngine.js` implements:

- **Local LLM path** — if `modelDetection.js` finds a running Ollama daemon
  (`GET http://127.0.0.1:11434/api/tags`) or a llama.cpp server
  (`GET http://127.0.0.1:8080/health` or configured port), the meeting
  transcript is chunked to fit the model's context window and sent through a
  structured prompt requesting the sections listed in the brief (executive
  summary, overview, topics, decisions, risks, questions, action items with
  owners/deadlines, follow-ups, open issues) as JSON. The response is
  validated against an expected-keys schema before being persisted; if
  validation fails, MeetingScribe falls back to the heuristic summarizer
  rather than showing malformed output.
- **Heuristic path** (always available, zero dependencies) —
  `main/heuristicSummarizer.js` implements a real extractive summarizer:
  TF‑IDF vectors per sentence, a TextRank-style graph centrality ranking
  (cosine similarity between sentence vectors as edge weights, power
  iteration to convergence) to select the executive summary and overview
  sentences, a curated action-verb/modal regex (`\b(will|should|need(s)? to|
  must|going to|action:|todo:)\b` etc.) plus a naive owner grammar
  (`<Name>, can you...` / `<Name> will...`) to extract action items, `?`-
  terminated sentences plus interrogative-start detection for "Questions
  Raised," and a simple k-means-over-TF-IDF clustering (k chosen by a
  silhouette-adjacent heuristic capped at 8) for "Discussion Topics." This is
  genuinely useful, deterministic, and fast — but it is explicitly a
  heuristic, not an LLM, and the UI labels summaries with their source.

Both paths only ever run against transcript text already on disk; no network
call other than the loopback call described above is made.

## 7. Security model (`security.js`)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on the
  `BrowserWindow`, and a strict `Content-Security-Policy` header injected on
  every response (`default-src 'self'; script-src 'self'; connect-src 'self'
  http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:;
  media-src 'self' blob:; object-src 'none'`).
- `session.defaultSession.webRequest.onBeforeRequest` denies any request whose
  destination is not `file://`, `devtools:`, or `127.0.0.1`/`localhost` on a
  small allow-listed set of ports (the ones the user configured for
  Ollama/llama.cpp in Settings). This means even a bug that tried to phone
  home would be blocked at the network layer, not just by convention.
- `will-navigate` and `setWindowOpenHandler` deny anything that is not the
  app's own `file://` origin — no accidental external navigation, no popups.
- `app.setAppUserModelId` / disabling the default `Autofill`/`Spellcheck`
  networked dictionary downloads (Chromium normally fetches a spellcheck
  dictionary from Google — this is explicitly disabled).
- No crash reporter, no update-checker, no analytics library is present
  anywhere in `package.json` or the codebase.

## 8. What ships "batteries included" versus what requires a one-time local setup

Being precise about this distinction matters for a privacy/offline product,
and it is a direct constraint of delivering source code rather than a
multi-gigabyte installer:

**Works immediately after `npm install && npm run start`, no extra setup:**
recording (mic / system-audio loopback / mixed), the meeting library, the
transcript editor, bookmarks/comments/tags/version history, the heuristic
summarizer, search, TXT/Markdown/CSV/JSON/HTML/PDF export (PDF uses
Electron's built-in `webContents.printToPDF`, no external dependency), DOCX
export (via the bundled `docx` npm package), settings, backup/restore, global
shortcuts.

**Requires a one-time local install the user performs themselves (fully
offline once downloaded/built — MeetingScribe never fetches these at
runtime):**
- High-accuracy live transcription needs **one** of: a compiled whisper.cpp
  `whisper-cli` binary + a `ggml` model file, a Python environment with
  `faster-whisper` installed, or a locally-built `whisper.wasm` bundle. Full,
  copy-pasteable setup steps are in `docs/MODEL_SETUP.md`.
- LLM-generated summaries (as opposed to the heuristic summarizer) need a
  locally running Ollama or llama.cpp server with a model such as Mistral,
  Gemma, or Llama pulled — also documented in `docs/MODEL_SETUP.md`.

MeetingScribe **auto-detects** whichever of these the user has installed
(`modelDetection.js`) and exposes the result in Settings → AI Engines; nothing
needs to be recompiled or reconfigured in the app itself when a new engine
becomes available on the machine.

## 9. Web Speech API — explicit disclosure

The brief lists "Web Speech API" as priority 4 in the transcription fallback
chain, and it is implemented for completeness, but it is important to be
direct about a real conflict with the rest of the brief: **Chromium's
`SpeechRecognition` implementation is a cloud API** — audio is streamed to
Google's servers for recognition, there is no local/offline mode. This is
not a MeetingScribe limitation, it is how the browser feature works.
Consequently:

- It is **off by default**.
- Enabling it in Settings requires checking an explicit
  "I understand this sends audio to Google's servers" acknowledgement.
- Whenever it is the active engine, a persistent, non-dismissable banner is
  shown in the recording view.
- `security.js`'s network allow-list does **not** special-case Google's speech
  endpoints — enabling this feature is the one deliberate, disclosed
  exception to the offline guarantee, and the CSP change required to allow it
  is scoped and commented in code as exactly that.

If strict 100%-offline operation is a hard requirement for your deployment,
do not enable this provider; whisper.cpp/faster-whisper/whisper.wasm cover the
same need without leaving the machine.

## 10. Known platform limitations (not bugs)

- **System-audio loopback captures the whole OS audio mix, not a single
  selected tab.** Electron's `desktopCapturer` only exposes `screen` and
  `window` source types (there is no Chrome-style per-tab audio capture
  surface in Electron). When `audio: 'loopback'` is requested from
  `setDisplayMediaRequestHandler`, the OS hands back whatever is currently
  playing system-wide. In practice this is rarely a problem for meeting
  capture (usually only the meeting app is producing sound), but if the user
  has multiple audio sources playing, all of them will be mixed in. This is
  documented in-app on the source-picker screen, not hidden.
- macOS requires the user to grant "Screen & System Audio Recording"
  permission once, from System Settings, before loopback audio works — this
  is an OS permission dialog, not something the app can pre-approve.
- Global shortcuts registered via Electron's `globalShortcut` module are
  process-wide on the OS and will fail to register (silently, per Electron's
  own API contract) if another application already owns the same accelerator;
  `shortcuts.js` surfaces this as a Settings-panel warning rather than failing
  silently to the user.

## 11. Extending the app

- **New transcription engine:** add a file under
  `src/renderer/js/transcription/` implementing `providerBase.js`'s
  interface, register it in `transcriptionManager.js`'s `PROVIDER_CHAIN`
  array, add a detection probe in `modelDetection.js`. No other file needs to
  change — this is the point of the provider pattern.
- **New summarizer backend (e.g. a different local LLM runtime):** add a
  detector + a request builder in `main/summaryEngine.js`'s `ENGINES` map.
- **New export format:** add a module under `main/exporters/` and register it
  in `exportEngine.js`'s `FORMATS` map; `export.js` (renderer) reads the map
  through IPC to build its format picker, so no renderer change is required
  either.

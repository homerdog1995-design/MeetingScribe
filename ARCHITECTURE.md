# MeetingScribe — Architecture Reference

**This app was converted from an Electron desktop application to a
browser-only Progressive Web App.** If you're looking at this after having
seen an earlier version of this document: every section below has been
rewritten to describe the actual current architecture, not patched. The
biggest changes, up front:

- One JavaScript context now, not two. There is no more main process /
  renderer process split, no IPC, no `preload.js`.
- SQLite (`better-sqlite3`) is gone. All data lives in IndexedDB.
- whisper.cpp and faster-whisper are gone. Neither can run in a browser
  under any circumstances (both require spawning a native binary). Whisper
  WASM is now the primary offline transcription engine.
- There is no filesystem. Recordings are Blobs in IndexedDB; exports are
  browser downloads; backups are a single JSON file.
- The app is installable (via `manifest.json`) and works offline (via
  `service-worker.js`) — both new concepts that an Electron app never
  needed.

## 1. Process model

A single browser tab, running plain ES modules loaded by
`<script type="module" src="js/renderer.js">` — no bundler, no build step.
`js/renderer.js` is the bootstrap: it initializes every other module
(`recording.js`, `editor.js`, `library.js`, etc.) and owns view routing
(switching between the Library, a specific meeting's workspace, and
Settings).

Every module talks to every other module through direct JavaScript
imports — there is no IPC layer to cross, because there is no second
process. `storage.js` (IndexedDB), `settingsStore.js`, and `backup.js` are
called directly, in-process, by whichever UI module needs them.

A **Web Worker** (`js/transcription/whisperWasmWorker.js`) is the one
exception to "single context" — Whisper WASM inference runs there so a
transcription pass never blocks the UI thread. It communicates with the
main thread via `postMessage`, not IPC.

A **Service Worker** (`service-worker.js`) is the other background context.
It only handles caching static assets for offline use; it has no access to
IndexedDB and plays no role in the app's actual logic.

## 2. Why vanilla JS instead of a framework

Unchanged reasoning from the original desktop version: a framework's
runtime and build tooling add a dependency surface this app doesn't need.
That reasoning applies even more strongly now — there is deliberately no
build step at all (no bundler, no transpiler), since adding one would
introduce exactly the tooling dependency the "no build step" requirement is
meant to avoid, and would complicate the "just open index.html" simplicity
that makes a static-file PWA easy to audit and self-host.

## 3. Data model (IndexedDB via `storage.js` + `db.js`)

`db.js` defines one IndexedDB database (`meetingscribe`) with these object
stores: `meetings`, `speakers`, `segments`, `bookmarks`, `comments`, `tags`,
`meeting_tags`, `summaries`, `transcript_versions`, `recordings`,
`recording_chunks`, `recording_sessions`, `settings`. `storage.js` is the
only module that touches these directly; it exposes the same function
names/signatures the UI modules already expected from the old IPC contract
(`createMeeting`, `getMeeting`, `listMeetings`, `addTranscriptSegments`,
etc.), so editor.js/library.js/etc. needed minimal changes beyond swapping
`window.api.storage.X()` for `storage.X()`.

**Recordings are Blobs.** The `recordings` store holds the actual audio
data directly — IndexedDB supports Blobs natively, unlike localStorage
(string-only, ~5MB cap). A meeting's `recording_path` field is kept (for
interface compatibility) but no longer holds a filesystem path — it holds
the id of a row in `recordings`. `storage.getRecordingUrl(meeting)` turns
that into a playable `URL.createObjectURL()` reference.

**No full-text search engine.** SQLite's FTS5 has no browser equivalent.
Each meeting record instead carries a denormalized `search_text` field
(title + transcript + speaker names + tags + summary), rebuilt whenever any
of those change, and `listMeetings({search})` does a plain substring scan
over it. This is a real trade-off versus FTS5 — fine at a few thousand
meetings, but it won't scale as gracefully into the tens of thousands
without a proper index.

## 4. The transcription provider pattern

Unchanged in spirit: every engine implements the same interface
(`js/transcription/providerBase.js` — `isAvailable()`, `start()`,
`submitAudioChunk()`, `stop()`, plus `segment`/`error` events), and
`transcription.js` probes them in priority order so the UI never needs to
know which one is active.

**What changed:** the provider chain used to be
`[whisper.cpp, faster-whisper, Whisper WASM, Web Speech API]`. The first two
are gone — both require spawning a native binary/subprocess, which no
browser permits under any circumstances, for any app, ever. The chain is
now:

```
[Whisper WASM, Web Speech API]
```

Whisper WASM (`whisperWasm.js`) runs whisper.cpp compiled to WebAssembly,
entirely inside a Worker, entirely offline. It requires a one-time asset
setup (see `docs/MODEL_SETUP.md`) — three files under `assets/whisper-wasm/`:
`whisper.js` (Emscripten glue), `whisper.wasm` (compiled binary), and
`ggml-model.bin` (the model weights, a **fixed filename now** — the old
version could scan a directory for any `ggml-*.bin` file; browsers cannot
list directory contents at all, so there's no way to "discover" an
arbitrary filename anymore).

Web Speech API remains the last-resort, explicitly-disclosed, non-offline
fallback (see §9).

## 5. Speaker identification

Unchanged: no real acoustic diarization (no voice embedding/clustering).
Speakers are auto-created in a round-robin pool (capped at 4) whenever a
turn is detected, using an engine-provided `speakerTurn` flag if available
or a silence-gap heuristic otherwise (`editor.js`'s `handleLiveSegment`).
Manual reassignment, renaming, recoloring, and speaking-time stats are all
unchanged from the desktop version.

## 6. Summarization

Unchanged in spirit: try a local LLM server first (Ollama or llama.cpp),
fall back to the pure-JS heuristic summarizer
(`heuristicSummarizer.js` — word-frequency scoring, keyword clustering, and
pattern matching for decisions/risks/questions/action items) if neither is
reachable.

**A real new limitation:** the old code ran in the Electron main process,
where Node's HTTP client has no concept of CORS — it could always reach
`http://127.0.0.1:11434` (Ollama) or `:8080` (llama.cpp). A browser page's
`fetch()` to those same local ports **is** subject to CORS, and neither
server allows arbitrary origins by default. Ollama needs `OLLAMA_ORIGINS`
set to this app's exact origin; llama.cpp's server needs `--cors` (or
equivalent). If neither is configured, detection reports "not available"
and the app falls back to the heuristic summarizer automatically — this
degrades gracefully rather than failing outright, but it's a genuine new
hurdle that didn't exist in the desktop version. See `summaryEngine.js`'s
file header and `docs/MODEL_SETUP.md`.

## 7. Security model

There is no Electron `webRequest`/CSP-injection layer anymore — that
existed to lock down what a Chromium `BrowserWindow` could do. A regular
browser tab already runs under the browser's own security model
(same-origin policy, permission prompts for mic/screen capture, sandboxed
JavaScript with no filesystem or process-spawning access by default). This
app doesn't add anything on top of that, because there's no privileged
process left to lock down — the browser itself is the sandbox boundary.

The one place this app talks to the network at all is the optional local
LLM check (§6) and the optional Web Speech API (§9) — both off unless the
user opts in, and both restricted to `127.0.0.1`/Google's speech API
respectively; there is no other outbound request anywhere in the codebase.

## 8. What ships "batteries included" versus what requires a one-time local setup

Works immediately, no setup: recording (mic/system/mixed, subject to §10's
browser capture caveats), the meeting library, transcript editor (undo/redo,
find/replace, highlights, comments, bookmarks, version history, autosave),
speaker management, search, all 7 export formats, backups (single JSON
file), and the heuristic (non-LLM) summarizer.

Requires one-time setup (see `docs/MODEL_SETUP.md`): Whisper WASM (build/
place 3 files), Ollama or llama.cpp for LLM summaries (plus the CORS
configuration from §6).

## 9. Web Speech API — explicit disclosure

Unchanged from the desktop version: this is the one deliberate exception to
"everything offline." It sends microphone audio to Google's servers. Off by
default; enabling it requires an explicit in-app disclosure acknowledgement
(`settings.js`'s `handleWebSpeechToggle`); a banner stays visible for the
entire session whenever it's active. Its platform limitation is unchanged
too: the standard `SpeechRecognition` API has no way to accept a custom
`MediaStream`, so it only meaningfully supports microphone-mode recording.

## 10. Known platform limitations (not bugs)

- **System-audio capture is narrower than the desktop version.** Electron
  could capture the whole OS audio mix via `desktopCapturer` +
  `setDisplayMediaRequestHandler`. A browser's `getDisplayMedia()` shows its
  own native screen/window/tab picker with no way to bypass it, and whether
  audio actually comes through depends heavily on browser/OS: Chrome
  reliably captures audio from a shared *browser tab*; whole-screen/window
  audio capture works on Windows/ChromeOS but is generally unavailable on
  macOS. `recording.js` surfaces this as an in-app note rather than
  pretending it always works.
- **Hotkeys only work while the tab is focused.** Electron's
  `globalShortcut` fired even when the app was in the background — that's
  what "global" meant, and no browser can replicate it (a page receiving
  keystrokes meant for other windows would be a serious security hole). See
  `hotkeys.js`.
- **Whisper WASM is sensitive to the exact build you supply.** whisper.cpp's
  exported JS function shapes have changed across releases; the worker
  defensively handles the two shapes the maintainers have shipped, but a
  very different build may need small adjustments — see the file header
  comments in `whisperWasmWorker.js`.
- **PDF export opens the browser's print dialog** instead of silently
  writing a file — there is no browser equivalent of Electron's
  `webContents.printToPDF`. The user picks "Save as PDF" as the print
  destination themselves.
- **DOCX export became RTF.** Building a real `.docx` needs either a
  bundler or the `docx` npm package loaded from a CDN; neither fits a
  no-build-step, fully-offline app. RTF is a plain-text format Word/Google
  Docs/LibreOffice all open natively and needs zero dependencies to
  generate.
- **No true full-text search index** — see §3.

## 11. Extending the app

The module boundaries are unchanged from the desktop version and still the
right place to hang new functionality: a new transcription engine
implements `providerBase.js`'s interface and gets added to
`transcription.js`'s `PROVIDER_CHAIN`; a new export format gets a file
under `js/exporters/` and an entry in `exportEngine.js`'s `FORMATS`/
`BUILDERS`; a new settings field goes in `settingsStore.js`'s
`DEFAULT_SETTINGS` plus a UI control wired in `settings.js`.

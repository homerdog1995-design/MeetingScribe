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
  under any circumstances (both require spawning a native binary). The
  primary offline transcription engine is now Sherpa-ONNX ASR (replacing an
  earlier, since-removed Whisper WASM integration that crashed reliably on
  real device testing — see §4).
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

**Web Workers** are the one exception to "single context" —
`js/transcription/sherpaAsrWorker.js` (speech recognition) and
`js/diarizationWorker.js` (speaker diarization) each run their WASM engine
in a dedicated worker so neither ever blocks the UI thread. They
communicate with the main thread via `postMessage`, not IPC.

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

Every engine implements the same interface (`js/transcription/
providerBase.js` — `isAvailable()`, `start()`, `submitAudioChunk()`,
`stop()`, plus `segment`/`error` events), and `transcription.js` probes
them in priority order so the UI never needs to know which one is active.

**What changed:** the provider chain used to be
`[whisper.cpp, faster-whisper, Whisper WASM, Web Speech API]`. The first two
are gone — both require spawning a native binary/subprocess, which no
browser permits under any circumstances, for any app, ever. Whisper WASM
(a third-party WebAssembly build, `@timur00kh/whisper.wasm`) was also
removed entirely after real device testing confirmed it crashed reliably
and immediately, on every model size tried, even after ruling out chunk
length and thread count as the cause one by one with real evidence — not
a configuration problem on this app's side, but a deeper incompatibility
with that specific compiled binary. The chain is now:

```
[Sherpa-ONNX ASR, Web Speech API]
```

**Whisper via sherpa-onnx** (`transcription/sherpaAsr.js` /
`transcription/sherpaAsrWorker.js`) runs OpenAI's Whisper (tiny.en),
gated by Silero VAD, from sherpa-onnx's official prebuilt WASM package
(Apache-2.0, `assets/speech-recognition/`) — the same toolkit as the
speaker-diarization feature (§12).

**This replaced an earlier streaming Zipformer model** (same toolkit,
different model) after real-world testing showed roughly 30% word
accuracy, ALL-CAPS output, and hallucinated filler words during silence.
Those weren't tuning problems — they were consequences of the model class.
A *streaming* model must commit to words having heard a fraction of a
second of context; Whisper is *offline/non-streaming*, seeing a whole
utterance before deciding anything, and produces natural casing and
punctuation itself (the streaming checkpoint had been trained on
casing-stripped text and could never produce either).

**VAD is what makes the offline model practical for live use.** Silero
VAD segments real speech acoustically, and only complete speech segments
ever reach Whisper. This app no longer guesses where utterances begin and
end at all. It also means silence never reaches the model — addressing
hallucination-during-silence at the source rather than filtering model
output afterward (an earlier RMS-based guard, now removed as redundant).

**The trade-off, stated plainly:** text appears once a phrase *finishes*
rather than word-by-word as it's spoken. For meeting notes that's
generally the better trade, but it is a real behavioural change from the
streaming model.

Timestamps are reconstructed per segment by working backwards from the
current stream position using each VAD segment's own duration — the VAD
only surfaces a segment once it has ended, so "it ended around now and
lasted this long" is the accurate reading. Much better than the streaming
model's approximation, though still not sample-exact.

No setup is needed — engine and model are committed directly into this
repo (split into <100MB parts and reassembled via same-origin `fetch()`
at load time, since the ~104MB bundle exceeds GitHub's per-file push
limit and its release-asset host doesn't send CORS headers — see
`sherpaAsrWorker.js`'s file header). On by default; Settings → AI Engines
can turn it off, and it disables itself after repeated failures.

Web Speech API remains the last-resort, explicitly-disclosed, non-offline
fallback (see §9) — and, per real device testing, has a genuine
architectural limitation of its own: it can't reliably share a microphone
with this app's own recording pipeline (see §9's transcript-only mode
note), whereas Sherpa ASR never has that problem, since it processes
audio through the same stream this app already captures.

**Swapping in a different engine later requires no UI or storage
changes.** Every engine-specific limitation is a property the provider
declares about itself — `needsExclusiveMicrophone`, `hasApproximateTimestamps`,
`requiresPrivacyDisclosure` (all on `providerBase.js`, all defaulting to
`false`) — rather than other modules checking engine names or labels
directly. `recording.js` decides whether a recording needs transcript-only
mode by reading `needsExclusiveMicrophone` off whichever engine
`detectAvailableEngine()` returns, never by string-matching a label.
`editor.js` widens its speaker-turn heuristic by reading
`hasApproximateTimestamps`, the same way. A new engine that implements
`providerBase.js`'s interface and is added to `PROVIDER_CHAIN` in
`transcription.js` just works — nothing elsewhere needs to know it exists.

## 5. Speaker identification — two genuinely independent layers

`js/transcriptAssembly.js` is where both live: **`LiveSpeakerRotation`**
(a same-engine-agnostic heuristic — auto-creates up to 2 speakers, then
cycles between them on a silence gap or an engine-provided `speakerTurn`
flag, applied as text arrives during recording) and **`applyDiarization`**
(real acoustic speaker identity from §12's diarization engine, applied as
a separate, later pass over an already-finished recording's saved audio).

These two never call each other or share state — that's deliberate, not
incidental. The live heuristic has no way to know how many people are
actually in a meeting (no ASR engine here reports real speaker identity),
so it's necessarily a rough placeholder; diarization is the real answer,
and it can only run once the whole recording exists to cluster voices
across. Keeping them as separate functions in one module (rather than
diarization results somehow feeding back into or overriding live state
mid-recording) means each can change independently — a smarter live
heuristic wouldn't need to know anything about how diarization
reconciles its results, and vice versa. `editor.js` and `speakers.js` are
thin UI callers: they hold no assembly logic themselves, just call into
this module and handle rendering/refresh with what comes back.

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
file), the heuristic (non-LLM) summarizer, **Sherpa-ONNX ASR** (the
primary offline transcription engine — real built-in endpoint detection,
nothing to set up, on by default; see §4), and **true acoustic speaker
diarization** (a vendored sherpa-onnx WebAssembly build — pyannote speech
segmentation + a speaker-embedding network, clustered on-device; see §12).

Only local LLM summaries need any setup at all (see `docs/MODEL_SETUP.md`):
Ollama or llama.cpp (plus the CORS configuration from §6). Everything
else — including both on-device AI engines — works with zero setup, since
their models are committed directly into this repo rather than requiring
a per-user download.

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
- **Sherpa ASR's model is a real, sizable download** (~191MB, split into
  parts — see §4), fetched lazily the first time a recording actually
  starts (not on page load — same deliberate lazy-loading choice as the
  diarization assets, so visiting the app doesn't force a huge download
  before anyone's used a feature that needs it) and cached by the service
  worker afterward for offline reuse.
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
implements `providerBase.js`'s interface (including its capability flags —
`needsExclusiveMicrophone`, `hasApproximateTimestamps`,
`requiresPrivacyDisclosure` — for any real limitation it has) and gets
added to `transcription.js`'s `PROVIDER_CHAIN`; a new export format gets a
file under `js/exporters/` and an entry in `exportEngine.js`'s `FORMATS`/
`BUILDERS`; a new settings field goes in `settingsStore.js`'s
`DEFAULT_SETTINGS` plus a UI control wired in `settings.js`.

## 12. Speaker diarization (`diarization.js` / `diarizationWorker.js`)

Unlike everything else in this app, this pipeline runs a *second*,
independent WebAssembly engine — a vendored build of
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0), which
bundles a pyannote speech-segmentation model and a speaker-embedding
network directly in its `.data` package (`assets/speaker-diarization/`,
~56MB). It has nothing to do with the ASR engine (§4) — it doesn't
transcribe anything, and results only ever get applied through
`transcriptAssembly.js`'s `applyDiarization()` (§5), never coupled
directly into live transcription. It only answers "who was probably
talking, and when," by extracting a voice-characteristic embedding for
each detected speech segment and clustering those embeddings — the same
category of technique real diarization products use, running entirely
on-device.

**Why this is a batch, not a live, feature:** clustering needs embeddings
from across the whole conversation to group speakers correctly — there's
no meaningful way to do this incrementally in real time. So it runs as an
on-demand "Detect speakers" pass (`speakers.js`) over a *finished*
recording, not a live indicator during recording. It also means it's only
available for meetings with actual saved audio — Web Speech's
transcript-only mode (§ recording.js's file header) never saves audio, so
there's nothing for this pipeline to analyze in that case.

**Why it doesn't need any user setup, unlike Whisper WASM:** the required
model/wasm files are committed directly into this repo (fetched from
sherpa-onnx's official GitHub release, redistributed under its Apache-2.0
license), rather than requiring a per-deployment manual download the way
Whisper WASM's assets do. They're deliberately *not* in the service
worker's precache list, though — at ~56MB, forcing that download on every
first visit regardless of whether the feature is ever used would be a poor
default. It downloads lazily (and gets cached automatically for offline
reuse afterward) the first time "Detect speakers" is actually clicked.

**How results get applied:** the clustering output is a list of
`{startMs, endMs, speaker}` turns (speaker is a 0-indexed cluster id, not
an identity — it has no idea whose voice it is, only that voices A and B
sound different). `speakers.js` creates one speaker record per cluster,
then reassigns every existing transcript segment to whichever turn overlaps
it the most (falling back to nearest-by-time for a segment that falls
entirely in a gap between turns), and removes whatever speakers are left
unused afterward — typically the old heuristic round-robin speakers this
replaces.

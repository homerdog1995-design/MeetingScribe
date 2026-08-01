'use strict';

import { store } from './state.js';
import { storage } from './storage.js';
import { AudioEngine } from './audio.js';
import { transcriptionManager } from './transcription.js';
import { bindConfigurableHotkey } from './hotkeys.js';
import { qs, qsa, el, formatTimestamp, showToast, openModal } from './utils.js';

/**
 * CHANGES FROM THE ELECTRON VERSION:
 *  - No more window.api.recording.* IPC — every call goes straight to
 *    storage.js (IndexedDB) in this same process, since there's only one
 *    process now.
 *  - No more custom source-picker modal. Electron let this app build its own
 *    thumbnail grid from desktopCapturer.getSources() and silently
 *    pre-approve a choice; a real browser always shows its own native
 *    getDisplayMedia() picker and there is no way to bypass or replace it,
 *    so audioEngine.start() now triggers that picker directly (see audio.js).
 *  - Crash recovery is now pull-based: there's no separate main process to
 *    detect "the app relaunched after a crash" and push an event — instead,
 *    this page checks IndexedDB for unfinished sessions itself on load.
 *  - Hotkeys are now in-page (via hotkeys.js) rather than OS-global, so they
 *    only work while this tab is focused — see hotkeys.js for why that's an
 *    unavoidable browser limitation, not an oversight.
 *
 * TRANSCRIPT-ONLY MODE (Web Speech + microphone): confirmed via real device
 * testing that this app's own getUserMedia stream (needed to actually save
 * a recording) and Web Speech's separate, concurrent recognition session
 * can't reliably share a single physical microphone on Android — Web
 * Speech's session opens successfully but never receives real audio.
 * Adjusting audio constraints didn't resolve it. The only reliable fix is
 * architectural: when Web Speech is the active engine in microphone mode,
 * this app's own audio capture is skipped entirely, so Web Speech is the
 * *only* consumer of the microphone. The trade-off is explicit and
 * disclosed in the UI: no audio is recorded/saved for that meeting — only
 * the live transcript. See startTranscriptOnlyRecording() below.
 */

const QUALITY_BITRATES = { low: 32000, standard: 96000, high: 192000 };
const WEB_SPEECH_LABEL = 'Web Speech API (online, not private)';

let audioEngine = null;
let timerHandle = null;
let lastMasterChunkIndex = -1;
let currentSessionId = null;
let currentMeetingId = null;
let recordingStartPerfMs = 0;
let pausedAccumulatedMs = 0;
let pausedAtPerfMs = 0;
let transcriptOnlyMode = false;

function els() {
  return {
    modeButtons: qsa('.mode-btn'),
    levelMic: qs('#level-meter-mic'),
    levelSystem: qs('#level-meter-system'),
    statusDot: qs('#recording-status-dot'),
    statusText: qs('#recording-status-text'),
    timer: qs('#recording-timer'),
    quality: qs('#quality-select'),
    btnRecord: qs('#btn-record'),
    btnPause: qs('#btn-pause'),
    btnResume: qs('#btn-resume'),
    btnStop: qs('#btn-stop'),
    btnBookmark: qs('#btn-bookmark-live'),
    sourceBanner: qs('#source-picker-banner'),
    webSpeechBanner: qs('#web-speech-banner'),
    noEngineBanner: qs('#no-engine-banner'),
  };
}

function currentMode() {
  return qs('.mode-btn.active')?.dataset.mode || 'microphone';
}

function setMode(mode) {
  qsa('.mode-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
}

function isModeSupported(mode) {
  if (mode === 'system' || mode === 'mixed') return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  return true;
}

/** Mobile browsers (Android Chrome, iOS Safari) don't implement getDisplayMedia() at all — this is a genuine platform gap, not something to silently let the user discover via a crash. */
function disableUnsupportedModes() {
  qsa('.mode-btn').forEach((btn) => {
    if (!isModeSupported(btn.dataset.mode)) {
      btn.disabled = true;
      btn.title = 'Not available on this browser/device — system and tab audio capture requires a desktop browser (Chrome, Edge, or Firefox on Windows/Mac/Linux).';
    }
  });
}

export function initRecording() {
  const e = els();

  disableUnsupportedModes();

  e.modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (store.get('recording.status') !== 'idle') return; // mode is locked once recording starts
      setMode(btn.dataset.mode);
    });
  });

  e.btnRecord.addEventListener('click', () => startRecording());
  e.btnPause.addEventListener('click', () => pauseRecording());
  e.btnResume.addEventListener('click', () => resumeRecording());
  e.btnStop.addEventListener('click', () => stopRecording());
  e.btnBookmark.addEventListener('click', () => addLiveBookmark());

  const subscribeSettings = (cb) => { cb(store.get('settings')); store.subscribe('settings', cb); };
  bindConfigurableHotkey(subscribeSettings, (s) => s?.hotkeys?.startRecording, () => {
    if (store.get('recording.status') === 'idle' && store.get('currentView') === 'meeting') startRecording();
  });
  bindConfigurableHotkey(subscribeSettings, (s) => s?.hotkeys?.pauseRecording, () => {
    const status = store.get('recording.status');
    if (status === 'recording') pauseRecording();
    else if (status === 'paused') resumeRecording();
  });
  bindConfigurableHotkey(subscribeSettings, (s) => s?.hotkeys?.stopRecording, () => {
    if (store.get('recording.status') !== 'idle') stopRecording();
  });
  bindConfigurableHotkey(subscribeSettings, (s) => s?.hotkeys?.bookmark, () => {
    if (store.get('recording.status') !== 'idle') addLiveBookmark();
  });

  store.subscribe('currentMeeting', (meeting) => applyMeetingToToolbar(meeting));
  transcriptionManager.addEventListener('engine-changed', ({ detail }) => updateEngineBanners(detail.label));
  transcriptionManager.addEventListener('provider-error', ({ detail }) => showToast(detail.message, 'error'));

  updateToolbarForStatus('idle');
  initCrashRecovery();
}

function applyMeetingToToolbar(meeting) {
  const e = els();
  if (!meeting) return;
  // A meeting is "already done" whether it has a saved recording OR was
  // finished in transcript-only mode (no audio, but status still becomes
  // 'recorded' — see stopRecording()) — either way it shouldn't be
  // re-recorded over.
  const isFinished = Boolean(meeting.recording_path) || meeting.status === 'recorded';
  e.modeButtons.forEach((btn) => { btn.disabled = isFinished || !isModeSupported(btn.dataset.mode); });
  e.quality.disabled = isFinished;
  e.quality.value = meeting.quality || 'standard';
  setMode(meeting.recording_mode || 'microphone');
  e.btnRecord.disabled = isFinished;
  e.btnRecord.textContent = isFinished ? '● Recorded' : '● Record';
  e.statusText.textContent = isFinished ? (meeting.recording_path ? 'Recorded' : 'Transcript only') : 'Ready';
  e.timer.textContent = formatTimestamp(meeting.duration_ms || 0);
  e.sourceBanner.classList.add('hidden');
}

async function startRecording() {
  const meeting = store.get('currentMeeting');
  if (!meeting) return;
  const mode = currentMode();
  const settings = store.get('settings');

  // Detect which engine will actually run *before* deciding how to capture
  // audio at all — this determines whether transcript-only mode applies.
  const detectedEngineLabel = await transcriptionManager.detectAvailableEngine();
  const willUseWebSpeech = detectedEngineLabel === WEB_SPEECH_LABEL;
  transcriptOnlyMode = willUseWebSpeech && mode === 'microphone';

  try {
    if (transcriptOnlyMode) {
      await startTranscriptOnlyRecording(meeting, settings);
    } else {
      await startFullRecording(meeting, mode, settings);
    }
  } catch (error) {
    showToast(`Could not start recording: ${error.message}`, 'error');
    audioEngine = null;
  }
}

async function startFullRecording(meeting, mode, settings) {
  const e = els();
  const quality = e.quality.value;

  const session = await storage.createRecordingSession(meeting.id);
  currentSessionId = session.sessionId;
  currentMeetingId = meeting.id;
  lastMasterChunkIndex = -1;

  // Captured once, here, rather than read from the mutable module-level
  // currentSessionId/currentMeetingId inside the listeners below — those
  // variables get reassigned by whatever recording starts *next*, and a
  // listener reading them live would silently pick up a different
  // recording's session if this engine somehow outlived its own recording
  // (e.g. a stop() that didn't fully tear down in time). Local constants
  // guarantee this listener only ever refers to the session it was made for.
  const sessionIdForThisEngine = session.sessionId;
  const meetingIdForThisEngine = meeting.id;

  audioEngine = new AudioEngine();
  audioEngine.addEventListener('level', ({ detail }) => {
    e.levelMic.style.width = `${Math.round(detail.mic * 100)}%`;
    e.levelSystem.style.width = `${Math.round(detail.system * 100)}%`;
  });
  audioEngine.addEventListener('master-chunk', async ({ detail }) => {
    lastMasterChunkIndex = detail.index;
    try {
      const blob = new Blob([detail.arrayBuffer], { type: 'audio/webm' });
      await storage.saveMasterChunk(sessionIdForThisEngine, meetingIdForThisEngine, detail.index, blob);
    } catch (error) {
      showToast(`Failed to save recording chunk: ${error.message}`, 'error');
    }
  });
  audioEngine.addEventListener('pcm-frame', ({ detail }) => {
    transcriptionManager.submitAudioChunk(detail);
  });

  // For system/mixed mode, this line is what triggers the browser's own
  // native screen/window/tab picker — see audio.js's _captureSystemAudio.
  // If the user cancels that picker, getDisplayMedia() rejects and we land
  // in startRecording()'s catch block like any other start failure.
  await audioEngine.start(mode, {
    audioBitsPerSecond: QUALITY_BITRATES[quality] ?? QUALITY_BITRATES.standard,
  });

  await storage.updateMeeting(meeting.id, {
    status: 'recording', quality, recording_mode: mode, started_at: Date.now(),
  });

  const engineLabel = await transcriptionManager.start(meeting.id, { language: settings?.language || 'en' });
  updateEngineBanners(engineLabel);

  recordingStartPerfMs = performance.now();
  pausedAccumulatedMs = 0;
  store.patch('recording', { status: 'recording', mode, startedAt: Date.now(), sessionId: currentSessionId });
  updateToolbarForStatus('recording');
  startTimerLoop();

  if (mode === 'system' || mode === 'mixed') {
    e.sourceBanner.classList.remove('hidden');
    e.sourceBanner.textContent = 'Capturing system audio — in a browser this works reliably for a shared browser tab; whole-screen/window audio capture depends on your OS and may be silent (notably on macOS).';
  }
}

/** No AudioEngine at all here — Web Speech is the sole microphone consumer. See the file header for why this trade-off exists. */
async function startTranscriptOnlyRecording(meeting, settings) {
  const e = els();
  currentMeetingId = meeting.id;
  currentSessionId = null;

  await storage.updateMeeting(meeting.id, {
    status: 'recording', quality: 'standard', recording_mode: 'microphone', started_at: Date.now(),
  });

  const engineLabel = await transcriptionManager.start(meeting.id, { language: settings?.language || 'en' });
  updateEngineBanners(engineLabel);

  recordingStartPerfMs = performance.now();
  pausedAccumulatedMs = 0;
  store.patch('recording', { status: 'recording', mode: 'microphone', startedAt: Date.now(), sessionId: null });
  updateToolbarForStatus('recording');
  startTimerLoop();

  // No AudioEngine running, so the level meters have nothing to show.
  e.levelMic.style.width = '0%';
  e.levelSystem.style.width = '0%';
  e.sourceBanner.classList.remove('hidden');
  e.sourceBanner.textContent = 'Transcript-only mode: on this device, Web Speech needs sole access to your microphone, so no audio is being recorded for this meeting — only the live transcript.';
}

async function pauseRecording() {
  if (transcriptOnlyMode) {
    await transcriptionManager.stop();
    pausedAtPerfMs = performance.now();
    store.patch('recording', { status: 'paused' });
    updateToolbarForStatus('paused');
    stopTimerLoop();
    return;
  }

  audioEngine?.pause();
  pausedAtPerfMs = performance.now();
  storage.setSessionStatus(currentSessionId, lastMasterChunkIndex, 'paused');
  store.patch('recording', { status: 'paused' });
  updateToolbarForStatus('paused');
  stopTimerLoop();
}

async function resumeRecording() {
  if (transcriptOnlyMode) {
    const settings = store.get('settings');
    pausedAccumulatedMs += performance.now() - pausedAtPerfMs;
    const engineLabel = await transcriptionManager.start(currentMeetingId, { language: settings?.language || 'en' });
    updateEngineBanners(engineLabel);
    store.patch('recording', { status: 'recording' });
    updateToolbarForStatus('recording');
    startTimerLoop();
    return;
  }

  audioEngine?.resume();
  pausedAccumulatedMs += performance.now() - pausedAtPerfMs;
  storage.setSessionStatus(currentSessionId, lastMasterChunkIndex, 'recording');
  store.patch('recording', { status: 'recording' });
  updateToolbarForStatus('recording');
  startTimerLoop();
}

async function stopRecording() {
  const e = els();
  stopTimerLoop();
  const meetingId = currentMeetingId;
  const sessionId = currentSessionId;
  const durationMs = Math.round(currentElapsedMs());

  e.btnStop.disabled = true;
  e.statusText.textContent = 'Finalizing…';

  try {
    if (transcriptOnlyMode) {
      await transcriptionManager.stop();
      await storage.updateMeeting(meetingId, { duration_ms: durationMs, status: 'recorded' });
    } else {
      await audioEngine?.stop();
      await transcriptionManager.stop();
      await storage.finalizeRecording(sessionId, meetingId, durationMs);
    }
    const refreshed = await storage.getMeeting(meetingId);
    store.set('currentMeeting', refreshed);
    showToast(transcriptOnlyMode ? 'Transcript saved (no audio recording in this mode).' : 'Recording saved.', 'success');
  } catch (error) {
    showToast(`Error finalizing recording: ${error.message}`, 'error');
  } finally {
    audioEngine = null;
    currentSessionId = null;
    currentMeetingId = null;
    transcriptOnlyMode = false;
    store.patch('recording', { status: 'idle', sessionId: null });
    updateToolbarForStatus('idle');
  }
}

async function addLiveBookmark() {
  const meetingId = store.get('currentMeeting')?.id;
  if (!meetingId) return;
  const timeMs = Math.round(currentElapsedMs());
  const bookmark = await storage.addBookmark(meetingId, { timeMs, label: '' });
  store.set('recording.lastBookmark', bookmark);
  showToast('Bookmark added.', 'success');
}

function currentElapsedMs() {
  return Math.max(0, performance.now() - recordingStartPerfMs - pausedAccumulatedMs);
}

function startTimerLoop() {
  stopTimerLoop();
  timerHandle = setInterval(() => {
    els().timer.textContent = formatTimestamp(currentElapsedMs());
  }, 500);
}

function stopTimerLoop() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function updateToolbarForStatus(status) {
  const e = els();
  e.statusDot.className = `status-dot ${status === 'recording' ? 'recording' : status === 'paused' ? 'paused' : ''}`.trim();
  e.statusText.textContent = status === 'recording' ? 'Recording' : status === 'paused' ? 'Paused' : 'Ready';
  e.btnRecord.disabled = status !== 'idle';
  e.btnPause.disabled = status !== 'recording';
  e.btnStop.disabled = status === 'idle';
  e.btnBookmark.disabled = status === 'idle';
  e.btnPause.classList.toggle('hidden', status === 'paused');
  e.btnResume.classList.toggle('hidden', status !== 'paused');
  e.modeButtons.forEach((btn) => { btn.disabled = status !== 'idle' || !isModeSupported(btn.dataset.mode); });
  e.quality.disabled = status !== 'idle';
}

function updateEngineBanners(engineLabel) {
  const e = els();
  e.webSpeechBanner.classList.toggle('hidden', !transcriptionManager.isWebSpeech);
  e.noEngineBanner.classList.toggle('hidden', Boolean(engineLabel));
}

/** Checks IndexedDB for sessions left unfinished by a crash/force-close and offers to recover or discard each — see file header for why this is now pull-based instead of pushed from a main process. */
function initCrashRecovery() {
  storage.getUnfinishedSessions().then(async (sessions) => {
    for (const session of sessions) {
      const meeting = await storage.getMeeting(session.meeting_id);
      const title = meeting?.title || 'Untitled meeting';

      const body = el('div', {}, [
        el('h2', {}, 'Recover unfinished recording?'),
        el('p', {}, `MeetingScribe closed unexpectedly while recording "${title}". You can recover the audio captured so far, or discard it.`),
        el('div', { class: 'modal-actions' }, [
          el('button', {
            class: 'btn', type: 'button',
            onClick: async () => {
              try {
                await storage.discardSession(session.id);
              } catch (error) {
                showToast(`Could not discard: ${error.message}`, 'error');
              }
              close();
            },
          }, 'Discard'),
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onClick: async () => {
              try {
                const result = await storage.recoverSession(session);
                showToast(result?.discarded ? 'That meeting no longer exists — the leftover recording was discarded.' : 'Recording recovered.', 'success');
              } catch (error) {
                showToast(`Could not recover this recording: ${error.message}`, 'error');
              }
              close();
            },
          }, 'Recover'),
        ]),
      ]);
      const close = openModal(body);
    }
  });
}

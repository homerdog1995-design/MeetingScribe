'use strict';

import { store } from './state.js';
import { AudioEngine } from './audio.js';
import { transcriptionManager } from './transcription.js';
import { qs, qsa, el, formatTimestamp, showToast, openModal } from './utils.js';

const QUALITY_BITRATES = { low: 32000, standard: 96000, high: 192000 };

let audioEngine = null;
let timerHandle = null;
let lastMasterChunkIndex = -1;
let currentSessionId = null;
let currentMeetingId = null;
let recordingStartPerfMs = 0;
let pausedAccumulatedMs = 0;
let pausedAtPerfMs = 0;

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

export function initRecording() {
  const e = els();

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

  window.api.shortcuts.onStartRecording(() => {
    if (store.get('recording.status') === 'idle' && store.get('currentView') === 'meeting') startRecording();
  });
  window.api.shortcuts.onPauseRecording(() => {
    const status = store.get('recording.status');
    if (status === 'recording') pauseRecording();
    else if (status === 'paused') resumeRecording();
  });
  window.api.shortcuts.onStopRecording(() => {
    if (store.get('recording.status') !== 'idle') stopRecording();
  });
  window.api.shortcuts.onBookmark(() => {
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
  const hasFinalRecording = Boolean(meeting.recording_path);
  e.modeButtons.forEach((btn) => { btn.disabled = hasFinalRecording; });
  e.quality.disabled = hasFinalRecording;
  e.quality.value = meeting.quality || 'standard';
  setMode(meeting.recording_mode || 'microphone');
  e.btnRecord.disabled = hasFinalRecording;
  e.btnRecord.textContent = hasFinalRecording ? '● Recorded' : '● Record';
  e.statusText.textContent = hasFinalRecording ? 'Recorded' : 'Ready';
  e.timer.textContent = formatTimestamp(meeting.duration_ms || 0);
  e.sourceBanner.classList.add('hidden');
}

async function startRecording() {
  const e = els();
  const meeting = store.get('currentMeeting');
  if (!meeting) return;
  const mode = currentMode();

  let systemSourceId = null;
  if (mode === 'system' || mode === 'mixed') {
    try {
      systemSourceId = await pickSystemAudioSource();
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
    if (!systemSourceId) return; // user dismissed the picker without choosing a source
  }

  try {
    const session = await window.api.recording.createSession(meeting.id);
    currentSessionId = session.sessionId;
    currentMeetingId = meeting.id;
    lastMasterChunkIndex = -1;

    audioEngine = new AudioEngine();
    audioEngine.addEventListener('level', ({ detail }) => {
      e.levelMic.style.width = `${Math.round(detail.mic * 100)}%`;
      e.levelSystem.style.width = `${Math.round(detail.system * 100)}%`;
    });
    audioEngine.addEventListener('master-chunk', async ({ detail }) => {
      lastMasterChunkIndex = detail.index;
      try {
        await window.api.recording.saveMasterChunk(currentSessionId, currentMeetingId, detail.index, detail.arrayBuffer);
      } catch (error) {
        showToast(`Failed to save recording chunk: ${error.message}`, 'error');
      }
    });
    audioEngine.addEventListener('chunk-ready', ({ detail }) => {
      transcriptionManager.submitAudioChunk(detail);
    });

    const settings = store.get('settings');
    const quality = e.quality.value;
    await audioEngine.start(mode, {
      systemSourceId,
      speakerChangeSilenceMs: settings?.transcriptionPreferences?.speakerChangeSilenceMs ?? 700,
      audioBitsPerSecond: QUALITY_BITRATES[quality] ?? QUALITY_BITRATES.standard,
    });

    await window.api.storage.updateMeeting(meeting.id, {
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
      e.sourceBanner.textContent = 'Capturing system audio — this captures everything your computer is playing, not just one app or tab.';
    }
  } catch (error) {
    showToast(`Could not start recording: ${error.message}`, 'error');
    audioEngine = null;
  }
}

function pauseRecording() {
  audioEngine?.pause();
  pausedAtPerfMs = performance.now();
  window.api.recording.setSessionStatus(currentSessionId, lastMasterChunkIndex, 'paused');
  store.patch('recording', { status: 'paused' });
  updateToolbarForStatus('paused');
  stopTimerLoop();
}

function resumeRecording() {
  audioEngine?.resume();
  pausedAccumulatedMs += performance.now() - pausedAtPerfMs;
  window.api.recording.setSessionStatus(currentSessionId, lastMasterChunkIndex, 'recording');
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
    await audioEngine?.stop();
    await transcriptionManager.stop();
    await window.api.recording.finalize(sessionId, meetingId, durationMs);
    await window.api.storage.updateMeeting(meetingId, { duration_ms: durationMs });
    const refreshed = await window.api.storage.getMeeting(meetingId);
    store.set('currentMeeting', refreshed);
    showToast('Recording saved.', 'success');
  } catch (error) {
    showToast(`Error finalizing recording: ${error.message}`, 'error');
  } finally {
    audioEngine = null;
    currentSessionId = null;
    currentMeetingId = null;
    store.patch('recording', { status: 'idle', sessionId: null });
    updateToolbarForStatus('idle');
  }
}

async function addLiveBookmark() {
  const meetingId = store.get('currentMeeting')?.id;
  if (!meetingId) return;
  const timeMs = Math.round(currentElapsedMs());
  const bookmark = await window.api.storage.addBookmark(meetingId, { timeMs, label: '' });
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
  e.modeButtons.forEach((btn) => { btn.disabled = status !== 'idle'; });
  e.quality.disabled = status !== 'idle';
}

function updateEngineBanners(engineLabel) {
  const e = els();
  e.webSpeechBanner.classList.toggle('hidden', !transcriptionManager.isWebSpeech);
  e.noEngineBanner.classList.toggle('hidden', Boolean(engineLabel));
}

/** Shows a modal grid of capturable screens/windows and resolves with the chosen source id, or null if dismissed. */
function pickSystemAudioSource() {
  return new Promise((resolve, reject) => {
    window.api.desktopCapture.listSources().then((sources) => {
      if (!sources.length) {
        reject(new Error('No screens or windows are available to capture.'));
        return;
      }

      const grid = el('div', { class: 'source-picker-grid' });
      sources.forEach((source) => {
        const item = el('button', {
          class: 'source-picker-item',
          type: 'button',
          onClick: () => { resolve(source.id); close(); },
        }, [
          el('img', { src: source.thumbnailDataUrl, alt: source.name }),
          el('span', { class: 'source-name' }, source.name),
        ]);
        grid.appendChild(item);
      });

      const body = el('div', {}, [
        el('h2', {}, 'Choose what to capture'),
        el('p', { class: 'settings-help' }, 'MeetingScribe records the audio playing from your entire system, not just this one window — see docs/MODEL_SETUP.md for details.'),
        grid,
      ]);

      const close = openModal(body, { onClose: () => resolve(null) });
    }).catch(reject);
  });
}

function initCrashRecovery() {
  window.api.app.onUnfinishedSessions(async (sessions) => {
    for (const session of sessions) {
      const meeting = await window.api.storage.getMeeting(session.meeting_id);
      const title = meeting?.title || 'Untitled meeting';

      const body = el('div', {}, [
        el('h2', {}, 'Recover unfinished recording?'),
        el('p', {}, `MeetingScribe closed unexpectedly while recording "${title}". You can recover the audio captured so far, or discard it.`),
        el('div', { class: 'modal-actions' }, [
          el('button', {
            class: 'btn', type: 'button',
            onClick: async () => { await window.api.recording.discardSession(session.id); close(); },
          }, 'Discard'),
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onClick: async () => {
              await window.api.recording.recoverSession(session);
              showToast('Recording recovered.', 'success');
              close();
            },
          }, 'Recover'),
        ]),
      ]);
      const close = openModal(body);
    }
  });
}

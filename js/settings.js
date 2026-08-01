'use strict';

import { store } from './state.js';
import { storage } from './storage.js';
import { settingsStore } from './settingsStore.js';
import { backup } from './backup.js';
import { logger } from './logger.js';
import { detectAll } from './modelDetection.js';
import {
  qs, el, formatDuration, showToast, openModal,
} from './utils.js';

/**
 * CHANGES FROM THE ELECTRON VERSION (see also the relevant file headers):
 *  - window.api.settings.* -> settingsStore.js (IndexedDB instead of a JSON
 *    file on disk).
 *  - window.api.models.detect() -> modelDetection.js (fetch-based checks;
 *    whisper.cpp/faster-whisper fields removed entirely, since neither can
 *    run in a browser).
 *  - window.api.backup.* -> backup.js (a single downloadable JSON file
 *    instead of a zipped folder; restore is immediate, no relaunch needed —
 *    so window.api.system.relaunch() and the whole "stage + restart" flow
 *    are gone, replaced with a simple page reload after restore).
 *  - window.api.system.getLogs() -> logger.js (in-memory/localStorage log
 *    instead of a file).
 *  - "Choose storage location" removed entirely — there is no filesystem to
 *    pick a folder on; index.html now shows a storage-quota estimate
 *    instead (see refreshStorageStats below).
 *  - Hotkey-registration-failure warnings removed — Electron's global
 *    shortcuts could conflict with other apps holding the same OS-wide
 *    accelerator; in-page hotkeys (hotkeys.js) have no such conflict to
 *    report, so there's nothing to warn about anymore.
 */

export async function initSettings() {
  const settings = await settingsStore.get();
  store.set('settings', settings);
  applyVisualSettings(settings);
  populateFields(settings);
  wireFieldListeners();
  wireActionButtons();

  await Promise.all([refreshEngineDetection(), refreshStorageStats(), refreshBackupList()]);

  // Belt-and-braces: re-sync this one checkbox any time the settings store
  // changes for any reason, so it can never visually drift from the actual
  // persisted value — e.g. if the enable flow (which round-trips through a
  // confirmation modal) resolves while other async init work is still in
  // flight on a slow connection, nothing else was re-reading this field.
  store.subscribe('settings', (settings) => {
    const checkbox = qs('#setting-webspeech-enabled');
    if (document.activeElement !== checkbox) checkbox.checked = Boolean(settings.engines.webSpeech.enabled);
  });
}

// ---------------------------------------------------------------------------
// Visual settings (theme / accent / font size)
// ---------------------------------------------------------------------------

function applyVisualSettings(settings) {
  document.body.dataset.theme = settings.theme;
  document.body.dataset.fontSize = settings.fontSize;
  document.documentElement.style.setProperty('--color-accent', settings.accentColor);
}

// ---------------------------------------------------------------------------
// Populate fields from the current settings object
// ---------------------------------------------------------------------------

function populateFields(settings) {
  qs('#setting-theme').value = settings.theme;
  qs('#setting-accent-color').value = settings.accentColor;
  qs('#setting-font-size').value = settings.fontSize;
  qs('#setting-recording-quality').value = settings.recordingQuality;
  qs('#setting-autosave-interval').value = settings.autosaveIntervalSeconds;
  qs('#setting-speaker-silence-ms').value = settings.transcriptionPreferences.speakerChangeSilenceMs;

  qs('#setting-webspeech-enabled').checked = Boolean(settings.engines.webSpeech.enabled);

  qs('#setting-whisper-model').value = settings.engines.whisperWasm.modelId;
  qs('#setting-whisper-enabled').checked = Boolean(settings.engines.whisperWasm.active);
  qs('#whisper-wasm-status').textContent = !settings.engines.whisperWasm.enabled
    ? 'Not downloaded yet.'
    : settings.engines.whisperWasm.active
      ? `Downloaded and active (${settings.engines.whisperWasm.modelId}).`
      : `Downloaded (${settings.engines.whisperWasm.modelId}) but turned off below.`;

  qs('#setting-summary-engine').value = settings.summaryPreferences.preferredEngine;
  qs('#setting-ollama-port').value = settings.engines.ollama.port;
  qs('#setting-llamacpp-port').value = settings.engines.llamaCpp.port;

  qs('#hotkey-start').value = settings.hotkeys.startRecording;
  qs('#hotkey-pause').value = settings.hotkeys.pauseRecording;
  qs('#hotkey-stop').value = settings.hotkeys.stopRecording;
  qs('#hotkey-bookmark').value = settings.hotkeys.bookmark;
  qs('#hotkey-search').value = settings.hotkeys.search;
  qs('#hotkey-new-meeting').value = settings.hotkeys.newMeeting;

  qs('#setting-autobackup-enabled').checked = Boolean(settings.backups.autoBackupEnabled);
  qs('#setting-autobackup-interval').value = settings.backups.autoBackupIntervalHours;
  qs('#setting-autobackup-include-recordings').checked = Boolean(settings.backups.includeRecordingsInAutoBackup);
}

// ---------------------------------------------------------------------------
// Persisting changes
// ---------------------------------------------------------------------------

async function persistSetting(patch) {
  const updated = await settingsStore.set(patch);
  store.set('settings', updated);
  if (patch.theme || patch.accentColor || patch.fontSize) applyVisualSettings(updated);
  return updated;
}

function wireFieldListeners() {
  qs('#setting-theme').addEventListener('change', (e) => persistSetting({ theme: e.target.value }));
  qs('#setting-accent-color').addEventListener('input', (e) => persistSetting({ accentColor: e.target.value }));
  qs('#setting-font-size').addEventListener('change', (e) => persistSetting({ fontSize: e.target.value }));
  qs('#setting-recording-quality').addEventListener('change', (e) => persistSetting({ recordingQuality: e.target.value }));
  qs('#setting-autosave-interval').addEventListener('change', (e) => persistSetting({ autosaveIntervalSeconds: Number(e.target.value) }));
  qs('#setting-speaker-silence-ms').addEventListener('change', (e) => persistSetting({ transcriptionPreferences: { speakerChangeSilenceMs: Number(e.target.value) } }));

  qs('#setting-webspeech-enabled').addEventListener('change', (e) => handleWebSpeechToggle(e));
  qs('#setting-whisper-enabled').addEventListener('change', (e) => persistSetting({ engines: { whisperWasm: { active: e.target.checked } } }).then(() => populateFields(store.get('settings'))));

  qs('#setting-summary-engine').addEventListener('change', (e) => persistSetting({ summaryPreferences: { preferredEngine: e.target.value } }));
  qs('#setting-ollama-port').addEventListener('change', (e) => persistSetting({ engines: { ollama: { port: Number(e.target.value) } } }));
  qs('#setting-llamacpp-port').addEventListener('change', (e) => persistSetting({ engines: { llamaCpp: { port: Number(e.target.value) } } }));

  bindHotkeyInput('#hotkey-start', 'startRecording');
  bindHotkeyInput('#hotkey-pause', 'pauseRecording');
  bindHotkeyInput('#hotkey-stop', 'stopRecording');
  bindHotkeyInput('#hotkey-bookmark', 'bookmark');
  bindHotkeyInput('#hotkey-search', 'search');
  bindHotkeyInput('#hotkey-new-meeting', 'newMeeting');

  qs('#setting-autobackup-enabled').addEventListener('change', (e) => persistSetting({ backups: { autoBackupEnabled: e.target.checked } }));
  qs('#setting-autobackup-interval').addEventListener('change', (e) => persistSetting({ backups: { autoBackupIntervalHours: Number(e.target.value) } }));
  qs('#setting-autobackup-include-recordings').addEventListener('change', (e) => persistSetting({ backups: { includeRecordingsInAutoBackup: e.target.checked } }));
}

function bindHotkeyInput(selector, hotkeyKey) {
  qs(selector).addEventListener('change', (e) => persistSetting({ hotkeys: { [hotkeyKey]: e.target.value.trim() } }));
}

/** Web Speech sends microphone audio off-device, so enabling it always requires a fresh, explicit acknowledgement — even if it was enabled before. */
async function handleWebSpeechToggle(event) {
  const checkbox = event.target;
  if (!checkbox.checked) {
    await persistSetting({ engines: { webSpeech: { enabled: false } } });
    return;
  }

  checkbox.checked = false; // stays unchecked unless the user confirms below
  const body = el('div', {}, [
    el('h2', {}, 'Enable Web Speech API?'),
    el('p', {}, "This sends your microphone audio to Google's servers for recognition — it is the one feature in MeetingScribe that is not offline and not private. Only microphone audio is affected."),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary', type: 'button',
        onClick: async () => {
          await persistSetting({ engines: { webSpeech: { enabled: true, acknowledgedDisclosure: true } } });
          checkbox.checked = true;
          close();
        },
      }, 'I understand, enable it'),
    ]),
  ]);
  const close = openModal(body, { onClose: () => { checkbox.checked = false; } });
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

function wireActionButtons() {
  qs('#btn-rescan-engines').addEventListener('click', () => refreshEngineDetection());
  qs('#btn-download-whisper-model').addEventListener('click', () => downloadAndEnableWhisperWasm());
  qs('#btn-backup-now').addEventListener('click', () => runBackupNow());
  qs('#btn-restore-backup').addEventListener('click', () => confirmRestore());
  qs('#btn-export-settings').addEventListener('click', () => exportSettingsToFile());
  qs('#btn-import-settings').addEventListener('click', () => importSettingsFromFile());
  qs('#btn-view-logs').addEventListener('click', () => viewLogs());
  qs('#btn-reset-settings').addEventListener('click', () => confirmResetSettings());
}

/**
 * Downloads (or loads from IndexedDB cache, if already fetched once) the
 * selected Whisper model via the vendored library's own worker, then
 * enables the engine once that succeeds. This worker instance is only used
 * for this one-time priming step — actual transcription later spins up its
 * own worker (see whisperWasm.js's provider).
 */
async function downloadAndEnableWhisperWasm() {
  const modelId = qs('#setting-whisper-model').value;
  const button = qs('#btn-download-whisper-model');
  const statusEl = qs('#whisper-wasm-status');
  const progressTrack = qs('#whisper-wasm-progress-track');
  const progressFill = qs('#whisper-wasm-progress-fill');

  button.disabled = true;
  progressTrack.classList.remove('hidden');
  progressFill.style.width = '0%';
  statusEl.textContent = 'Downloading…';

  const worker = new Worker(new URL('./transcription/whisperWasmWorker.js', import.meta.url), { type: 'module' });
  try {
    await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const data = event.data;
        if (data.type === 'progress') progressFill.style.width = `${Math.round(data.progress)}%`;
        else if (data.type === 'loaded') resolve();
        else if (data.type === 'error') reject(new Error(data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'Worker error'));
      worker.postMessage({ type: 'load', requestId: 1, modelId });
    });

    await persistSetting({ engines: { whisperWasm: { enabled: true, modelId, active: true } } });
    statusEl.textContent = `Downloaded and enabled (${modelId}).`;
    showToast('Whisper WASM model downloaded and enabled.', 'success');
    await refreshEngineDetection();
  } catch (error) {
    statusEl.textContent = 'Not downloaded yet.';
    showToast(`Download failed: ${error.message}`, 'error');
  } finally {
    progressTrack.classList.add('hidden');
    worker.terminate();
    button.disabled = false;
  }
}

async function refreshEngineDetection() {
  const detection = await detectAll();
  store.set('engineDetection', detection);

  const container = qs('#engine-detection-list');
  container.innerHTML = '';
  const rows = [
    { label: 'Whisper WASM (on-device)', ok: detection.whisperWasm.available },
    { label: 'Web Speech API', ok: detection.webSpeech.enabled },
    { label: 'Speaker Diarization (on-device)', ok: detection.diarization.available },
    { label: 'Ollama', ok: detection.ollama.available },
    { label: 'llama.cpp server', ok: detection.llamaCpp.available },
  ];
  rows.forEach((row) => {
    const dot = el('span', { class: 'dot' });
    if (row.ok) dot.classList.add('ok');
    container.appendChild(el('div', { class: 'engine-detection-row' }, [dot, el('span', {}, `${row.label} — ${row.ok ? 'detected' : 'not detected'}`)]));
  });

  updateSidebarEngineBadge(detection);
}

function updateSidebarEngineBadge(detection) {
  const dot = qs('#engine-status-dot');
  const text = qs('#engine-status-text');
  const anyOffline = detection.whisperWasm.available;
  dot.classList.toggle('ok', anyOffline);
  dot.classList.toggle('warn', !anyOffline && detection.webSpeech.enabled);
  text.textContent = anyOffline
    ? 'Offline transcription ready'
    : (detection.webSpeech.enabled ? 'Web Speech API only (not offline)' : 'No transcription engine configured');
}

/** Uses the Storage API's quota estimate as a stand-in for "database size" — IndexedDB doesn't expose a direct byte count the way a SQLite file's size did. */
async function refreshStorageStats() {
  const [stats, estimate] = await Promise.all([
    storage.getStorageStats(),
    navigator.storage?.estimate ? navigator.storage.estimate() : Promise.resolve(null),
  ]);
  const container = qs('#storage-stats');
  container.innerHTML = '';
  container.append(
    statBlock('Meetings', String(stats.meetingCount)),
    statBlock('Total recorded', formatDuration(stats.totalDurationMs)),
    statBlock('Recordings size', formatBytes(stats.recordingsSizeBytes)),
    statBlock('Browser storage used', estimate ? `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}` : 'Unavailable'),
  );
}

function statBlock(label, value) {
  return el('div', {}, [el('strong', {}, value), el('span', {}, label)]);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex > 0 && value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

async function runBackupNow() {
  const button = qs('#btn-backup-now');
  button.disabled = true;
  try {
    await backup.createNow();
    showToast('Backup downloaded.', 'success');
    await refreshBackupList();
  } catch (error) {
    showToast(`Backup failed: ${error.message}`, 'error');
    logger.error('backup', 'createNow failed', { message: error.message });
  } finally {
    button.disabled = false;
  }
}

async function refreshBackupList() {
  const backups = backup.list();
  const container = qs('#backup-list');
  container.innerHTML = '';
  if (!backups.length) {
    container.appendChild(el('p', { class: 'settings-help' }, 'No backups yet.'));
    return;
  }
  backups.forEach((entry) => {
    container.appendChild(el('div', { class: 'backup-row' }, [
      el('span', {}, `${new Date(entry.createdAt).toLocaleString()} — ${entry.name}${entry.sizeBytes ? ` (${formatBytes(entry.sizeBytes)})` : ''}`),
    ]));
  });
}

/** Unlike the Electron version, restoring here is immediate — IndexedDB can be safely cleared and repopulated while the page is running, so there's no "stage + restart" step. A reload just ensures every in-memory view reflects the freshly-restored data. */
function confirmRestore() {
  const body = el('div', {}, [
    el('h2', {}, 'Restore from backup file'),
    el('p', {}, 'Choose a MeetingScribe backup JSON file. This replaces all current meetings, transcripts, recordings, and settings — this cannot be undone.'),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-danger', type: 'button',
        onClick: async () => {
          const result = await backup.restoreFromFile();
          if (result.canceled) { close(); return; }
          showToast('Backup restored — reloading…', 'success');
          setTimeout(() => window.location.reload(), 600);
        },
      }, 'Choose file & restore'),
    ]),
  ]);
  const close = openModal(body);
}

async function exportSettingsToFile() {
  await settingsStore.exportToFile();
  showToast('Settings file downloaded.', 'success');
}

async function importSettingsFromFile() {
  const result = await settingsStore.importFromFile();
  if (result.canceled) return;
  store.set('settings', result.settings);
  populateFields(result.settings);
  applyVisualSettings(result.settings);
  showToast('Settings imported.', 'success');
}

function confirmResetSettings() {
  const body = el('div', {}, [
    el('h2', {}, 'Reset all settings?'),
    el('p', {}, 'This restores every setting to its default value. Your meetings, transcripts, and recordings are not affected.'),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-danger', type: 'button',
        onClick: async () => {
          const defaults = await settingsStore.reset();
          store.set('settings', defaults);
          populateFields(defaults);
          applyVisualSettings(defaults);
          showToast('Settings reset to defaults.', 'success');
          close();
        },
      }, 'Reset'),
    ]),
  ]);
  const close = openModal(body);
}

function viewLogs() {
  const logs = logger.readTail();
  const pre = el('pre', {}, logs || 'No log entries yet.');
  pre.style.cssText = 'max-height:60vh;overflow:auto;white-space:pre-wrap;font-family:var(--font-mono);font-size:11.5px;background:var(--color-canvas);padding:10px;border-radius:8px;';
  const body = el('div', {}, [el('h2', {}, 'Diagnostics log'), pre]);
  openModal(body);
}

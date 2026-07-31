'use strict';

import { store } from './state.js';
import {
  qs, el, formatDuration, showToast, openModal,
} from './utils.js';

export async function initSettings() {
  const settings = await window.api.settings.get();
  store.set('settings', settings);
  applyVisualSettings(settings);
  populateFields(settings);
  wireFieldListeners();
  wireActionButtons();

  window.api.app.onShortcutRegistrationFailures((failures) => showHotkeyWarning(failures));

  await Promise.all([refreshEngineDetection(), refreshStorageStats(), refreshBackupList()]);
}

// ---------------------------------------------------------------------------
// Visual settings (theme / accent / font size)
// ---------------------------------------------------------------------------

function applyVisualSettings(settings) {
  document.body.dataset.theme = settings.theme;
  document.body.dataset.fontSize = settings.fontSize;
  // --color-accent is declared on :root and not overridden per-theme, so
  // setting it on the root element applies correctly in both light and dark.
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
  qs('#setting-storage-location').textContent = settings.storageLocation || 'Default';

  qs('#setting-whispercpp-binary').value = settings.engines.whisperCpp.binaryPath || '';
  qs('#setting-whispercpp-model').value = settings.engines.whisperCpp.modelPath || '';
  qs('#setting-whispercpp-tdrz').checked = Boolean(settings.engines.whisperCpp.tinydiarize);

  qs('#setting-fasterwhisper-python').value = settings.engines.fasterWhisper.pythonPath || '';
  qs('#setting-fasterwhisper-size').value = settings.engines.fasterWhisper.modelSize;
  qs('#setting-fasterwhisper-device').value = settings.engines.fasterWhisper.device;

  qs('#setting-webspeech-enabled').checked = Boolean(settings.engines.webSpeech.enabled);

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
  const updated = await window.api.settings.set(patch);
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

  qs('#setting-whispercpp-binary').addEventListener('change', (e) => persistSetting({ engines: { whisperCpp: { binaryPath: e.target.value.trim() || null } } }));
  qs('#setting-whispercpp-model').addEventListener('change', (e) => persistSetting({ engines: { whisperCpp: { modelPath: e.target.value.trim() || null } } }));
  qs('#setting-whispercpp-tdrz').addEventListener('change', (e) => persistSetting({ engines: { whisperCpp: { tinydiarize: e.target.checked } } }));

  qs('#setting-fasterwhisper-python').addEventListener('change', (e) => persistSetting({ engines: { fasterWhisper: { pythonPath: e.target.value.trim() || 'python3' } } }));
  qs('#setting-fasterwhisper-size').addEventListener('change', (e) => persistSetting({ engines: { fasterWhisper: { modelSize: e.target.value } } }));
  qs('#setting-fasterwhisper-device').addEventListener('change', (e) => persistSetting({ engines: { fasterWhisper: { device: e.target.value } } }));

  qs('#setting-webspeech-enabled').addEventListener('change', (e) => handleWebSpeechToggle(e));

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

function showHotkeyWarning(failures) {
  const banner = qs('#hotkey-warning');
  if (!failures || !failures.length) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  banner.textContent = `Could not register: ${failures.map((f) => f.accelerator).join(', ')} — likely already in use by another application.`;
  banner.classList.remove('hidden');
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
  qs('#btn-choose-storage-location').addEventListener('click', () => chooseStorageLocation());
  qs('#btn-rescan-engines').addEventListener('click', () => refreshEngineDetection());
  qs('#btn-backup-now').addEventListener('click', () => runBackupNow());
  qs('#btn-restore-backup').addEventListener('click', () => openRestoreBackupModal());
  qs('#btn-export-settings').addEventListener('click', () => exportSettingsToFile());
  qs('#btn-import-settings').addEventListener('click', () => importSettingsFromFile());
  qs('#btn-view-logs').addEventListener('click', () => viewLogs());
  qs('#btn-reset-settings').addEventListener('click', () => confirmResetSettings());
}

async function chooseStorageLocation() {
  const result = await window.api.settings.chooseStorageLocation();
  if (result.canceled) return;
  await persistSetting({ storageLocation: result.path });
  qs('#setting-storage-location').textContent = result.path;
  offerRestart('New recordings will be saved to the new location after MeetingScribe restarts. Existing recordings are not moved automatically.');
}

async function refreshEngineDetection() {
  const detection = await window.api.models.detect();
  store.set('engineDetection', detection);

  const container = qs('#engine-detection-list');
  container.innerHTML = '';
  const rows = [
    { label: 'whisper.cpp', ok: detection.whisperCpp.available },
    { label: 'Faster-Whisper', ok: detection.fasterWhisper.available },
    { label: 'Whisper WASM', ok: detection.whisperWasm.available },
    { label: 'Web Speech API', ok: detection.webSpeech.enabled },
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
  const anyOffline = detection.whisperCpp.available || detection.fasterWhisper.available || detection.whisperWasm.available;
  dot.classList.toggle('ok', anyOffline);
  dot.classList.toggle('warn', !anyOffline && detection.webSpeech.enabled);
  text.textContent = anyOffline
    ? 'Offline transcription ready'
    : (detection.webSpeech.enabled ? 'Web Speech API only (not offline)' : 'No transcription engine configured');
}

async function refreshStorageStats() {
  const stats = await window.api.storage.getStorageStats();
  const container = qs('#storage-stats');
  container.innerHTML = '';
  container.append(
    statBlock('Meetings', String(stats.meetingCount)),
    statBlock('Total recorded', formatDuration(stats.totalDurationMs)),
    statBlock('Database size', formatBytes(stats.dbSizeBytes)),
    statBlock('Recordings size', formatBytes(stats.recordingsSizeBytes)),
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
    const settings = store.get('settings');
    await window.api.backup.createNow({ includeRecordings: settings.backups.includeRecordingsInAutoBackup });
    showToast('Backup created.', 'success');
    await refreshBackupList();
  } catch (error) {
    showToast(`Backup failed: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshBackupList() {
  const backups = (await window.api.backup.list()).sort((a, b) => b.createdAt - a.createdAt);
  const container = qs('#backup-list');
  container.innerHTML = '';
  if (!backups.length) {
    container.appendChild(el('p', { class: 'settings-help' }, 'No backups yet.'));
    return;
  }
  backups.forEach((backup) => {
    container.appendChild(el('div', { class: 'backup-row' }, [
      el('span', {}, `${new Date(backup.createdAt).toLocaleString()} — ${backup.name}${backup.sizeBytes ? ` (${formatBytes(backup.sizeBytes)})` : ''}`),
      el('button', { class: 'btn btn-small', type: 'button', onClick: () => confirmRestore(backup) }, 'Restore'),
    ]));
  });
}

async function openRestoreBackupModal() {
  const backups = (await window.api.backup.list()).sort((a, b) => b.createdAt - a.createdAt);
  const rows = backups.length
    ? backups.map((backup) => el('div', { class: 'backup-row' }, [
      el('span', {}, `${new Date(backup.createdAt).toLocaleString()} — ${backup.name}`),
      el('button', { class: 'btn btn-small btn-primary', type: 'button', onClick: () => confirmRestore(backup, () => close()) }, 'Restore'),
    ]))
    : [el('p', { class: 'settings-help' }, 'No backups available yet — create one first with "Back up now".')];

  const body = el('div', {}, [el('h2', {}, 'Restore from backup'), el('div', {}, rows)]);
  const close = openModal(body);
}

function confirmRestore(backup, afterConfirm) {
  const body = el('div', {}, [
    el('h2', {}, 'Restore this backup?'),
    el('p', {}, `This replaces all current meetings, transcripts, recordings, and settings with the contents of "${backup.name}". MeetingScribe must restart to finish. This cannot be undone.`),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-danger', type: 'button',
        onClick: async () => {
          await window.api.backup.stageRestore(backup.path);
          close();
          afterConfirm?.();
          offerRestart('MeetingScribe needs to restart to finish restoring this backup.');
        },
      }, 'Restore and restart'),
    ]),
  ]);
  const close = openModal(body);
}

function offerRestart(message) {
  const body = el('div', {}, [
    el('h2', {}, 'Restart required'),
    el('p', {}, message),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Later'),
      el('button', { class: 'btn btn-primary', type: 'button', onClick: () => window.api.system.relaunch() }, 'Restart now'),
    ]),
  ]);
  const close = openModal(body);
}

async function exportSettingsToFile() {
  const result = await window.api.settings.exportToFile();
  if (result.canceled) return;
  showToast(`Settings exported to ${result.filePath}`, 'success');
}

async function importSettingsFromFile() {
  const result = await window.api.settings.importFromFile();
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
          const defaults = await window.api.settings.reset();
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

async function viewLogs() {
  const logs = await window.api.system.getLogs();
  const pre = el('pre', {}, logs || 'No log entries yet.');
  pre.style.cssText = 'max-height:60vh;overflow:auto;white-space:pre-wrap;font-family:var(--font-mono);font-size:11.5px;background:var(--color-canvas);padding:10px;border-radius:8px;';
  const body = el('div', {}, [el('h2', {}, 'Diagnostics log'), pre]);
  openModal(body);
}

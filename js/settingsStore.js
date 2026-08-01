'use strict';

import { openDatabase } from './db.js';

/**
 * settingsStore.js — browser replacement for the old Electron settingsStore.js.
 *
 * WHY CHANGED: the old version read/wrote a JSON file via `fs` in the main
 * process. There is no filesystem here, so settings live in IndexedDB's
 * `settings` object store (a single row, key 'app') instead.
 *
 * WHAT WAS REMOVED FROM DEFAULT_SETTINGS AND WHY:
 *   - `windowBounds` — was Electron BrowserWindow position/size; browsers
 *     manage their own window/tab state, nothing for this app to persist.
 *   - `storageLocation` — was a filesystem directory for recordings; there is
 *     no concept of "where on disk" in a browser (IndexedDB's location is
 *     managed entirely by the browser). Removed rather than kept as a dead
 *     field — settings.js now shows an explanatory note in its place instead.
 *   - `engines.whisperCpp` / `engines.fasterWhisper` — both required
 *     spawning a native binary, which no browser permits under any
 *     circumstances. Removed rather than left as inert config.
 *
 * WHAT WAS KEPT WITH A CAVEAT: `hotkeys.*` are kept, but they now register
 * as in-page `keydown` listeners (see recording.js) rather than Electron's
 * `globalShortcut` — they only fire while the app's tab is focused, not
 * system-wide. settings.js surfaces this in the UI.
 */

const STORE_KEY = 'app';

const DEFAULT_SETTINGS = {
  theme: 'light',
  accentColor: '#3a5ce0',
  fontSize: 'medium',
  recordingQuality: 'standard',
  autosaveIntervalSeconds: 30,
  language: 'en',
  transcriptionPreferences: {
    speakerChangeSilenceMs: 700,
  },
  engines: {
    whisperWasm: { enabled: false, modelId: 'base.en', active: true },
    webSpeech: { enabled: false, acknowledgedDisclosure: false },
    ollama: { port: 11434 },
    llamaCpp: { port: 8080 },
  },
  summaryPreferences: {
    preferredEngine: 'auto',
    preferredModel: null,
  },
  hotkeys: {
    startRecording: 'Control+Shift+R',
    pauseRecording: 'Control+Shift+P',
    stopRecording: 'Control+Shift+S',
    bookmark: 'Control+Shift+B',
    search: 'Control+Shift+F',
    newMeeting: 'Control+Shift+N',
  },
  backups: {
    autoBackupEnabled: false,
    autoBackupIntervalHours: 24,
    includeRecordingsInAutoBackup: false,
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base?.[key] === 'object') {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function readRaw() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(STORE_KEY);
    req.onsuccess = () => resolve(req.result?.value || null);
    req.onerror = () => reject(req.error);
  });
}

async function writeRaw(value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key: STORE_KEY, value });
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

async function get() {
  const stored = await readRaw();
  return deepMerge(DEFAULT_SETTINGS, stored || {});
}

async function set(patch) {
  const current = await get();
  const next = deepMerge(current, patch);
  await writeRaw(next);
  return next;
}

async function reset() {
  await writeRaw(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

/** Triggers a browser download of the current settings as JSON. Replaces the old native "Save As" dialog. */
async function exportToFile() {
  const settings = await get();
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'meetingscribe-settings.json';
  link.click();
  URL.revokeObjectURL(url);
  return { canceled: false, filePath: link.download };
}

/** Opens a file picker (replaces the old native "Open" dialog) and imports the chosen settings JSON. */
function importFromFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { resolve({ canceled: true }); return; }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const next = await set(parsed);
        resolve({ canceled: false, settings: next });
      } catch (error) {
        resolve({ canceled: true, error: error.message });
      }
    });
    input.click();
  });
}

export const settingsStore = { get, set, reset, exportToFile, importFromFile, DEFAULT_SETTINGS };

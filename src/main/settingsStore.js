'use strict';

/**
 * Settings are stored as a single JSON file rather than a SQLite table
 * deliberately: settings must remain readable (and the app must still be
 * able to boot to a usable state) even if the meetings database is ever
 * corrupted, moved, or mid-migration.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DEFAULT_SETTINGS = {
  theme: 'light',
  accentColor: '#4f7cff',
  fontSize: 'medium', // small | medium | large
  recordingQuality: 'standard', // low | standard | high
  storageLocation: null, // null = default userData path; set once user picks
  autosaveIntervalSeconds: 20,
  language: 'en',
  summaryPreferences: {
    preferredEngine: 'auto', // auto | ollama | llamacpp | heuristic
    preferredModel: null,
    sections: {
      executiveSummary: true,
      overview: true,
      topics: true,
      decisions: true,
      risks: true,
      questions: true,
      actionItems: true,
      followUps: true,
      openIssues: true,
    },
  },
  transcriptionPreferences: {
    autoStart: true,
    speakerChangeSilenceMs: 700,
  },
  engines: {
    whisperCpp: { binaryPath: null, modelPath: null, tinydiarize: false, language: 'auto' },
    fasterWhisper: { pythonPath: 'python3', modelSize: 'base', device: 'cpu' },
    whisperWasm: { enabled: true },
    webSpeech: { enabled: false, acknowledgedDisclosure: false },
    ollama: { port: 11434 },
    llamaCpp: { port: 8080 },
  },
  hotkeys: {
    startRecording: 'CommandOrControl+Shift+R',
    pauseRecording: 'CommandOrControl+Shift+P',
    stopRecording: 'CommandOrControl+Shift+S',
    bookmark: 'CommandOrControl+Shift+B',
    search: 'CommandOrControl+Shift+F',
    newMeeting: 'CommandOrControl+Shift+N',
  },
  privacy: {
    showWebSpeechBanner: true,
    autoDeleteRecordingsAfterDays: null,
  },
  backups: {
    autoBackupEnabled: true,
    autoBackupIntervalHours: 24,
    includeRecordingsInAutoBackup: false,
    keepLastN: 5,
  },
  windowBounds: null,
};

let settingsFilePath = null;
let cache = null;

function open(userDataPath) {
  settingsFilePath = path.join(userDataPath, 'settings.json');
  cache = load();
  return cache;
}

function load() {
  if (!fs.existsSync(settingsFilePath)) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    const raw = fs.readFileSync(settingsFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    return deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
  } catch (err) {
    logger.error('settings', 'Failed to parse settings.json, falling back to defaults', { error: err.message });
    // Preserve the corrupt file for forensics instead of silently overwriting it.
    try {
      fs.renameSync(settingsFilePath, `${settingsFilePath}.corrupt-${Date.now()}`);
    } catch { /* best-effort */ }
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
    fs.writeFileSync(settingsFilePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    logger.error('settings', 'Failed to write settings.json', { error: err.message });
  }
}

function get() {
  return structuredClone(cache);
}

function set(patch) {
  cache = deepMerge(cache, patch);
  persist();
  logger.info('settings', 'Settings updated', { keys: Object.keys(patch) });
  return get();
}

function resetToDefaults() {
  cache = structuredClone(DEFAULT_SETTINGS);
  persist();
  return get();
}

function exportToFile(destinationPath) {
  fs.writeFileSync(destinationPath, JSON.stringify(cache, null, 2), 'utf8');
}

function importFromFile(sourcePath) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parsed = JSON.parse(raw);
  cache = deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
  persist();
  return get();
}

function deepMerge(target, source) {
  if (typeof source !== 'object' || source === null) return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = {
  open,
  get,
  set,
  resetToDefaults,
  exportToFile,
  importFromFile,
  DEFAULT_SETTINGS,
};

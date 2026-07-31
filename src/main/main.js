'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const logger = require('./logger');
const security = require('./security');
const storage = require('./storage');
const settingsStore = require('./settingsStore');
const backup = require('./backup');
const shortcuts = require('./shortcuts');
const desktopCapture = require('./desktopCapture');
const ipcHandlers = require('./ipcHandlers');

// A single instance lock avoids two copies of the app opening the same
// SQLite database file concurrently, which better-sqlite3's WAL mode does
// not protect against across separate OS processes as safely as a single
// process with serialized access.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let recordingsDir = null;
let autoBackupTimer = null;

function getMainWindow() {
  return mainWindow;
}

function resolveUserDataPaths() {
  const settings = settingsStore.get();
  const base = settings.storageLocation || app.getPath('userData');
  fs.mkdirSync(base, { recursive: true });
  return {
    base,
    recordingsDir: path.join(base, 'recordings'),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const appOrigin = `file://${path.join(__dirname, '..', 'renderer')}`;
  security.initialize(mainWindow, appOrigin);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', () => {
    const bounds = mainWindow.getBounds();
    settingsStore.set({ windowBounds: bounds });
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const savedBounds = settingsStore.get().windowBounds;
  if (savedBounds) mainWindow.setBounds(savedBounds);

  return mainWindow;
}

function setupGlobalShortcuts() {
  const { hotkeys } = settingsStore.get();
  const { failures } = shortcuts.registerAll(mainWindow, hotkeys);
  if (failures.length && mainWindow) {
    mainWindow.webContents.send('app:shortcutFailures', failures);
  }
}

async function checkForUnfinishedRecordings() {
  const sessions = storage.getUnfinishedSessions();
  if (sessions.length > 0 && mainWindow) {
    logger.warn('main', `${sessions.length} unfinished recording session(s) detected on startup`);
    mainWindow.webContents.send('app:unfinishedSessions', sessions);
  }
}

function setupAutoBackup(appVersion) {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  const { autoBackupEnabled, autoBackupIntervalHours, includeRecordingsInAutoBackup, keepLastN } = settingsStore.get().backups;
  if (!autoBackupEnabled) return;

  const intervalMs = Math.max(1, autoBackupIntervalHours) * 60 * 60 * 1000;
  autoBackupTimer = setInterval(async () => {
    try {
      await backup.createBackup({
        userDataPath: app.getPath('userData'),
        recordingsDir,
        includeRecordings: includeRecordingsInAutoBackup,
        appVersion,
      });
      pruneOldBackups(keepLastN);
    } catch (err) {
      logger.error('main', 'Scheduled auto-backup failed', { error: err.message });
    }
  }, intervalMs);
}

function pruneOldBackups(keepLastN) {
  const all = backup.listBackups(app.getPath('userData'));
  const stale = all.slice(keepLastN);
  for (const item of stale) {
    fs.rm(item.path, { recursive: true, force: true }, () => {});
  }
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');

  // Apply any pending restore (staged by backup.stageRestore in a previous
  // session) BEFORE opening the database, since it swaps the DB file itself.
  backup.applyPendingRestoreIfAny(userDataPath);

  settingsStore.open(userDataPath);
  const paths = resolveUserDataPaths();
  recordingsDir = paths.recordingsDir;
  fs.mkdirSync(recordingsDir, { recursive: true });

  logger.init(path.join(userDataPath, 'logs'));
  storage.open(paths.base);

  desktopCapture.installDisplayMediaHandler();
  desktopCapture.registerHandlers();

  const whisperWasmAssetsDir = path.join(app.getAppPath(), 'assets', 'whisper-wasm');
  ipcHandlers.registerAll({ getMainWindow, recordingsDir, appVersion: app.getVersion(), whisperWasmAssetsDir });

  createWindow();
  setupGlobalShortcuts();
  setupAutoBackup(app.getVersion());

  mainWindow.webContents.once('did-finish-load', () => {
    checkForUnfinishedRecordings();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  shortcuts.unregisterAll();
  storage.close();
  if (autoBackupTimer) clearInterval(autoBackupTimer);
});

process.on('uncaughtException', (err) => {
  logger.error('main', 'Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('main', 'Unhandled promise rejection', { reason: reason?.message || String(reason) });
});

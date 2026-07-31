'use strict';

/**
 * backup.js — browser replacement for the old Electron main-process backup.js
 * (which used Node's `fs`/`archiver` to zip the SQLite file + recordings
 * directory on disk, and required an app-restart "staged restore" because
 * you can't safely overwrite a database file that's currently open).
 *
 * WHY THIS IS SIMPLER NOW: there's no separate database *file* to copy —
 * IndexedDB is already the storage engine, so "backup" is just serializing
 * every object store (via storage.exportAllData(), which also inlines
 * recording Blobs as base64) into one JSON file and offering it as a
 * download. "Restore" is the reverse: read the JSON, clear each store, and
 * repopulate it — no restart needed, since a browser can safely clear and
 * rewrite IndexedDB stores while running (unlike replacing an open SQLite
 * file out from under the process).
 *
 * TRADE-OFF: for meetings with many/long recordings, the exported JSON file
 * can be large (base64 inflates binary size by ~33%). This is an accepted
 * cost of "a backup is one plain file you can move anywhere," matching the
 * spirit of the original "automatic local backups, manual backup, restore
 * backup" requirement without needing any server or native file APIs.
 */

import { storage } from './storage.js';

function backupFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `meetingscribe-backup-${stamp}.json`;
}

async function createNow() {
  const dump = await storage.exportAllData();
  const payload = { formatVersion: 1, createdAt: Date.now(), data: dump };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const name = backupFileName();

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);

  recordBackupHistoryEntry(name, blob.size);
  return { name, sizeBytes: blob.size, createdAt: payload.createdAt };
}

/**
 * Browsers can't list "files on disk" the way the old backup.list() did by
 * reading a directory — a downloaded backup lands wherever the user's
 * browser puts downloads, invisible to this page. Instead, a small local
 * history of past backups (name/size/timestamp only, not the data itself)
 * is kept in localStorage purely so the Settings screen can show "you last
 * backed up on...". Restoring always requires the user to pick the actual
 * file again via the browser's file picker (see restoreFromFile below).
 */
const HISTORY_KEY = 'meetingscribe.backupHistory';

function recordBackupHistoryEntry(name, sizeBytes) {
  const history = list();
  history.unshift({ name, sizeBytes, createdAt: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
}

function list() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

/** Opens a file picker and restores from the chosen backup JSON immediately (no restart needed — see file header). */
function restoreFromFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { resolve({ canceled: true }); return; }
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        await storage.importAllData(payload.data || payload);
        resolve({ canceled: false });
      } catch (error) {
        resolve({ canceled: true, error: error.message });
      }
    });
    input.click();
  });
}

export const backup = { createNow, list, restoreFromFile };

'use strict';

/**
 * logger.js — browser replacement for the old main-process logger.js
 * (which wrote timestamped lines to a file under Electron's userData
 * directory via `fs`). There's no filesystem here, so this keeps a capped
 * in-memory ring buffer instead, persisted to localStorage so the log
 * survives a page reload (but is deliberately NOT persisted in IndexedDB —
 * logs are diagnostic scratch data, not something a backup/restore should
 * carry around).
 */

const MAX_ENTRIES = 500;
const STORAGE_KEY = 'meetingscribe.logs';

function readEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // If localStorage is full or unavailable (e.g. private browsing), logging
    // degrades to console-only rather than throwing and breaking the caller.
  }
}

function append(level, scope, message, meta) {
  const entry = { at: Date.now(), level, scope, message, meta: meta ? safeStringify(meta) : undefined };
  const entries = readEntries();
  entries.push(entry);
  writeEntries(entries);
  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  consoleMethod(`[${scope}] ${message}`, meta ?? '');
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readTail() {
  return readEntries()
    .map((e) => `${new Date(e.at).toISOString()} [${e.level.toUpperCase()}] [${e.scope}] ${e.message}${e.meta ? ` ${e.meta}` : ''}`)
    .join('\n');
}

export const logger = {
  info: (scope, message, meta) => append('info', scope, message, meta),
  warn: (scope, message, meta) => append('warn', scope, message, meta),
  error: (scope, message, meta) => append('error', scope, message, meta),
  readTail,
  clear: () => writeEntries([]),
};

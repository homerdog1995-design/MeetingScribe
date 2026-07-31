'use strict';

/**
 * Lightweight structured logger for the main process.
 *
 * Design goals:
 *  - Zero network/telemetry: writes only to local disk.
 *  - Never throws: a logging failure must never crash the app.
 *  - Rotates by size so a long-running instance (recording for hours, over
 *    many days of use) cannot grow the log file without bound.
 *  - Redacts obvious sensitive-looking values (paths under the user's home
 *    directory are kept, but anything that looks like an API key/token
 *    pattern is masked) before writing, since log files may be attached to a
 *    bug report by the user.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_ROTATED_FILES = 5;

const SECRET_PATTERN = /((?:api|secret|token|password|passwd|key)[_-]?)[=:]\s*['"]?[A-Za-z0-9\-_.]{8,}['"]?/gi;

class Logger {
  constructor() {
    this._dir = null;
    this._file = null;
    this._minLevel = LEVELS.info;
    this._queue = [];
    this._writing = false;
    this._initialized = false;
  }

  /**
   * Must be called once app.getPath('userData') is available. Safe to call
   * more than once (e.g. after a storage-location change in Settings).
   */
  init(logDirectory, { minLevel = 'info' } = {}) {
    try {
      fs.mkdirSync(logDirectory, { recursive: true });
      this._dir = logDirectory;
      this._file = path.join(logDirectory, 'meetingscribe.log');
      this._minLevel = LEVELS[minLevel] ?? LEVELS.info;
      this._initialized = true;
      this._rotateIfNeeded();
      this.info('logger', 'Logger initialized', { platform: os.platform(), release: os.release() });
    } catch (err) {
      // Logging is best-effort. If we cannot even create the log directory,
      // fall back to console-only output rather than throwing during boot.
      console.error('[logger] failed to initialize file logging:', err.message);
    }
  }

  debug(scope, message, meta) { this._log('debug', scope, message, meta); }
  info(scope, message, meta) { this._log('info', scope, message, meta); }
  warn(scope, message, meta) { this._log('warn', scope, message, meta); }
  error(scope, message, meta) { this._log('error', scope, message, meta); }

  /**
   * Reads the tail of the current log file, for the in-app diagnostics panel.
   */
  readTail(maxBytes = 64 * 1024) {
    if (!this._initialized || !fs.existsSync(this._file)) return '';
    try {
      const stat = fs.statSync(this._file);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(this._file, 'r');
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd);
      return buffer.toString('utf8');
    } catch (err) {
      return `(failed to read log tail: ${err.message})`;
    }
  }

  _log(level, scope, message, meta) {
    if (LEVELS[level] < this._minLevel) return;

    const line = this._format(level, scope, message, meta);
    // Always mirror to console during development / for `electron .` output.
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);

    if (!this._initialized) return;
    this._queue.push(line + '\n');
    this._flush();
  }

  _format(level, scope, message, meta) {
    const ts = new Date().toISOString();
    let metaStr = '';
    if (meta !== undefined) {
      try {
        metaStr = ' ' + redact(JSON.stringify(meta));
      } catch {
        metaStr = ' [unserializable meta]';
      }
    }
    return `${ts} [${level.toUpperCase().padEnd(5)}] (${scope}) ${redact(String(message))}${metaStr}`;
  }

  _flush() {
    if (this._writing || this._queue.length === 0) return;
    this._writing = true;
    const chunk = this._queue.join('');
    this._queue = [];
    fs.appendFile(this._file, chunk, (err) => {
      this._writing = false;
      if (err) {
        console.error('[logger] failed to write log file:', err.message);
        return;
      }
      this._rotateIfNeeded();
      if (this._queue.length > 0) this._flush();
    });
  }

  _rotateIfNeeded() {
    try {
      if (!fs.existsSync(this._file)) return;
      const { size } = fs.statSync(this._file);
      if (size < MAX_LOG_BYTES) return;

      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const src = `${this._file}.${i}`;
        const dst = `${this._file}.${i + 1}`;
        if (fs.existsSync(src)) {
          if (i + 1 > MAX_ROTATED_FILES) fs.unlinkSync(src);
          else fs.renameSync(src, dst);
        }
      }
      fs.renameSync(this._file, `${this._file}.1`);
    } catch (err) {
      console.error('[logger] rotation failed:', err.message);
    }
  }
}

function redact(str) {
  return str.replace(SECRET_PATTERN, '$1***REDACTED***');
}

module.exports = new Logger();

'use strict';

/**
 * Local backup/restore. A backup is a timestamped folder (optionally zipped)
 * containing:
 *   - meetingscribe.db          (via storage.backupDatabaseTo — SQLite's
 *                                 online backup API, so it is consistent
 *                                 even if taken mid-recording)
 *   - settings.json
 *   - recordings/               (only if the user opts in — this can be large)
 *   - manifest.json             (schema version, app version, created_at,
 *                                 whether recordings were included)
 *
 * Restoring never overwrites the live database in place while the app is
 * running; it always takes a fresh safety backup first, then requires an
 * app restart to swap the files, which is far safer than trying to hot-swap
 * an open SQLite connection.
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const extractZip = require('extract-zip');
const logger = require('./logger');
const storage = require('./storage');
const settingsStore = require('./settingsStore');

function backupsDir(userDataPath) {
  const dir = path.join(userDataPath, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function zipDirectory(sourceDir, destinationZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destinationZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function createBackup({ userDataPath, recordingsDir, includeRecordings = false, appVersion = '0.0.0', zip = true }) {
  const dir = backupsDir(userDataPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workDir = path.join(dir, `backup-${stamp}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    await storage.backupDatabaseTo(path.join(workDir, 'meetingscribe.db'));
    settingsStore.exportToFile(path.join(workDir, 'settings.json'));

    if (includeRecordings && fs.existsSync(recordingsDir)) {
      copyDirRecursive(recordingsDir, path.join(workDir, 'recordings'));
    }

    const manifest = {
      createdAt: Date.now(),
      appVersion,
      includedRecordings: includeRecordings,
    };
    fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    if (!zip) {
      return { path: workDir, manifest };
    }

    const zipPath = `${workDir}.zip`;
    await zipDirectory(workDir, zipPath);
    fs.rmSync(workDir, { recursive: true, force: true });

    logger.info('backup', 'Backup created', { zipPath, includeRecordings });
    return { path: zipPath, manifest };
  } catch (err) {
    logger.error('backup', 'Backup failed', { error: err.message });
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 1 });
    throw err;
  }
}

function listBackups(userDataPath) {
  const dir = backupsDir(userDataPath);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip') || fs.statSync(path.join(dir, f)).isDirectory())
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, sizeBytes: stat.isDirectory() ? null : stat.size, createdAt: stat.birthtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Restoring is intentionally a two-step, restart-required process:
 * 1. Extract the chosen backup into a staging directory and validate its
 *    manifest.
 * 2. Write a "pending restore" marker file that main.js checks on next boot,
 *    before the database is opened, and perform the actual file swap there
 *    (with the DB connection closed / not yet open), taking a safety backup
 *    of the current state first.
 */
async function stageRestore({ userDataPath, backupPath }) {
  const stagingDir = path.join(userDataPath, 'pending-restore');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  if (backupPath.endsWith('.zip')) {
    await extractZip(backupPath, { dir: stagingDir });
  } else {
    copyDirRecursive(backupPath, stagingDir);
  }

  const manifestPath = path.join(stagingDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error('Selected backup is missing manifest.json and cannot be verified.');
  }
  if (!fs.existsSync(path.join(stagingDir, 'meetingscribe.db'))) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error('Selected backup does not contain a database file.');
  }

  const markerPath = path.join(userDataPath, 'RESTORE_PENDING');
  fs.writeFileSync(markerPath, stagingDir, 'utf8');
  logger.warn('backup', 'Restore staged; will be applied on next launch', { backupPath });
  return { stagingDir, requiresRestart: true };
}

/** Called very early in main.js, before storage.open(). */
function applyPendingRestoreIfAny(userDataPath) {
  const markerPath = path.join(userDataPath, 'RESTORE_PENDING');
  if (!fs.existsSync(markerPath)) return false;

  const stagingDir = fs.readFileSync(markerPath, 'utf8').trim();
  const dataDir = path.join(userDataPath, 'data');

  // Safety net: snapshot whatever is currently live before overwriting it.
  const safetyDir = path.join(userDataPath, `pre-restore-safety-${Date.now()}`);
  if (fs.existsSync(dataDir)) copyDirRecursive(dataDir, safetyDir);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(path.join(stagingDir, 'meetingscribe.db'), path.join(dataDir, 'meetingscribe.db'));

  const stagedSettings = path.join(stagingDir, 'settings.json');
  if (fs.existsSync(stagedSettings)) {
    fs.copyFileSync(stagedSettings, path.join(userDataPath, 'settings.json'));
  }

  const stagedRecordings = path.join(stagingDir, 'recordings');
  if (fs.existsSync(stagedRecordings)) {
    copyDirRecursive(stagedRecordings, path.join(userDataPath, 'recordings'));
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(markerPath, { force: true });

  logger.warn('backup', 'Restore applied on boot', { safetySnapshot: safetyDir });
  return true;
}

module.exports = { createBackup, listBackups, stageRestore, applyPendingRestoreIfAny };

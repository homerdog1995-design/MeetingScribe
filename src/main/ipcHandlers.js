'use strict';

const { ipcMain, app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const logger = require('./logger');
const storage = require('./storage');
const settingsStore = require('./settingsStore');
const modelDetection = require('./modelDetection');
const backup = require('./backup');
const summaryEngine = require('./summaryEngine');
const exportEngine = require('./exportEngine');
const security = require('./security');
const shortcuts = require('./shortcuts');

const WHISPER_TIMESTAMP_LINE = /\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)/;
const EXEC_TIMEOUT_MS = 120000; // a single short chunk should never legitimately take 2 minutes
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

function toMs(h, m, s, ms) {
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms);
}

function parseWhisperCppStdout(stdout, chunkStartMs) {
  const segments = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(WHISPER_TIMESTAMP_LINE);
    if (!match) continue;
    const [, h1, m1, s1, ms1, h2, m2, s2, ms2, rawText] = match;
    let text = rawText.trim();
    const speakerTurn = /\[SPEAKER_TURN\]/i.test(text);
    if (speakerTurn) text = text.replace(/\[SPEAKER_TURN\]/gi, '').trim();
    if (!text) continue;
    segments.push({
      startMs: chunkStartMs + toMs(h1, m1, s1, ms1),
      endMs: chunkStartMs + toMs(h2, m2, s2, ms2),
      text,
      speakerTurn,
      confidence: null,
    });
  }
  return segments;
}

function writeTempWav(arrayBuffer) {
  const tempPath = path.join(os.tmpdir(), `meetingscribe-chunk-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));
  return tempPath;
}

function cleanupTemp(tempPath) {
  fs.rm(tempPath, { force: true }, () => {});
}

function registerAll({ getMainWindow, recordingsDir, appVersion, whisperWasmAssetsDir }) {
  // --- Storage -------------------------------------------------------------
  ipcMain.handle('storage:createMeeting', (_e, args) => storage.createMeeting(args));
  ipcMain.handle('storage:updateMeeting', (_e, id, patch) => storage.updateMeeting(id, patch));
  ipcMain.handle('storage:getMeeting', (_e, id) => storage.getMeeting(id));
  ipcMain.handle('storage:listMeetings', (_e, query) => storage.listMeetings(query));
  ipcMain.handle('storage:deleteMeeting', (_e, id) => {
    const meeting = storage.deleteMeeting(id);
    if (meeting?.recording_path) {
      const dir = path.dirname(meeting.recording_path);
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
    return { ok: true };
  });
  ipcMain.handle('storage:archiveMeeting', (_e, id, archived) => storage.archiveMeeting(id, archived));
  ipcMain.handle('storage:duplicateMeeting', (_e, id) => storage.duplicateMeeting(id));
  ipcMain.handle('storage:addTranscriptSegments', (_e, meetingId, segments) => storage.addTranscriptSegments(meetingId, segments));
  ipcMain.handle('storage:updateTranscriptSegment', (_e, meetingId, segmentId, patch) => storage.updateTranscriptSegment(meetingId, segmentId, patch));
  ipcMain.handle('storage:deleteTranscriptSegment', (_e, meetingId, segmentId) => storage.deleteTranscriptSegment(meetingId, segmentId));
  ipcMain.handle('storage:mergeSegments', (_e, meetingId, a, b) => storage.mergeSegments(meetingId, a, b));
  ipcMain.handle('storage:splitSegment', (_e, meetingId, segmentId, charIndex, timeMs) => storage.splitSegment(meetingId, segmentId, charIndex, timeMs));
  ipcMain.handle('storage:upsertSpeaker', (_e, meetingId, speaker) => storage.upsertSpeaker(meetingId, speaker));
  ipcMain.handle('storage:getSpeakerStats', (_e, meetingId) => storage.getSpeakerStats(meetingId));
  ipcMain.handle('storage:setTags', (_e, meetingId, tags) => storage.setTags(meetingId, tags));
  ipcMain.handle('storage:listAllTags', () => storage.listAllTags());
  ipcMain.handle('storage:addBookmark', (_e, meetingId, bookmark) => storage.addBookmark(meetingId, bookmark));
  ipcMain.handle('storage:deleteBookmark', (_e, meetingId, bookmarkId) => storage.deleteBookmark(meetingId, bookmarkId));
  ipcMain.handle('storage:addComment', (_e, meetingId, comment) => storage.addComment(meetingId, comment));
  ipcMain.handle('storage:resolveComment', (_e, meetingId, commentId, resolved) => storage.resolveComment(meetingId, commentId, resolved));
  ipcMain.handle('storage:deleteComment', (_e, meetingId, commentId) => storage.deleteComment(meetingId, commentId));
  ipcMain.handle('storage:saveTranscriptSnapshot', (_e, meetingId, note) => storage.saveTranscriptSnapshot(meetingId, note));
  ipcMain.handle('storage:listTranscriptVersions', (_e, meetingId) => storage.listTranscriptVersions(meetingId));
  ipcMain.handle('storage:restoreTranscriptVersion', (_e, meetingId, versionId) => storage.restoreTranscriptVersion(meetingId, versionId));
  ipcMain.handle('storage:getStorageStats', () => storage.getStorageStats(recordingsDir));

  // --- Recording -------------------------------------------------------------
  ipcMain.handle('recording:createSession', (_e, meetingId) => {
    const chunkDir = path.join(recordingsDir, meetingId);
    fs.mkdirSync(chunkDir, { recursive: true });
    const sessionId = storage.createRecordingSession(meetingId, chunkDir);
    return { sessionId, chunkDir };
  });

  ipcMain.handle('recording:saveMasterChunk', (_e, sessionId, meetingId, chunkIndex, arrayBuffer) => {
    const chunkDir = path.join(recordingsDir, meetingId);
    fs.mkdirSync(chunkDir, { recursive: true });
    const chunkPath = path.join(chunkDir, `chunk_${String(chunkIndex).padStart(6, '0')}.webm`);
    fs.writeFileSync(chunkPath, Buffer.from(arrayBuffer));
    storage.heartbeatRecordingSession(sessionId, chunkIndex, 'recording');
    return { ok: true };
  });

  ipcMain.handle('recording:setSessionStatus', (_e, sessionId, lastChunkIndex, status) => {
    storage.heartbeatRecordingSession(sessionId, lastChunkIndex, status);
    return { ok: true };
  });

  ipcMain.handle('recording:finalize', (_e, sessionId, meetingId, durationMs) => {
    const chunkDir = path.join(recordingsDir, meetingId);
    const finalPath = concatenateChunks(chunkDir, meetingId);
    storage.finalizeRecordingSession(sessionId);
    storage.updateMeeting(meetingId, { recording_path: finalPath, recording_format: 'webm', status: 'recorded', duration_ms: durationMs });
    return { finalPath };
  });

  ipcMain.handle('recording:getUnfinishedSessions', () => storage.getUnfinishedSessions());
  ipcMain.handle('recording:discardSession', (_e, sessionId) => storage.discardSession(sessionId));

  ipcMain.handle('recording:recoverSession', (_e, session) => {
    const finalPath = concatenateChunks(session.chunk_dir, session.meeting_id);
    storage.finalizeRecordingSession(session.id);
    storage.updateMeeting(session.meeting_id, { recording_path: finalPath, recording_format: 'webm', status: 'recovered' });
    return { finalPath };
  });

  // --- Transcription engines --------------------------------------------------
  ipcMain.handle('transcription:getAvailableEngines', async () => modelDetection.detectAll(settingsStore.get(), whisperWasmAssetsDir));

  ipcMain.handle('transcription:runWhisperCpp', async (_e, { arrayBuffer, chunkStartMs }) => {
    const settings = settingsStore.get();
    const { binaryPath, modelPath, tinydiarize, language } = settings.engines.whisperCpp;
    if (!binaryPath || !modelPath) throw new Error('whisper.cpp is not configured (binary or model path missing).');

    const wavPath = writeTempWav(arrayBuffer);
    try {
      const args = ['-m', modelPath, '-f', wavPath, '-l', language || 'auto'];
      if (tinydiarize) args.push('-tdrz');

      const stdout = await new Promise((resolve, reject) => {
        execFile(binaryPath, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true }, (error, out, stderr) => {
          if (error) reject(new Error(`whisper-cli failed: ${stderr || error.message}`));
          else resolve(out);
        });
      });

      return parseWhisperCppStdout(stdout, chunkStartMs);
    } finally {
      cleanupTemp(wavPath);
    }
  });

  ipcMain.handle('transcription:runFasterWhisper', async (_e, { arrayBuffer, chunkStartMs }) => {
    const settings = settingsStore.get();
    const { pythonPath, modelSize, device } = settings.engines.fasterWhisper;
    const wavPath = writeTempWav(arrayBuffer);
    const bridgeScript = path.join(app.getAppPath(), 'scripts', 'faster_whisper_bridge.py');

    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile(pythonPath || 'python3', [bridgeScript, wavPath, modelSize, device, settings.language || 'auto'],
          { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true },
          (error, out, stderr) => {
            if (error) reject(new Error(`faster-whisper bridge failed: ${stderr || error.message}`));
            else resolve(out);
          });
      });

      const segments = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.error) throw new Error(parsed.error);
        segments.push({
          startMs: chunkStartMs + Math.round(parsed.start * 1000),
          endMs: chunkStartMs + Math.round(parsed.end * 1000),
          text: parsed.text,
          confidence: parsed.confidence,
          speakerTurn: false,
        });
      }
      return segments;
    } finally {
      cleanupTemp(wavPath);
    }
  });

  // --- Summaries ---------------------------------------------------------
  ipcMain.handle('summary:generate', async (_e, meetingId) => {
    const meeting = storage.getMeeting(meetingId);
    if (!meeting) throw new Error('Meeting not found');
    const settings = settingsStore.get();
    const result = await summaryEngine.generateSummary(meeting, settings);
    return storage.saveSummary(meetingId, result.sections, { source: result.source, model: result.model });
  });

  // --- Model / engine detection --------------------------------------------
  ipcMain.handle('models:detect', async () => modelDetection.detectAll(settingsStore.get(), whisperWasmAssetsDir));

  // --- Export --------------------------------------------------------------
  ipcMain.handle('export:listFormats', () => exportEngine.listFormats());
  ipcMain.handle('export:exportMeeting', async (_e, meetingId, formatKey) => {
    const meeting = storage.getMeeting(meetingId);
    if (!meeting) throw new Error('Meeting not found');
    return exportEngine.exportMeeting(getMainWindow(), meeting, formatKey);
  });
  ipcMain.handle('export:revealInFolder', (_e, filePath) => exportEngine.revealInFolder(filePath));

  // --- Backups ---------------------------------------------------------------
  ipcMain.handle('backup:createNow', async (_e, options) => backup.createBackup({
    userDataPath: app.getPath('userData'),
    recordingsDir,
    appVersion,
    includeRecordings: !!options?.includeRecordings,
  }));
  ipcMain.handle('backup:list', () => backup.listBackups(app.getPath('userData')));
  ipcMain.handle('backup:stageRestore', async (_e, backupPath) => backup.stageRestore({ userDataPath: app.getPath('userData'), backupPath }));

  // --- Settings ------------------------------------------------------------
  ipcMain.handle('settings:get', () => settingsStore.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const updated = settingsStore.set(patch);
    if (patch.engines?.ollama?.port) security.setAllowedLoopbackPort(patch.engines.ollama.port, true);
    if (patch.engines?.llamaCpp?.port) security.setAllowedLoopbackPort(patch.engines.llamaCpp.port, true);
    if (patch.engines?.webSpeech?.enabled !== undefined) security.setWebSpeechExternalAccess(patch.engines.webSpeech.enabled);
    if (patch.hotkeys) {
      const { failures } = shortcuts.registerAll(getMainWindow(), updated.hotkeys);
      if (failures.length) getMainWindow()?.webContents.send('app:shortcutFailures', failures);
    }
    return updated;
  });
  ipcMain.handle('settings:reset', () => settingsStore.resetToDefaults());
  ipcMain.handle('settings:exportToFile', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), { defaultPath: 'meetingscribe-settings.json' });
    if (canceled || !filePath) return { canceled: true };
    settingsStore.exportToFile(filePath);
    return { canceled: false, filePath };
  });
  ipcMain.handle('settings:importFromFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (canceled || !filePaths[0]) return { canceled: true };
    return { canceled: false, settings: settingsStore.importFromFile(filePaths[0]) };
  });
  ipcMain.handle('settings:chooseStorageLocation', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), { properties: ['openDirectory', 'createDirectory'] });
    if (canceled || !filePaths[0]) return { canceled: true };
    return { canceled: false, path: filePaths[0] };
  });

  // --- System / diagnostics -------------------------------------------------
  ipcMain.handle('system:getInfo', () => ({
    platform: process.platform,
    arch: process.arch,
    appVersion,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    userDataPath: app.getPath('userData'),
    whisperWasmAssetsDir,
  }));
  ipcMain.handle('system:openPath', (_e, targetPath) => shell.openPath(targetPath));
  ipcMain.handle('system:revealInFolder', (_e, targetPath) => shell.showItemInFolder(targetPath));
  ipcMain.handle('system:getLogs', () => logger.readTail());
  ipcMain.handle('system:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
}

/**
 * Concatenates ordered chunk_*.webm files into a single playable file.
 * Per the MediaRecorder spec, sequential timesliced blobs from one
 * continuous recording session reconstruct a valid file when concatenated
 * in original order — no re-encoding or container repair is required.
 */
function concatenateChunks(chunkDir, meetingId) {
  const files = fs.readdirSync(chunkDir)
    .filter((f) => f.startsWith('chunk_') && f.endsWith('.webm'))
    .sort();

  const finalPath = path.join(chunkDir, `${meetingId}.webm`);
  const tempFinal = `${finalPath}.tmp`;
  const outStream = fs.openSync(tempFinal, 'w');
  try {
    for (const file of files) {
      const data = fs.readFileSync(path.join(chunkDir, file));
      fs.writeSync(outStream, data);
    }
  } finally {
    fs.closeSync(outStream);
  }

  fs.renameSync(tempFinal, finalPath);
  files.forEach((f) => fs.rm(path.join(chunkDir, f), { force: true }, () => {}));
  return finalPath;
}

module.exports = { registerAll };

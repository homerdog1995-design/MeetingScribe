'use strict';

/**
 * The only bridge between the sandboxed renderer and the main process.
 * Every function here is a thin wrapper around ipcRenderer.invoke — the
 * renderer never receives ipcRenderer itself, so it cannot subscribe to or
 * send on arbitrary channels beyond what is explicitly exposed below.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { EVENT_NAMES } = require('./shortcuts');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  storage: {
    createMeeting: (args) => invoke('storage:createMeeting', args),
    updateMeeting: (id, patch) => invoke('storage:updateMeeting', id, patch),
    getMeeting: (id) => invoke('storage:getMeeting', id),
    listMeetings: (query) => invoke('storage:listMeetings', query),
    deleteMeeting: (id) => invoke('storage:deleteMeeting', id),
    archiveMeeting: (id, archived) => invoke('storage:archiveMeeting', id, archived),
    duplicateMeeting: (id) => invoke('storage:duplicateMeeting', id),
    addTranscriptSegments: (meetingId, segments) => invoke('storage:addTranscriptSegments', meetingId, segments),
    updateTranscriptSegment: (meetingId, segmentId, patch) => invoke('storage:updateTranscriptSegment', meetingId, segmentId, patch),
    deleteTranscriptSegment: (meetingId, segmentId) => invoke('storage:deleteTranscriptSegment', meetingId, segmentId),
    mergeSegments: (meetingId, a, b) => invoke('storage:mergeSegments', meetingId, a, b),
    splitSegment: (meetingId, segmentId, charIndex, timeMs) => invoke('storage:splitSegment', meetingId, segmentId, charIndex, timeMs),
    upsertSpeaker: (meetingId, speaker) => invoke('storage:upsertSpeaker', meetingId, speaker),
    getSpeakerStats: (meetingId) => invoke('storage:getSpeakerStats', meetingId),
    setTags: (meetingId, tags) => invoke('storage:setTags', meetingId, tags),
    listAllTags: () => invoke('storage:listAllTags'),
    addBookmark: (meetingId, bookmark) => invoke('storage:addBookmark', meetingId, bookmark),
    deleteBookmark: (meetingId, bookmarkId) => invoke('storage:deleteBookmark', meetingId, bookmarkId),
    addComment: (meetingId, comment) => invoke('storage:addComment', meetingId, comment),
    resolveComment: (meetingId, commentId, resolved) => invoke('storage:resolveComment', meetingId, commentId, resolved),
    deleteComment: (meetingId, commentId) => invoke('storage:deleteComment', meetingId, commentId),
    saveTranscriptSnapshot: (meetingId, note) => invoke('storage:saveTranscriptSnapshot', meetingId, note),
    listTranscriptVersions: (meetingId) => invoke('storage:listTranscriptVersions', meetingId),
    restoreTranscriptVersion: (meetingId, versionId) => invoke('storage:restoreTranscriptVersion', meetingId, versionId),
    getStorageStats: () => invoke('storage:getStorageStats'),
  },

  recording: {
    createSession: (meetingId) => invoke('recording:createSession', meetingId),
    saveMasterChunk: (sessionId, meetingId, chunkIndex, arrayBuffer) => invoke('recording:saveMasterChunk', sessionId, meetingId, chunkIndex, arrayBuffer),
    setSessionStatus: (sessionId, lastChunkIndex, status) => invoke('recording:setSessionStatus', sessionId, lastChunkIndex, status),
    finalize: (sessionId, meetingId, durationMs) => invoke('recording:finalize', sessionId, meetingId, durationMs),
    getUnfinishedSessions: () => invoke('recording:getUnfinishedSessions'),
    discardSession: (sessionId) => invoke('recording:discardSession', sessionId),
    recoverSession: (session) => invoke('recording:recoverSession', session),
  },

  transcription: {
    getAvailableEngines: () => invoke('transcription:getAvailableEngines'),
    runWhisperCpp: (payload) => invoke('transcription:runWhisperCpp', payload),
    runFasterWhisper: (payload) => invoke('transcription:runFasterWhisper', payload),
  },

  summary: {
    generate: (meetingId) => invoke('summary:generate', meetingId),
  },

  models: {
    detect: () => invoke('models:detect'),
  },

  export: {
    listFormats: () => invoke('export:listFormats'),
    exportMeeting: (meetingId, formatKey) => invoke('export:exportMeeting', meetingId, formatKey),
    revealInFolder: (filePath) => invoke('export:revealInFolder', filePath),
  },

  backup: {
    createNow: (options) => invoke('backup:createNow', options),
    list: () => invoke('backup:list'),
    stageRestore: (backupPath) => invoke('backup:stageRestore', backupPath),
  },

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    reset: () => invoke('settings:reset'),
    exportToFile: () => invoke('settings:exportToFile'),
    importFromFile: () => invoke('settings:importFromFile'),
    chooseStorageLocation: () => invoke('settings:chooseStorageLocation'),
  },

  system: {
    getInfo: () => invoke('system:getInfo'),
    openPath: (targetPath) => invoke('system:openPath', targetPath),
    revealInFolder: (targetPath) => invoke('system:revealInFolder', targetPath),
    getLogs: () => invoke('system:getLogs'),
    relaunch: () => invoke('system:relaunch'),
  },

  shortcuts: {
    onStartRecording: (cb) => subscribe(EVENT_NAMES.startRecording, cb),
    onPauseRecording: (cb) => subscribe(EVENT_NAMES.pauseRecording, cb),
    onStopRecording: (cb) => subscribe(EVENT_NAMES.stopRecording, cb),
    onBookmark: (cb) => subscribe(EVENT_NAMES.bookmark, cb),
    onSearch: (cb) => subscribe(EVENT_NAMES.search, cb),
    onNewMeeting: (cb) => subscribe(EVENT_NAMES.newMeeting, cb),
  },

  app: {
    onUnfinishedSessions: (cb) => subscribe('app:unfinishedSessions', cb),
    onShortcutRegistrationFailures: (cb) => subscribe('app:shortcutFailures', cb),
  },

  /**
   * Desktop/system-audio capture support. desktopCapturer.getSources cannot
   * be called from the renderer directly under contextIsolation, so it is
   * proxied here; the renderer still performs the actual
   * navigator.mediaDevices.getDisplayMedia() call itself (that API is only
   * available in the renderer/DOM context).
   */
  desktopCapture: {
    listSources: () => invoke('desktopCapture:listSources'),
    selectSource: (sourceId, withAudio) => invoke('desktopCapture:selectSource', sourceId, withAudio),
    clearSelection: () => invoke('desktopCapture:clearSelection'),
  },
});

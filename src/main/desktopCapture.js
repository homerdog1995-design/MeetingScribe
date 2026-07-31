'use strict';

/**
 * System-audio capture in Electron works through two cooperating pieces:
 *
 *  1. `session.defaultSession.setDisplayMediaRequestHandler` (main process)
 *     — Electron has no built-in OS picker UI (unlike Chrome), so the app
 *     must supply its own list of capturable sources and hand one back
 *     synchronously when the renderer calls getDisplayMedia().
 *  2. `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })`
 *     (renderer process, see js/audio.js) — must request `video: true` even
 *     when only audio is wanted (a documented Chromium quirk for the
 *     loopback path); the renderer immediately stops the returned video
 *     track once it has the audio track it actually wants.
 *
 * Passing `audio: 'loopback'` in the handler's callback captures the
 * system's full audio mix (see ARCHITECTURE.md §10 for the platform
 * limitation this implies), independent of which window/screen was chosen
 * for the video portion of the request.
 */

const { ipcMain, desktopCapturer, session } = require('electron');
const logger = require('./logger');

let pendingSelection = null; // { sourceId, withAudio } | null

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      let chosen = sources[0];

      if (pendingSelection?.sourceId) {
        const match = sources.find((s) => s.id === pendingSelection.sourceId);
        if (match) chosen = match;
      }

      if (!chosen) {
        logger.warn('desktopCapture', 'No capturable source available for system-audio request');
        callback({});
        return;
      }

      callback({
        video: chosen,
        audio: pendingSelection?.withAudio ? 'loopback' : undefined,
      });
    } catch (err) {
      logger.error('desktopCapture', 'setDisplayMediaRequestHandler failed', { error: err.message });
      callback({});
    }
  }, { useSystemPicker: false });
}

function registerHandlers() {
  ipcMain.handle('desktopCapture:listSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180},
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
      appIconDataUrl: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
  });

  ipcMain.handle('desktopCapture:selectSource', (_e, sourceId, withAudio) => {
    pendingSelection = { sourceId, withAudio: !!withAudio };
    return { ok: true };
  });

  ipcMain.handle('desktopCapture:clearSelection', () => {
    pendingSelection = null;
    return { ok: true };
  });
}

module.exports = { installDisplayMediaHandler, registerHandlers };

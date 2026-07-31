'use strict';

/**
 * Registers OS-wide global shortcuts (work even when MeetingScribe is not
 * the focused window) and forwards them to the renderer as IPC events. The
 * renderer never touches Electron's globalShortcut module directly — it
 * only listens for the events named below via the preload-exposed API.
 *
 * Electron's globalShortcut.register() silently returns `false` if another
 * application already owns the requested accelerator (this is documented
 * Electron behaviour, not a bug here); we surface that as a warning the
 * Settings panel can display, rather than failing silently.
 */

const { globalShortcut } = require('electron');
const logger = require('./logger');

const EVENT_NAMES = {
  startRecording: 'shortcut:recording:start',
  pauseRecording: 'shortcut:recording:pause',
  stopRecording: 'shortcut:recording:stop',
  bookmark: 'shortcut:recording:bookmark',
  search: 'shortcut:app:search',
  newMeeting: 'shortcut:app:newMeeting',
};

let registeredWindow = null;

function registerAll(browserWindow, hotkeys) {
  unregisterAll();
  registeredWindow = browserWindow;
  const failures = [];

  for (const [action, accelerator] of Object.entries(hotkeys)) {
    const eventName = EVENT_NAMES[action];
    if (!eventName || !accelerator) continue;

    const success = globalShortcut.register(accelerator, () => {
      if (registeredWindow && !registeredWindow.isDestroyed()) {
        registeredWindow.webContents.send(eventName);
        if (registeredWindow.isMinimized()) registeredWindow.restore();
        registeredWindow.focus();
      }
    });

    if (!success) {
      failures.push({ action, accelerator });
      logger.warn('shortcuts', `Failed to register global shortcut (likely owned by another app): ${accelerator}`, { action });
    }
  }

  return { failures };
}

function unregisterAll() {
  globalShortcut.unregisterAll();
}

module.exports = { registerAll, unregisterAll, EVENT_NAMES };

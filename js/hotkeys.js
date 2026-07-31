'use strict';

/**
 * hotkeys.js — replaces main/shortcuts.js (Electron's `globalShortcut` API).
 *
 * THIS IS A REAL, UNAVOIDABLE DEGRADATION, NOT JUST A CODE CHANGE: Electron's
 * global shortcuts fired even when the app was in the background or
 * unfocused — that's what "global" meant. No browser can do this; a web
 * page only ever receives keyboard events while its own tab is focused and
 * visible, by design (a page listening to keystrokes typed into other
 * applications would be a serious security/privacy hole). So these hotkeys
 * now only work while MeetingScribe's tab has focus. settings.js explains
 * this in the Hotkeys section rather than leaving it a silent surprise.
 */

const registrations = new Map(); // normalized accelerator -> Set<callback>

function normalizeAccelerator(accelerator) {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') return 'Control';
      if (lower === 'cmd' || lower === 'command' || lower === 'meta') return 'Meta';
      if (lower === 'option' || lower === 'alt') return 'Alt';
      if (lower === 'shift') return 'Shift';
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1).toLowerCase();
    })
    .sort()
    .join('+');
}

function eventToAccelerator(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) parts.push(key);
  return parts.sort().join('+');
}

document.addEventListener('keydown', (event) => {
  // Don't hijack ordinary typing — only fire when a real modifier is held,
  // matching how these were always defined (e.g. "Control+Shift+R").
  if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
  const callbacks = registrations.get(eventToAccelerator(event));
  if (callbacks?.size) {
    event.preventDefault();
    callbacks.forEach((cb) => cb());
  }
});

/** Registers a callback for an accelerator string like "Control+Shift+R". Returns an unsubscribe function. */
export function registerHotkey(accelerator, callback) {
  const normalized = normalizeAccelerator(accelerator);
  if (!registrations.has(normalized)) registrations.set(normalized, new Set());
  registrations.get(normalized).add(callback);
  return () => registrations.get(normalized)?.delete(callback);
}

/**
 * Convenience for hotkeys whose accelerator can change live in Settings:
 * registers immediately from the current settings value, and re-registers
 * whenever settings change. `subscribeToSettings(cb)` should call `cb` once
 * immediately with the current settings and again on every future change
 * (this matches state.js's `store.subscribe` behavior).
 */
export function bindConfigurableHotkey(subscribeToSettings, getAccelerator, callback) {
  let unsubscribe = null;
  subscribeToSettings((settings) => {
    unsubscribe?.();
    unsubscribe = null;
    const accelerator = getAccelerator(settings);
    if (accelerator) unsubscribe = registerHotkey(accelerator, callback);
  });
}

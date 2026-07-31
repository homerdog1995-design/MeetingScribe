'use strict';

import { store } from './state.js';
import { qs, formatTimestamp } from './utils.js';

let currentDurationMs = 0;

export function initPlayback() {
  const audio = qs('#playback-audio');
  const toggleButton = qs('#btn-playback-toggle');
  const speedSelect = qs('#playback-speed');

  toggleButton.addEventListener('click', () => {
    if (!audio.src) return;
    if (audio.paused) audio.play(); else audio.pause();
  });
  speedSelect.addEventListener('change', () => { audio.playbackRate = Number(speedSelect.value); });

  audio.addEventListener('play', () => { toggleButton.textContent = '⏸'; });
  audio.addEventListener('pause', () => { toggleButton.textContent = '▶'; });
  audio.addEventListener('ended', () => { toggleButton.textContent = '▶'; });

  audio.addEventListener('loadedmetadata', () => {
    currentDurationMs = (audio.duration || 0) * 1000;
    updateTimeLabel(audio.currentTime * 1000);
  });
  audio.addEventListener('timeupdate', () => {
    updateTimeLabel(audio.currentTime * 1000);
    document.dispatchEvent(new CustomEvent('playback-timeupdate', {
      detail: { currentMs: audio.currentTime * 1000, durationMs: currentDurationMs },
    }));
  });

  store.subscribe('currentMeeting', (meeting) => loadMeetingAudio(meeting));
}

function loadMeetingAudio(meeting) {
  const audio = qs('#playback-audio');
  qs('#btn-playback-toggle').textContent = '▶';

  if (!meeting?.recording_path) {
    audio.removeAttribute('src');
    audio.load();
    currentDurationMs = 0;
    updateTimeLabel(0);
    return;
  }

  audio.src = toFileUrl(meeting.recording_path);
  audio.playbackRate = Number(qs('#playback-speed').value || '1');
}

function updateTimeLabel(currentMs) {
  qs('#playback-time').textContent = `${formatTimestamp(currentMs)} / ${formatTimestamp(currentDurationMs)}`;
}

export function seekToMs(ms) {
  const audio = qs('#playback-audio');
  if (!audio.src) return;
  audio.currentTime = Math.max(0, ms / 1000);
}

/** Converts an absolute filesystem path (as stored by main/storage.js) into a file:// URL the renderer can load directly. */
export function toFileUrl(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${withLeadingSlash}`;
}

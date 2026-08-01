'use strict';

import { store } from './state.js';
import { storage } from './storage.js';
import { qs, formatTimestamp } from './utils.js';

/**
 * CHANGED FROM THE ELECTRON VERSION: recordings used to be files on disk,
 * loaded via a `file://` URL built from an absolute path. Now the audio
 * lives as a Blob inside IndexedDB (see storage.js), so playback instead
 * asks storage.getRecordingUrl() for an object URL (URL.createObjectURL)
 * pointing at that Blob. Object URLs must be explicitly revoked when no
 * longer needed or they leak memory for the life of the page — tracked via
 * currentObjectUrl below.
 */

let currentDurationMs = 0;
let currentObjectUrl = null;

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
    // audio.duration is unreliable here: MediaRecorder-produced WebM Blobs
    // have no proper duration header (they're recorded live, without
    // knowing the final length ahead of time), so Chrome reports Infinity
    // until something forces a recalculation. The meeting's own duration_ms
    // (tracked accurately via the recording timer, independent of the audio
    // container's metadata) is the authoritative source instead.
    const meeting = store.get('currentMeeting');
    if (meeting?.duration_ms) {
      currentDurationMs = meeting.duration_ms;
      updateTimeLabel(audio.currentTime * 1000);
    } else if (Number.isFinite(audio.duration)) {
      currentDurationMs = audio.duration * 1000;
      updateTimeLabel(audio.currentTime * 1000);
    } else {
      // No stored duration to fall back on — force Chrome to recompute a
      // real value by seeking near the end, then back to the start. This
      // is the standard workaround for this exact MediaRecorder/Blob quirk.
      const forceDurationRecalc = () => {
        if (Number.isFinite(audio.duration)) {
          currentDurationMs = audio.duration * 1000;
          audio.currentTime = 0;
          audio.removeEventListener('timeupdate', forceDurationRecalc);
          updateTimeLabel(0);
        }
      };
      audio.addEventListener('timeupdate', forceDurationRecalc);
      audio.currentTime = 1e7;
    }
  });
  audio.addEventListener('timeupdate', () => {
    updateTimeLabel(audio.currentTime * 1000);
    document.dispatchEvent(new CustomEvent('playback-timeupdate', {
      detail: { currentMs: audio.currentTime * 1000, durationMs: currentDurationMs },
    }));
  });

  store.subscribe('currentMeeting', (meeting) => loadMeetingAudio(meeting));
}

async function loadMeetingAudio(meeting) {
  const audio = qs('#playback-audio');
  qs('#btn-playback-toggle').textContent = '▶';

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  if (!meeting?.recording_path) {
    audio.removeAttribute('src');
    audio.load();
    currentDurationMs = 0;
    updateTimeLabel(0);
    return;
  }

  currentObjectUrl = await storage.getRecordingUrl(meeting);
  audio.src = currentObjectUrl;
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

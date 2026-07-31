'use strict';

import { store } from './state.js';
import { qs, el, formatTimestamp } from './utils.js';
import { seekToMs, toFileUrl } from './playback.js';

let audioContext = null;
let lastDecodedMeetingId = null;

export function initTimeline() {
  store.subscribe('currentMeeting', (meeting) => {
    if (meeting) loadTimeline(meeting);
  });

  document.addEventListener('playback-timeupdate', ({ detail }) => {
    updatePlayhead(detail.currentMs, detail.durationMs);
  });

  qs('#timeline-container').addEventListener('click', (event) => {
    const meeting = store.get('currentMeeting');
    if (!meeting?.duration_ms) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    seekToMs(ratio * meeting.duration_ms);
  });
}

async function loadTimeline(meeting) {
  renderBookmarkMarkers(meeting);

  if (!meeting.recording_path) {
    clearCanvas();
    lastDecodedMeetingId = null;
    return;
  }

  // Decoding a full recording into memory is the expensive part of this
  // feature — skip re-decoding if we already drew the waveform for this
  // exact meeting (store.currentMeeting is refreshed frequently for
  // unrelated reasons, e.g. after every transcript edit).
  if (lastDecodedMeetingId === meeting.id) return;
  lastDecodedMeetingId = meeting.id;

  try {
    const response = await fetch(toFileUrl(meeting.recording_path));
    const arrayBuffer = await response.arrayBuffer();
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    drawWaveform(audioBuffer);
  } catch (error) {
    console.error('Failed to decode recording for waveform display:', error);
    clearCanvas();
  }
}

function clearCanvas() {
  const canvas = qs('#waveform-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawWaveform(audioBuffer) {
  const canvas = qs('#waveform-canvas');
  const container = qs('#timeline-container');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const channelData = audioBuffer.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(channelData.length / canvas.width));
  const midY = canvas.height / 2;

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--color-accent').trim() || '#3a5ce0';
  for (let x = 0; x < canvas.width; x++) {
    let min = 1.0;
    let max = -1.0;
    const start = x * samplesPerPixel;
    const end = Math.min(channelData.length, start + samplesPerPixel);
    for (let i = start; i < end; i++) {
      const value = channelData[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const y1 = midY + min * midY;
    const y2 = midY + max * midY;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function renderBookmarkMarkers(meeting) {
  const container = qs('#timeline-markers');
  container.innerHTML = '';
  if (!meeting.duration_ms) return;

  meeting.bookmarks.forEach((bookmark) => {
    const marker = el('div', {
      class: 'timeline-bookmark-marker',
      title: `${formatTimestamp(bookmark.time_ms)}${bookmark.label ? ` — ${bookmark.label}` : ''}`,
    });
    marker.style.left = `${Math.min(100, (bookmark.time_ms / meeting.duration_ms) * 100)}%`;
    marker.addEventListener('click', (event) => {
      event.stopPropagation();
      seekToMs(bookmark.time_ms);
    });
    container.appendChild(marker);
  });
}

function updatePlayhead(currentMs, durationMs) {
  const playhead = qs('#timeline-playhead');
  if (!durationMs) { playhead.style.left = '0%'; return; }
  playhead.style.left = `${Math.min(100, (currentMs / durationMs) * 100)}%`;
}

'use strict';

import { store } from './state.js';
import { qs, el, formatTimestamp, debounce } from './utils.js';

export function initSpeakers() {
  store.subscribe('currentMeeting', (meeting) => {
    if (meeting) renderSpeakers(meeting.id);
  });
}

export async function renderSpeakers(meetingId) {
  const container = qs('#speaker-list');
  if (!container) return;
  const stats = await window.api.storage.getSpeakerStats(meetingId);
  container.innerHTML = '';

  if (!stats.length) {
    container.appendChild(el('p', { class: 'settings-help' },
      'No speakers detected yet. Speakers appear automatically once transcription begins, or after a manual reassignment in the transcript.'));
    return;
  }

  const maxMs = Math.max(...stats.map((s) => s.total_speaking_ms), 1);

  for (const speaker of stats) {
    container.appendChild(buildSpeakerRow(meetingId, speaker, maxMs));
  }
}

function buildSpeakerRow(meetingId, speaker, maxMs) {
  const dot = el('span', { class: 'speaker-color-dot' });
  dot.style.background = speaker.color;

  const nameInput = el('input', {
    class: 'speaker-name-input',
    type: 'text',
    value: speaker.display_name || speaker.label,
    'aria-label': `Rename ${speaker.label}`,
  });

  const colorInput = el('input', { type: 'color', value: speaker.color, title: 'Speaker colour' });

  const persist = debounce(async () => {
    await window.api.storage.upsertSpeaker(meetingId, {
      id: speaker.id,
      label: speaker.label,
      display_name: nameInput.value.trim() || speaker.label,
      color: colorInput.value,
    });
    document.dispatchEvent(new CustomEvent('speakers-updated', { detail: { meetingId } }));
  }, 350);

  nameInput.addEventListener('input', persist);
  colorInput.addEventListener('input', () => {
    dot.style.background = colorInput.value;
    barFill.style.background = colorInput.value;
    persist();
  });

  const barTrack = el('div', { class: 'speaker-stat-bar-track' });
  const barFill = el('div', { class: 'speaker-stat-bar-fill' });
  barFill.style.width = `${Math.round((speaker.total_speaking_ms / maxMs) * 100)}%`;
  barFill.style.background = speaker.color;
  barTrack.appendChild(barFill);

  const timeLabel = el('span', { class: 'speaker-stat-time' }, formatTimestamp(speaker.total_speaking_ms));

  const row = el('div', { class: 'speaker-row' });
  row.append(dot, nameInput, colorInput, barTrack, timeLabel);
  return row;
}

'use strict';

import { store } from './state.js';
import { storage } from './storage.js';
import { isAvailable as isDiarizationAvailable, diarizeRecording } from './diarization.js';
import {
  qs, el, formatTimestamp, debounce, showToast, colorForSpeakerIndex,
} from './utils.js';

export function initSpeakers() {
  store.subscribe('currentMeeting', (meeting) => {
    if (meeting) {
      renderSpeakers(meeting.id);
      updateDetectButtonState(meeting);
    }
  });

  qs('#btn-detect-speakers').addEventListener('click', () => runDiarization());
}

function updateDetectButtonState(meeting) {
  const button = qs('#btn-detect-speakers');
  const status = qs('#diarization-status');
  if (!meeting.recording_path) {
    button.disabled = true;
    status.textContent = 'Needs a saved recording — not available for transcript-only meetings.';
    return;
  }
  button.disabled = false;
  status.textContent = '';
}

export async function renderSpeakers(meetingId) {
  const container = qs('#speaker-list');
  if (!container) return;
  const stats = await storage.getSpeakerStats(meetingId);
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
    await storage.upsertSpeaker(meetingId, {
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

// ---------------------------------------------------------------------------
// True acoustic diarization — replaces the live heuristic assignment with
// real voice-embedding clustering over the finished recording.
// ---------------------------------------------------------------------------

async function runDiarization() {
  const meeting = store.get('currentMeeting');
  if (!meeting?.recording_path) return;

  const button = qs('#btn-detect-speakers');
  const status = qs('#diarization-status');
  button.disabled = true;

  try {
    status.textContent = 'Checking for the diarization model…';
    const available = await isDiarizationAvailable();
    if (!available) {
      status.textContent = 'Diarization assets are missing from this deployment — see docs/MODEL_SETUP.md.';
      return;
    }

    status.textContent = 'Loading model (first use only)…';
    const blob = await storage.getRecordingBlob(meeting);
    if (!blob) {
      status.textContent = 'No recording audio found for this meeting.';
      return;
    }

    status.textContent = 'Analyzing voices — this can take a while for longer recordings…';
    const turns = await diarizeRecording(blob);
    if (!turns.length) {
      status.textContent = 'No distinct speakers were detected.';
      return;
    }

    status.textContent = 'Applying results…';
    await applyDiarizationResult(meeting, turns);

    const refreshed = await storage.getMeeting(meeting.id);
    store.set('currentMeeting', refreshed);
    const speakerCount = new Set(turns.map((t) => t.speaker)).size;
    status.textContent = '';
    showToast(`Detected ${speakerCount} speaker${speakerCount === 1 ? '' : 's'} and reassigned the transcript.`, 'success');
  } catch (error) {
    status.textContent = '';
    showToast(`Speaker detection failed: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

/**
 * Creates one speaker record per detected voice cluster, reassigns every
 * transcript segment to whichever diarization turn overlaps it the most,
 * and removes any speakers left with no segments (typically the old
 * heuristic round-robin speakers this replaces).
 */
async function applyDiarizationResult(meeting, turns) {
  const clusterIds = [...new Set(turns.map((t) => t.speaker))].sort((a, b) => a - b);
  const newSpeakerIdByCluster = new Map();
  for (const [index, clusterId] of clusterIds.entries()) {
    const speaker = await storage.upsertSpeaker(meeting.id, {
      label: `Speaker ${index + 1}`,
      display_name: null,
      color: colorForSpeakerIndex(index),
    });
    newSpeakerIdByCluster.set(clusterId, speaker.id);
  }

  for (const segment of meeting.segments) {
    const bestTurn = findBestOverlap(segment, turns);
    const newSpeakerId = bestTurn ? newSpeakerIdByCluster.get(bestTurn.speaker) : null;
    if (newSpeakerId && newSpeakerId !== segment.speaker_id) {
      await storage.updateTranscriptSegment(meeting.id, segment.id, { speaker_id: newSpeakerId });
    }
  }

  const oldSpeakerIds = new Set(meeting.speakers.map((s) => s.id));
  const keptSpeakerIds = new Set(newSpeakerIdByCluster.values());
  const staleSpeakerIds = [...oldSpeakerIds].filter((id) => !keptSpeakerIds.has(id));
  for (const speakerId of staleSpeakerIds) {
    await storage.deleteSpeakerIfUnused(meeting.id, speakerId);
  }
}

function findBestOverlap(segment, turns) {
  let best = null;
  let bestOverlapMs = 0;
  for (const turn of turns) {
    const overlapStart = Math.max(segment.start_ms, turn.startMs);
    const overlapEnd = Math.min(segment.end_ms, turn.endMs);
    const overlapMs = Math.max(0, overlapEnd - overlapStart);
    if (overlapMs > bestOverlapMs) {
      bestOverlapMs = overlapMs;
      best = turn;
    }
  }
  if (!best) {
    // Segment fell entirely in a gap between turns (e.g. a very short
    // utterance) — fall back to whichever turn is temporally closest.
    let minDistance = Infinity;
    for (const turn of turns) {
      const distance = segment.start_ms < turn.startMs ? turn.startMs - segment.start_ms : segment.start_ms - turn.endMs;
      if (Math.abs(distance) < minDistance) {
        minDistance = Math.abs(distance);
        best = turn;
      }
    }
  }
  return best;
}

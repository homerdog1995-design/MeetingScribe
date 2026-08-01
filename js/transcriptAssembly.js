'use strict';

import { storage } from './storage.js';
import { colorForSpeakerIndex } from './utils.js';

/**
 * transcriptAssembly.js — the layer between "an ASR engine produced some
 * text" / "a diarization pass produced some speaker turns" and "the
 * meeting's persisted transcript reflects that." Deliberately independent
 * of any UI concerns (editor.js and speakers.js are thin callers that
 * handle rendering/scrolling/refresh after calling into this module) and
 * independent of any specific ASR engine (it only ever consumes the
 * generic {text, startMs, endMs, speakerTurn, confidence} segment shape
 * every provider emits — see providerBase.js).
 *
 * This is also what keeps diarization genuinely decoupled from live
 * transcription, not just conceptually but in the code: LiveSpeakerRotation
 * (initial, heuristic speaker assignment, applied as text arrives) and
 * applyDiarization() (real acoustic speaker reassignment, applied later as
 * a separate pass over an already-finished recording) never call each
 * other or share state. Swapping the live heuristic for something smarter
 * later, or changing how diarization results get reconciled, can each be
 * done without touching the other.
 */

export class LiveSpeakerRotation {
  /**
   * With no real acoustic signal to distinguish speakers live (no ASR
   * engine here reports genuine speaker identity — see applyDiarization
   * below for what does), always creating brand-new speakers before ever
   * cycling back meant a simple one- or two-person conversation would get
   * several different auto-created identities before Speaker 1 ever
   * reappeared. Capping at 2 means cycling starts immediately after the
   * second speaker exists — a much better default for the common case.
   * Manual reassignment in the Speakers tab still covers meetings with
   * more than two people; running diarization replaces this heuristic
   * with real speaker identity entirely.
   */
  static MAX_AUTO_SPEAKERS = 2;

  constructor(meeting) {
    this.speakerRoundRobin = meeting.speakers.slice().sort((a, b) => a.sort_index - b.sort_index).map((s) => s.id);
    this.currentSpeakerSlot = this.speakerRoundRobin.length - 1;
    this.lastSegmentEndMs = meeting.segments.length ? meeting.segments[meeting.segments.length - 1].end_ms : null;
    this.lastCommittedText = null;
    this.lastCommittedAtPerfMs = 0;
    this.lastCommittedSegmentId = null;
  }

  async _advanceSlot(meetingId) {
    if (this.speakerRoundRobin.length < LiveSpeakerRotation.MAX_AUTO_SPEAKERS) {
      const index = this.speakerRoundRobin.length;
      const speaker = await storage.upsertSpeaker(meetingId, {
        label: `Speaker ${index + 1}`,
        display_name: null,
        color: colorForSpeakerIndex(index),
      });
      this.speakerRoundRobin.push(speaker.id);
      this.currentSpeakerSlot = index;
    } else {
      this.currentSpeakerSlot = (this.currentSpeakerSlot + 1) % this.speakerRoundRobin.length;
    }
  }

  /**
   * Turns one raw ASR segment into a persisted transcript segment (or a
   * revision of the immediately-previous one — see the growing-prefix
   * note below), applying the live speaker-rotation heuristic.
   * @returns {Promise<{inserted: boolean, updated: boolean, segmentId: string|null}>} what actually happened, so the caller can decide whether to refresh/scroll
   */
  async assignLiveSegment(meetingId, detail, silenceThresholdMs) {
    const text = detail.text.trim();
    if (!text) return { inserted: false, updated: false, segmentId: null };

    const nowPerf = performance.now();
    const withinRevisionWindow = this.lastCommittedText !== null && (nowPerf - this.lastCommittedAtPerfMs) < 1500;

    // Some engines (Web Speech, confirmed via real device testing) can
    // mark a still-growing, in-progress transcription as final repeatedly
    // rather than delivering one true final result per utterance —
    // "I said" -> "I said I" -> "I said I love" are revisions of the same
    // utterance, not new ones. Tightly time-boxed (~1s, matching how fast
    // the actual observed pattern happens): a wider window risks
    // misreading two different, sequential sentences that happen to share
    // a common starting word as one being a revision of the other.
    if (withinRevisionWindow && text === this.lastCommittedText) {
      return { inserted: false, updated: false, segmentId: null };
    }
    if (withinRevisionWindow && this.lastCommittedSegmentId && text.startsWith(this.lastCommittedText)) {
      await storage.updateTranscriptSegment(meetingId, this.lastCommittedSegmentId, { text });
      this.lastCommittedText = text;
      this.lastCommittedAtPerfMs = nowPerf;
      return { inserted: false, updated: true, segmentId: this.lastCommittedSegmentId };
    }

    const isTurn = detail.speakerTurn || this.lastSegmentEndMs === null || (detail.startMs - this.lastSegmentEndMs >= silenceThresholdMs);
    if (isTurn) await this._advanceSlot(meetingId);
    this.lastSegmentEndMs = detail.endMs;

    const speakerId = this.speakerRoundRobin[this.currentSpeakerSlot] || null;
    const inserted = await storage.addTranscriptSegments(meetingId, [{
      speakerId,
      startMs: Math.round(detail.startMs),
      endMs: Math.round(detail.endMs),
      text,
      confidence: detail.confidence,
      paragraphBreak: isTurn,
    }]);

    this.lastCommittedText = text;
    this.lastCommittedAtPerfMs = nowPerf;
    this.lastCommittedSegmentId = inserted[0]?.id ?? null;

    return { inserted: true, updated: false, segmentId: this.lastCommittedSegmentId };
  }
}

/**
 * Applies a diarization result (real acoustic speaker turns) to an
 * already-finished meeting's transcript. Always a separate, later pass —
 * never called during live recording — matching real diarization's actual
 * requirement of needing the whole conversation to cluster speakers
 * correctly (see diarization.js's file header).
 * @param {{id: string, segments: object[], speakers: object[]}} meeting
 * @param {Array<{startMs: number, endMs: number, speaker: number}>} turns
 * @returns {Promise<{speakerCount: number}>}
 */
export async function applyDiarization(meeting, turns) {
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

  return { speakerCount: clusterIds.length };
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

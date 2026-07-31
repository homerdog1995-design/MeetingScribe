'use strict';

const { speakerName } = require('./shared');

function build(meeting) {
  const payload = {
    id: meeting.id,
    title: meeting.title,
    createdAt: meeting.created_at,
    durationMs: meeting.duration_ms,
    tags: meeting.tags.map((t) => t.name),
    speakers: meeting.speakers.map((s) => ({ id: s.id, name: s.display_name || s.label, color: s.color, totalSpeakingMs: s.total_speaking_ms })),
    segments: meeting.segments.map((s) => ({
      startMs: s.start_ms,
      endMs: s.end_ms,
      speaker: speakerName(meeting, s.speaker_id),
      text: s.text,
      confidence: s.confidence,
      edited: !!s.edited,
    })),
    bookmarks: meeting.bookmarks.map((b) => ({ timeMs: b.time_ms, label: b.label })),
    comments: meeting.comments.map((c) => ({ segmentId: c.segment_id, text: c.text, resolved: !!c.resolved })),
    summary: meeting.summary ? { source: meeting.summary.source, model: meeting.summary.model, sections: meeting.summary.sections } : null,
    exportedAt: Date.now(),
    exportedBy: 'MeetingScribe',
  };
  return JSON.stringify(payload, null, 2);
}

module.exports = { build, extension: 'json', mimeType: 'application/json' };

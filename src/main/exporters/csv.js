'use strict';

const { formatTimestamp, speakerName, csvEscape } = require('./shared');

function build(meeting) {
  const rows = [['Start', 'End', 'Speaker', 'Text', 'Edited', 'Bookmarked']];

  const bookmarkTimes = new Set(meeting.bookmarks.map((b) => b.time_ms));

  for (const seg of meeting.segments) {
    const isBookmarked = [...bookmarkTimes].some((t) => t >= seg.start_ms && t <= seg.end_ms);
    rows.push([
      formatTimestamp(seg.start_ms),
      formatTimestamp(seg.end_ms),
      speakerName(meeting, seg.speaker_id),
      seg.text,
      seg.edited ? 'Yes' : 'No',
      isBookmarked ? 'Yes' : 'No',
    ]);
  }

  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

module.exports = { build, extension: 'csv', mimeType: 'text/csv' };

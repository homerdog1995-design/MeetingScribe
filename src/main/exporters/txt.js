'use strict';

const { formatTimestamp, formatDuration, speakerName, summaryToPlainSections } = require('./shared');

function build(meeting) {
  const lines = [];
  lines.push(meeting.title);
  lines.push(`Date: ${new Date(meeting.created_at).toLocaleString()}`);
  lines.push(`Duration: ${formatDuration(meeting.duration_ms)}`);
  if (meeting.tags.length) lines.push(`Tags: ${meeting.tags.map((t) => t.name).join(', ')}`);
  lines.push('');

  const summarySections = summaryToPlainSections(meeting.summary);
  if (summarySections.length) {
    lines.push('='.repeat(60));
    lines.push('SUMMARY');
    lines.push('='.repeat(60));
    for (const section of summarySections) {
      lines.push('');
      lines.push(section.title.toUpperCase());
      lines.push('-'.repeat(section.title.length));
      if (section.body) lines.push(section.body);
      if (section.list) section.list.forEach((item) => lines.push(`  • ${item}`));
    }
    lines.push('');
  }

  lines.push('='.repeat(60));
  lines.push('TRANSCRIPT');
  lines.push('='.repeat(60));
  lines.push('');

  for (const seg of meeting.segments) {
    if (seg.paragraph_break) lines.push('');
    lines.push(`[${formatTimestamp(seg.start_ms)}] ${speakerName(meeting, seg.speaker_id)}: ${seg.text}`);
  }

  return lines.join('\n');
}

module.exports = { build, extension: 'txt', mimeType: 'text/plain' };

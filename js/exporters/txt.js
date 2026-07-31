'use strict';

import { buildTranscriptRows, buildSummarySections } from './shared.js';

export function build(meeting) {
  const lines = [];
  lines.push(meeting.title);
  lines.push(`Recorded: ${new Date(meeting.created_at).toLocaleString()}`);
  lines.push('');

  const summarySections = buildSummarySections(meeting);
  if (summarySections.length) {
    lines.push('SUMMARY', '='.repeat(7), '');
    for (const section of summarySections) {
      lines.push(section.title.toUpperCase());
      for (const line of section.lines) lines.push(`- ${line}`);
      lines.push('');
    }
  }

  lines.push('TRANSCRIPT', '='.repeat(10), '');
  for (const row of buildTranscriptRows(meeting)) {
    lines.push(`[${row.timestamp}] ${row.speakerName}: ${row.text}`);
  }

  return lines.join('\n');
}

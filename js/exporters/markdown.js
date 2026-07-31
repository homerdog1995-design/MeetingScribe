'use strict';

import { buildTranscriptRows, buildSummarySections } from './shared.js';

export function build(meeting) {
  const lines = [];
  lines.push(`# ${meeting.title}`, '');
  lines.push(`_Recorded: ${new Date(meeting.created_at).toLocaleString()}_`, '');

  const summarySections = buildSummarySections(meeting);
  if (summarySections.length) {
    lines.push('## Summary', '');
    for (const section of summarySections) {
      lines.push(`### ${section.title}`, '');
      for (const line of section.lines) lines.push(`- ${line}`);
      lines.push('');
    }
  }

  lines.push('## Transcript', '');
  for (const row of buildTranscriptRows(meeting)) {
    lines.push(`**[${row.timestamp}] ${row.speakerName}:** ${row.text}`, '');
  }

  return lines.join('\n');
}

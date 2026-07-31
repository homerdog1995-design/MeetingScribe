'use strict';

import { buildTranscriptRows, escapeCsvField } from './shared.js';

export function build(meeting) {
  const rows = [['Timestamp', 'Speaker', 'Text', 'Highlighted']];
  for (const row of buildTranscriptRows(meeting)) {
    rows.push([row.timestamp, row.speakerName, row.text, row.highlighted ? 'yes' : 'no']);
  }
  return rows.map((r) => r.map(escapeCsvField).join(',')).join('\r\n');
}

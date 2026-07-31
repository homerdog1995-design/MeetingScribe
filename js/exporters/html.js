'use strict';

import { buildTranscriptRows, buildSummarySections, escapeHtml } from './shared.js';

export function build(meeting) {
  const summarySections = buildSummarySections(meeting);
  const transcriptRows = buildTranscriptRows(meeting);

  const summaryHtml = summarySections.length ? `
    <h2>Summary</h2>
    ${summarySections.map((section) => `
      <h3>${escapeHtml(section.title)}</h3>
      <ul>${section.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    `).join('')}
  ` : '';

  const transcriptHtml = transcriptRows.map((row) => `
    <p class="segment${row.highlighted ? ' highlighted' : ''}">
      <span class="ts">[${row.timestamp}]</span>
      <span class="speaker">${escapeHtml(row.speakerName)}:</span>
      ${escapeHtml(row.text)}
    </p>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(meeting.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.55; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .meta { color: #666; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 18px; margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  h3 { font-size: 14px; margin-top: 18px; }
  ul { margin: 6px 0; padding-left: 22px; }
  .segment { margin: 10px 0; }
  .segment.highlighted { background: #fff6d8; padding: 6px 8px; border-radius: 4px; }
  .ts { font-family: ui-monospace, monospace; color: #888; font-size: 12px; margin-right: 6px; }
  .speaker { font-weight: 600; margin-right: 4px; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
  <h1>${escapeHtml(meeting.title)}</h1>
  <div class="meta">Recorded ${new Date(meeting.created_at).toLocaleString()}</div>
  ${summaryHtml}
  <h2>Transcript</h2>
  ${transcriptHtml}
</body>
</html>`;
}

'use strict';

import { buildTranscriptRows, buildSummarySections, escapeRtf } from './shared.js';

/**
 * WHY RTF INSTEAD OF DOCX: the old Electron version used the `docx` npm
 * package to build a real .docx file. That package (like any npm package)
 * needs either a bundler or a `require()`-capable runtime to load — this
 * app has neither (it's plain <script type="module"> with no build step,
 * by design), and fetching it from a CDN at runtime would mean an internet
 * dependency, which breaks "keep everything offline." RTF has neither
 * problem: it's a plain-text control-word format that Word, Google Docs,
 * and LibreOffice all open natively, and it can be hand-built with string
 * concatenation alone.
 */
export function build(meeting) {
  const parts = ['{\\rtf1\\ansi\\deff0', '{\\fonttbl{\\f0 Calibri;}}', '\\fs28', `\\b ${escapeRtf(meeting.title)}\\b0\\par`,
    `\\fs20 Recorded ${escapeRtf(new Date(meeting.created_at).toLocaleString())}\\par\\par`];

  const summarySections = buildSummarySections(meeting);
  if (summarySections.length) {
    parts.push('\\fs24\\b Summary\\b0\\fs20\\par');
    for (const section of summarySections) {
      parts.push(`\\b ${escapeRtf(section.title)}\\b0\\par`);
      for (const line of section.lines) parts.push(`\\bullet  ${escapeRtf(line)}\\par`);
      parts.push('\\par');
    }
  }

  parts.push('\\fs24\\b Transcript\\b0\\fs20\\par');
  for (const row of buildTranscriptRows(meeting)) {
    parts.push(`\\b [${row.timestamp}] ${escapeRtf(row.speakerName)}:\\b0  ${escapeRtf(row.text)}\\par`);
  }

  parts.push('}');
  return parts.join('\n');
}

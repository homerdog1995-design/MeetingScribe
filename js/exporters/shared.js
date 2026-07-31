'use strict';

/** hh:mm:ss for a millisecond offset. */
export function formatTs(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Every export format needs the same {timestamp, speakerName, text} rows, built once here rather than duplicated per formatter. */
export function buildTranscriptRows(meeting) {
  const speakerById = new Map(meeting.speakers.map((s) => [s.id, s.display_name || s.label]));
  return meeting.segments.map((segment) => ({
    timestamp: formatTs(segment.start_ms),
    speakerName: speakerById.get(segment.speaker_id) || 'Unknown speaker',
    text: segment.text,
    highlighted: Boolean(segment.highlighted),
  }));
}

const SUMMARY_SECTION_TITLES = {
  executiveSummary: 'Executive Summary',
  overview: 'Meeting Overview',
  topics: 'Discussion Topics',
  decisions: 'Key Decisions',
  risks: 'Risks',
  questionsRaised: 'Questions Raised',
  actionItems: 'Action Items',
  followUps: 'Follow-ups',
  openIssues: 'Open Issues',
};

/** Flattens the summary object into an ordered list of {title, lines[]} sections, so every text-based exporter can render summaries identically. */
export function buildSummarySections(meeting) {
  if (!meeting.summary) return [];
  const sections = meeting.summary.sections || {};
  return Object.entries(SUMMARY_SECTION_TITLES).map(([key, title]) => {
    const value = sections[key];
    let lines = [];
    if (typeof value === 'string') {
      lines = value.trim() ? [value] : [];
    } else if (Array.isArray(value)) {
      lines = value.map((item) => {
        if (typeof item === 'string') return item;
        if (key === 'topics') return `${item.label || 'Topic'}: ${item.representativeText || ''}`;
        if (key === 'actionItems') {
          const owner = item.owner ? ` — ${item.owner}` : '';
          const due = item.dueHint ? ` (${item.dueHint})` : '';
          return `${item.text}${owner}${due}`;
        }
        return item.text || '';
      });
    }
    return { title, lines };
  }).filter((section) => section.lines.length > 0);
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function escapeCsvField(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Escapes text for RTF's control-word syntax (backslash, braces, and non-ASCII need \uNNNN? — plain \\, \{, \} are sufficient for the text this app produces). */
export function escapeRtf(text) {
  return String(text ?? '').replace(/[\\{}]/g, (ch) => `\\${ch}`).replace(/\n/g, '\\line ');
}

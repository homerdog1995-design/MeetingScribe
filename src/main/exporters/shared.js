'use strict';

function formatTimestamp(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--:--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function speakerName(meeting, speakerId) {
  if (!speakerId) return 'Unknown speaker';
  const speaker = meeting.speakers.find((s) => s.id === speakerId);
  if (!speaker) return 'Unknown speaker';
  return speaker.display_name || speaker.label;
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summaryToPlainSections(summary) {
  if (!summary) return [];
  const s = summary.sections;
  const sections = [];
  if (s.executiveSummary) sections.push({ title: 'Executive Summary', body: s.executiveSummary });
  if (s.overview) sections.push({ title: 'Meeting Overview', body: s.overview });
  if (s.topics?.length) sections.push({ title: 'Discussion Topics', list: s.topics.map((t) => `${t.label}${t.representativeText ? ` — "${t.representativeText}"` : ''}`) });
  if (s.decisions?.length) sections.push({ title: 'Key Decisions', list: s.decisions.map((d) => d.text) });
  if (s.risks?.length) sections.push({ title: 'Risks', list: s.risks.map((r) => r.text) });
  if (s.questionsRaised?.length) sections.push({ title: 'Questions Raised', list: s.questionsRaised.map((q) => q.text) });
  if (s.actionItems?.length) sections.push({
    title: 'Action Items',
    list: s.actionItems.map((a) => `${a.text}${a.owner ? ` (Owner: ${a.owner})` : ''}${a.dueHint ? ` (Due: ${a.dueHint})` : ''}`),
  });
  if (s.followUps?.length) sections.push({ title: 'Follow-ups', list: s.followUps.map((f) => f.text) });
  if (s.openIssues?.length) sections.push({ title: 'Open Issues', list: s.openIssues.map((o) => o.text) });
  return sections;
}

module.exports = { formatTimestamp, formatDuration, speakerName, csvEscape, htmlEscape, summaryToPlainSections };

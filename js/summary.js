'use strict';

import { store } from './state.js';
import { storage } from './storage.js';
import { generate as generateSummarySections } from './summaryEngine.js';
import { qs, el, showToast } from './utils.js';

const SOURCE_LABELS = {
  ollama: 'Ollama (local LLM)',
  llamacpp: 'llama.cpp server (local LLM)',
  heuristic: 'Heuristic summary — no local LLM detected',
};

export function initSummary() {
  qs('#btn-generate-summary').addEventListener('click', () => generateSummary());
  store.subscribe('currentMeeting', (meeting) => {
    if (meeting) renderSummary(meeting);
  });
}

async function generateSummary() {
  const meeting = store.get('currentMeeting');
  if (!meeting) return;
  if (!meeting.segments.length) {
    showToast('There is no transcript yet to summarize.', 'info');
    return;
  }

  const button = qs('#btn-generate-summary');
  button.disabled = true;
  button.textContent = 'Generating…';
  try {
    await generateSummarySections(meeting.id);
    const refreshed = await storage.getMeeting(meeting.id);
    store.set('currentMeeting', refreshed);
    showToast('Summary generated.', 'success');
  } catch (error) {
    showToast(`Could not generate summary: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Generate summary';
  }
}

function renderSummary(meeting) {
  const container = qs('#summary-content');
  const note = qs('#summary-source-note');
  container.innerHTML = '';

  if (!meeting.summary) {
    note.textContent = '';
    container.appendChild(el('p', { class: 'settings-help' }, 'No summary yet. Click "Generate summary" above.'));
    return;
  }

  const sourceLabel = SOURCE_LABELS[meeting.summary.source] || meeting.summary.source;
  const modelSuffix = meeting.summary.model ? ` — ${meeting.summary.model}` : '';
  note.textContent = `${sourceLabel}${modelSuffix} · ${new Date(meeting.summary.generated_at).toLocaleString()}`;

  const sections = meeting.summary.sections || {};

  container.appendChild(buildTextSection('Executive summary', sections.executiveSummary));
  container.appendChild(buildTextSection('Meeting overview', sections.overview));
  container.appendChild(buildTopicsSection(sections.topics));
  container.appendChild(buildListSection('Key decisions', sections.decisions));
  container.appendChild(buildListSection('Risks', sections.risks));
  container.appendChild(buildListSection('Questions raised', sections.questionsRaised));
  container.appendChild(buildActionItemsSection(sections.actionItems));
  container.appendChild(buildListSection('Follow-ups', sections.followUps));
  container.appendChild(buildListSection('Open issues', sections.openIssues));
}

function buildTextSection(title, value) {
  const section = el('div', { class: 'summary-section' }, [el('h3', {}, title)]);
  if (value && value.trim()) section.appendChild(el('p', {}, value));
  else section.appendChild(el('p', { class: 'empty' }, 'Nothing identified.'));
  return section;
}

function buildListSection(title, items) {
  const section = el('div', { class: 'summary-section' }, [el('h3', {}, title)]);
  if (Array.isArray(items) && items.length) {
    const ul = el('ul', {});
    items.forEach((item) => ul.appendChild(el('li', {}, typeof item === 'string' ? item : item.text || '')));
    section.appendChild(ul);
  } else {
    section.appendChild(el('p', { class: 'empty' }, 'None identified.'));
  }
  return section;
}

function buildTopicsSection(topics) {
  const section = el('div', { class: 'summary-section' }, [el('h3', {}, 'Discussion topics')]);
  if (Array.isArray(topics) && topics.length) {
    const ul = el('ul', {});
    topics.forEach((topic) => {
      const li = el('li', {}, [el('strong', {}, topic.label || 'Topic')]);
      if (topic.representativeText) li.appendChild(el('span', {}, ` — ${topic.representativeText}`));
      ul.appendChild(li);
    });
    section.appendChild(ul);
  } else {
    section.appendChild(el('p', { class: 'empty' }, 'No distinct topics identified.'));
  }
  return section;
}

function buildActionItemsSection(items) {
  const section = el('div', { class: 'summary-section' }, [el('h3', {}, 'Action items')]);
  if (Array.isArray(items) && items.length) {
    const ul = el('ul', {});
    items.forEach((item) => {
      const li = el('li', {}, item.text || '');
      if (item.owner) li.appendChild(el('span', { class: 'action-item-owner' }, ` — ${item.owner}`));
      if (item.dueHint) li.appendChild(el('span', { class: 'action-item-due' }, ` (${item.dueHint})`));
      ul.appendChild(li);
    });
    section.appendChild(ul);
  } else {
    section.appendChild(el('p', { class: 'empty' }, 'No action items identified.'));
  }
  return section;
}

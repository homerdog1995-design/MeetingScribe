'use strict';

import { store } from './state.js';
import { qs, el, showToast } from './utils.js';

const FORMAT_LABELS = {
  txt: 'Plain text',
  md: 'Markdown',
  html: 'HTML',
  pdf: 'PDF',
  docx: 'Word document',
  csv: 'CSV',
  json: 'JSON',
};

export function initExport() {
  renderExportFormats();
}

async function renderExportFormats() {
  const container = qs('#export-format-list');
  const formats = await window.api.export.listFormats();
  container.innerHTML = '';

  formats.forEach((format) => {
    const card = el('button', { class: 'export-format-card', type: 'button' }, [
      el('span', { class: 'ext' }, format.extension.toUpperCase()),
      el('span', {}, FORMAT_LABELS[format.key] || format.key),
    ]);
    card.addEventListener('click', () => runExport(format.key));
    container.appendChild(card);
  });
}

async function runExport(formatKey) {
  const meeting = store.get('currentMeeting');
  if (!meeting) return;

  try {
    const result = await window.api.export.exportMeeting(meeting.id, formatKey);
    if (result.canceled) return;
    showToast(`Exported to ${result.filePath}`, 'success');
    await window.api.export.revealInFolder(result.filePath);
  } catch (error) {
    showToast(`Export failed: ${error.message}`, 'error');
  }
}

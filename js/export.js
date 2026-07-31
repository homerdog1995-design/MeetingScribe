'use strict';

import { store } from './state.js';
import { exportEngine } from './exportEngine.js';
import { qs, el, showToast } from './utils.js';

const FORMAT_LABELS = {
  txt: 'Plain text',
  md: 'Markdown',
  html: 'HTML',
  pdf: 'PDF (via print dialog)',
  rtf: 'Rich Text (Word-compatible)',
  csv: 'CSV',
  json: 'JSON',
};

export function initExport() {
  renderExportFormats();
}

function renderExportFormats() {
  const container = qs('#export-format-list');
  const formats = exportEngine.listFormats();
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
    const result = await exportEngine.exportMeeting(meeting.id, formatKey);
    if (formatKey === 'pdf') {
      showToast('Choose "Save as PDF" in the print dialog that just opened.', 'info');
    } else {
      showToast(`Downloaded ${result.filePath}`, 'success');
    }
  } catch (error) {
    showToast(`Export failed: ${error.message}`, 'error');
  }
}

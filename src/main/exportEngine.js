'use strict';

const fs = require('fs');
const path = require('path');
const { dialog, shell } = require('electron');
const logger = require('./logger');

const FORMATS = {
  txt: require('./exporters/txt'),
  md: require('./exporters/markdown'),
  csv: require('./exporters/csv'),
  json: require('./exporters/json'),
  html: require('./exporters/html'),
  pdf: require('./exporters/pdf'),
  docx: require('./exporters/docx'),
};

function listFormats() {
  return Object.entries(FORMATS).map(([key, mod]) => ({ key, extension: mod.extension, mimeType: mod.mimeType }));
}

function sanitizeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120) || 'meeting';
}

/**
 * @param {object} browserWindow the window to anchor the save dialog to
 * @param {object} meeting full meeting record from storage.getMeeting()
 * @param {string} formatKey one of FORMATS' keys
 */
async function exportMeeting(browserWindow, meeting, formatKey) {
  const exporter = FORMATS[formatKey];
  if (!exporter) throw new Error(`Unknown export format: ${formatKey}`);

  const defaultName = `${sanitizeFilename(meeting.title)}.${exporter.extension}`;
  const { canceled, filePath } = await dialog.showSaveDialog(browserWindow, {
    title: 'Export meeting',
    defaultPath: defaultName,
    filters: [{ name: exporter.extension.toUpperCase(), extensions: [exporter.extension] }],
  });

  if (canceled || !filePath) return { canceled: true };

  const output = exporter.isAsync ? await exporter.build(meeting) : exporter.build(meeting);
  fs.writeFileSync(filePath, output, exporter.isBinary ? undefined : 'utf8');

  logger.info('exportEngine', 'Meeting exported', { format: formatKey, filePath });
  return { canceled: false, filePath };
}

function revealInFolder(filePath) {
  shell.showItemInFolder(filePath);
}

module.exports = { listFormats, exportMeeting, revealInFolder };

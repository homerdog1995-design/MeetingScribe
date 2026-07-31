'use strict';

import { storage } from './storage.js';
import * as txtExporter from './exporters/txt.js';
import * as markdownExporter from './exporters/markdown.js';
import * as csvExporter from './exporters/csv.js';
import * as jsonExporter from './exporters/json.js';
import * as htmlExporter from './exporters/html.js';
import * as rtfExporter from './exporters/rtf.js';

const FORMATS = [
  { key: 'txt', extension: 'txt', mimeType: 'text/plain' },
  { key: 'md', extension: 'md', mimeType: 'text/markdown' },
  { key: 'html', extension: 'html', mimeType: 'text/html' },
  { key: 'pdf', extension: 'pdf', mimeType: 'application/pdf' },
  { key: 'rtf', extension: 'rtf', mimeType: 'application/rtf' },
  { key: 'csv', extension: 'csv', mimeType: 'text/csv' },
  { key: 'json', extension: 'json', mimeType: 'application/json' },
];

const BUILDERS = {
  txt: txtExporter, md: markdownExporter, html: htmlExporter, rtf: rtfExporter, csv: csvExporter, json: jsonExporter,
};

function listFormats() {
  return FORMATS;
}

function sanitizeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'meeting';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * WHY THIS REPLACES ELECTRON'S webContents.printToPDF: that API could
 * silently render a page to a PDF file with no user interaction at all. A
 * browser has no equivalent — the only way to get a PDF out of a web page
 * is the browser's own print dialog, with the user choosing "Save as PDF"
 * as the destination. This opens a new tab with a printable rendering of
 * the meeting (reusing the HTML exporter) and invokes window.print() on
 * it. Less automatic than before, but it's the only offline,
 * dependency-free way to produce a PDF from a browser.
 */
function exportAsPdf(meeting) {
  const html = htmlExporter.build(meeting);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    throw new Error('The print window was blocked — allow pop-ups for this site and try again.');
  }
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  setTimeout(() => printWindow.print(), 250);
  return { canceled: false, filePath: '(choose "Save as PDF" in the print dialog)' };
}

async function exportMeeting(meetingId, formatKey) {
  const meeting = await storage.getMeeting(meetingId);
  if (!meeting) throw new Error('Meeting not found');
  const format = FORMATS.find((f) => f.key === formatKey);
  if (!format) throw new Error(`Unknown export format: ${formatKey}`);

  if (formatKey === 'pdf') return exportAsPdf(meeting);

  const content = BUILDERS[formatKey].build(meeting);
  const blob = new Blob([content], { type: format.mimeType });
  const filename = `${sanitizeFilename(meeting.title)}.${format.extension}`;
  triggerDownload(blob, filename);
  return { canceled: false, filePath: filename };
}

export const exportEngine = { listFormats, exportMeeting };

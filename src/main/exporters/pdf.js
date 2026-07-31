'use strict';

/**
 * PDF export deliberately does not use a third-party PDF-generation library.
 * Electron ships Chromium's print engine, exposed as
 * `webContents.printToPDF()` — rendering the same HTML export template
 * (exporters/html.js) in an offscreen, never-shown BrowserWindow gets a
 * faithful, correctly-paginated PDF with zero extra dependencies and zero
 * network access.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { BrowserWindow } = require('electron');
const htmlExporter = require('./html');

async function build(meeting) {
  const html = htmlExporter.build(meeting);

  const tempFile = path.join(os.tmpdir(), `meetingscribe-export-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tempFile, html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });

  try {
    await win.loadFile(tempFile);
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6, marginType: 'custom' },
    });
    return pdfBuffer;
  } finally {
    win.destroy();
    fs.rm(tempFile, { force: true }, () => {});
  }
}

module.exports = { build, extension: 'pdf', mimeType: 'application/pdf', isAsync: true, isBinary: true };

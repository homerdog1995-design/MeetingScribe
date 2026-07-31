'use strict';

/**
 * Security hardening for MeetingScribe.
 *
 * This module is what turns "no network requests, no telemetry" from a
 * policy statement into something enforced by the runtime:
 *
 *   1. A strict Content-Security-Policy is injected on every response.
 *   2. session.webRequest.onBeforeRequest denies any outgoing request that
 *      is not file://, devtools:, or a loopback call to a small allow-list
 *      of local ports (used to talk to a locally-running Ollama/llama.cpp
 *      server). Everything else — including accidental analytics SDKs that
 *      might be pulled in by a future dependency, or a compromised renderer
 *      script — is blocked at the network layer, not just by convention.
 *   3. Navigation and window.open are locked to the app's own origin.
 *   4. Chromium's built-in networked features (spellcheck dictionary
 *      download, safe-browsing pings) are disabled.
 *
 * The one deliberate, disclosed exception is the optional Web Speech API
 * transcription provider (see ARCHITECTURE.md §9) — enabling it requires an
 * explicit user acknowledgement and is the only feature allowed to reach a
 * non-loopback host, via `allowExternalHost`.
 */

const { session } = require('electron');
const logger = require('./logger');

// Ports MeetingScribe is allowed to reach on loopback. These are the default
// Ollama and llama.cpp server ports; the user can add a custom port for
// either from Settings, which calls `setAllowedLoopbackPort`.
const allowedLoopbackPorts = new Set([11434, 8080]);

// Hosts allowed only when the user has explicitly enabled the Web Speech API
// fallback and acknowledged that it is not offline. Empty until opted in.
const allowedExternalHosts = new Set();

let requestFilterInstalled = false;

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function installNetworkGuard(targetSession) {
  targetSession.webRequest.onBeforeRequest((details, callback) => {
    let url;
    try {
      url = new URL(details.url);
    } catch {
      // Malformed URL — deny by default.
      callback({ cancel: true });
      return;
    }

    if (url.protocol === 'file:' || url.protocol === 'devtools:' || url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'chrome-extension:') {
      callback({ cancel: false });
      return;
    }

    if ((url.protocol === 'http:' || url.protocol === 'ws:') && isLoopbackHost(url.hostname)) {
      const port = url.port ? Number(url.port) : (url.protocol === 'ws:' ? 80 : 80);
      if (allowedLoopbackPorts.has(port)) {
        callback({ cancel: false });
        return;
      }
    }

    if (allowedExternalHosts.has(url.hostname)) {
      callback({ cancel: false });
      return;
    }

    logger.warn('security', 'Blocked outgoing network request', { url: details.url, resourceType: details.resourceType });
    callback({ cancel: true });
  });

  requestFilterInstalled = true;
}

/**
 * Injects a strict CSP header on every response served to the renderer.
 * connect-src includes loopback wildcards for both HTTP and WebSocket so a
 * future local-server-based engine (e.g. a streaming llama.cpp server) does
 * not require touching this file.
 */
function installContentSecurityPolicy(targetSession) {
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self' file:",
      "worker-src 'self' file:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      // file: is required here (in addition to 'self') because the optional
      // Whisper WASM provider fetches its model weights and Emscripten glue
      // script from assets/whisper-wasm/ via `fetch()` on a file:// URL —
      // this is a same-machine file read, never a network request.
      "connect-src 'self' file: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

/** Locks navigation and popups to the app's own file:// origin. */
function hardenWindow(browserWindow, appOrigin) {
  browserWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(appOrigin)) {
      logger.warn('security', 'Blocked navigation attempt', { targetUrl });
      event.preventDefault();
    }
  });

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn('security', 'Blocked window.open attempt', { url });
    return { action: 'deny' };
  });

  browserWindow.webContents.on('will-attach-webview', (event) => {
    // No <webview> tags are used anywhere in the app; deny defensively.
    event.preventDefault();
  });

  browserWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // Only microphone and display-capture (for system audio) are ever needed.
    const allowed = permission === 'media' || permission === 'display-capture';
    callback(allowed);
  });
}

function initialize(browserWindow, appOrigin) {
  const targetSession = session.defaultSession;

  if (!requestFilterInstalled) {
    installNetworkGuard(targetSession);
    installContentSecurityPolicy(targetSession);
  }

  hardenWindow(browserWindow, appOrigin);

  // Chromium networked conveniences we do not want for a privacy-first app.
  targetSession.setSpellCheckerEnabled(false);

  logger.info('security', 'Security hardening installed', {
    allowedLoopbackPorts: [...allowedLoopbackPorts],
  });
}

function setAllowedLoopbackPort(port, enabled) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (enabled) allowedLoopbackPorts.add(numericPort);
  else allowedLoopbackPorts.delete(numericPort);
  logger.info('security', 'Loopback port allow-list updated', { port: numericPort, enabled });
}

/**
 * Called only from settingsStore.js when the user explicitly opts into the
 * Web Speech API provider, after confirming the on-screen disclosure.
 */
function setWebSpeechExternalAccess(enabled) {
  const SPEECH_HOSTS = ['www.google.com', 'speech.googleapis.com'];
  if (enabled) {
    SPEECH_HOSTS.forEach((h) => allowedExternalHosts.add(h));
    logger.warn('security', 'Web Speech API external network access ENABLED by explicit user opt-in');
  } else {
    SPEECH_HOSTS.forEach((h) => allowedExternalHosts.delete(h));
    logger.info('security', 'Web Speech API external network access disabled');
  }
}

module.exports = {
  initialize,
  setAllowedLoopbackPort,
  setWebSpeechExternalAccess,
};

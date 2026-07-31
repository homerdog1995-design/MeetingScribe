'use strict';

/* eslint-env worker */
/* global importScripts */

/**
 * Runs inside a dedicated Worker so a heavy WASM inference call never blocks
 * the UI thread. This targets the official whisper.cpp `examples/whisper.wasm`
 * Emscripten build (Embind bindings: `Module.init(path)` and
 * `Module.full_default(index, audio, lang, nthreads, translate)`).
 *
 * VERSION SENSITIVITY (documented, not hidden — see docs/MODEL_SETUP.md,
 * Option C): the exact shape of `init`'s return value has changed between
 * whisper.cpp releases — older single-context builds return a boolean,
 * current multi-context builds return a numeric context index. This worker
 * detects and handles both. If a future upstream release changes the
 * exported function names entirely, only this file needs updating — the
 * rest of the app is unaffected because everything talks to the
 * TranscriptionProvider interface, not to whisper.wasm directly.
 */

let contextIndex = -1;
let usesIndexedApi = true;

self.onmessage = async (event) => {
  const { type, requestId } = event.data;
  try {
    if (type === 'load') {
      await handleLoad(event.data);
      self.postMessage({ type: 'loaded', requestId });
    } else if (type === 'transcribe') {
      const segments = await handleTranscribe(event.data);
      self.postMessage({ type: 'result', requestId, segments });
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) });
  }
};

async function handleLoad({ glueScriptUrl, modelUrl }) {
  self.Module = self.Module || {};

  const runtimeReady = new Promise((resolve) => {
    const previous = self.Module.onRuntimeInitialized;
    self.Module.onRuntimeInitialized = () => {
      if (typeof previous === 'function') previous();
      resolve();
    };
  });

  importScripts(glueScriptUrl);
  await runtimeReady;

  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok) {
    throw new Error(
      `Could not read the whisper.wasm model file (HTTP ${modelResponse.status}). ` +
      'Confirm it is placed under assets/whisper-wasm/ as documented in docs/MODEL_SETUP.md, Option C.'
    );
  }
  const modelBytes = new Uint8Array(await modelResponse.arrayBuffer());

  if (typeof self.Module.FS_createDataFile !== 'function') {
    throw new Error('The loaded whisper.wasm build does not expose FS_createDataFile — this build is likely incompatible. See docs/MODEL_SETUP.md, Option C.');
  }
  self.Module.FS_createDataFile('/', 'ggml-model.bin', modelBytes, true, true, true);

  if (typeof self.Module.init !== 'function') {
    throw new Error('The loaded whisper.wasm build does not expose an init() function — this build is likely incompatible. See docs/MODEL_SETUP.md, Option C.');
  }

  const initResult = self.Module.init('ggml-model.bin');
  const initFailed = initResult === false || initResult === undefined || initResult === -1 ||
    (typeof initResult === 'number' && initResult < 0);
  if (initFailed) {
    throw new Error('whisper.wasm reported it could not load the model. The file may be corrupt or built for a different whisper.cpp version.');
  }

  usesIndexedApi = typeof initResult === 'number' && typeof self.Module.full_default === 'function' && self.Module.full_default.length >= 5;
  contextIndex = typeof initResult === 'number' ? initResult : 0;
}

async function handleTranscribe({ samples, language }) {
  if (contextIndex < 0) throw new Error('whisper.wasm model is not loaded.');

  const floatSamples = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const capturedLines = [];
  const previousPrint = self.Module.print;
  self.Module.print = (line) => capturedLines.push(line);

  try {
    if (usesIndexedApi) {
      self.Module.full_default(contextIndex, floatSamples, language || 'en', 4, false);
    } else {
      self.Module.full_default(floatSamples, language || 'en', false);
    }
  } finally {
    self.Module.print = previousPrint;
  }

  return parseSegments(capturedLines);
}

/** whisper.wasm prints one line per segment: "[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text" */
function parseSegments(lines) {
  const pattern = /\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})]\s*(.*)/;
  const segments = [];
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) continue;
    const [, sh, sm, ss, sms, eh, em, es, ems, text] = match;
    const trimmed = text.trim();
    if (!trimmed) continue;
    segments.push({
      text: trimmed,
      startMs: toMs(sh, sm, ss, sms),
      endMs: toMs(eh, em, es, ems),
    });
  }
  return segments;
}

function toMs(h, m, s, ms) {
  return (((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000) + Number(ms);
}

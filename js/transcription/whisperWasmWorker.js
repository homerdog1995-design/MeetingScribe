'use strict';

/**
 * Module worker running @timur00kh/whisper.wasm (MIT), a TypeScript wrapper
 * around whisper.cpp's WebAssembly build — vendored directly into
 * assets/whisper-wasm-lib/ from its npm package (index.es.js + the bundled
 * WASM glue, ~1.3MB total; no model weights included in the package itself).
 *
 * REPLACES an earlier, hand-rolled integration against the raw Emscripten
 * Module API (Module.init/full_default) that required the user to manually
 * build or extract three files and place them in this repo. This library
 * wraps that same underlying API far more usably, and — critically — its
 * ModelManager can fetch model weights directly from Hugging Face and cache
 * them in IndexedDB itself. That means setup can now happen entirely from
 * whatever browser is running this app (including a phone), with no
 * computer or manual file placement needed at all.
 *
 * Everything here is worker-safe: the library's core classes
 * (WhisperWasmService/ModelManager/TranscriptionSession) never touch
 * `window` or `document` — only its optional browser-audio helper
 * functions do (file/mic/<audio> -> Float32Array converters), which this
 * app never imports or calls, since audio.js already produces Float32Array
 * samples through its own pipeline.
 */

import { WhisperWasmService, ModelManager } from '../../assets/whisper-wasm-lib/index.es.js';

let whisperService = null;
let modelManager = null;

self.onmessage = async (event) => {
  const { type, requestId } = event.data;
  try {
    if (type === 'load') {
      await handleLoad(event.data);
      self.postMessage({ type: 'loaded', requestId });
    } else if (type === 'transcribe') {
      const result = await handleTranscribe(event.data);
      self.postMessage({ type: 'result', requestId, segments: result });
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) });
  }
};

async function handleLoad({ modelId, requestId }) {
  modelManager = new ModelManager({ logLevel: 1 });
  whisperService = new WhisperWasmService({ logLevel: 1 });

  const supported = await whisperService.checkWasmSupport();
  if (!supported) throw new Error('WebAssembly is not supported in this browser.');

  // saveToIndexedDB=true means this only ever hits the network on the very
  // first use of a given model — every load after that (including fully
  // offline) is served from the browser's own IndexedDB cache.
  const modelBytes = await modelManager.loadModel(modelId, true, (progress) => {
    self.postMessage({ type: 'progress', requestId, progress });
  });
  await whisperService.initModel(modelBytes);
}

async function handleTranscribe({ samples, language }) {
  if (!whisperService) throw new Error('Whisper model is not loaded.');
  const floatSamples = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const { segments } = await whisperService.transcribe(floatSamples, undefined, {
    language: language || 'en',
    threads: 4,
    translate: false,
  });
  return segments.map((s) => ({ text: s.text.trim(), startMs: Math.round(s.timeStart), endMs: Math.round(s.timeEnd) }));
}

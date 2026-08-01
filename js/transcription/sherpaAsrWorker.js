'use strict';

/* eslint-env worker */
/* global importScripts, Module, createOnlineRecognizer */

/**
 * Runs sherpa-onnx's official streaming ASR engine (Zipformer model) inside
 * a dedicated Worker. This replaces the earlier @timur00kh/whisper.wasm
 * integration entirely, which crashed reliably and immediately on real
 * device testing — see transcription/README notes in ARCHITECTURE.md for
 * the full evidence trail. This engine is the same toolkit (k2-fsa/
 * sherpa-onnx, Apache-2.0) as the speaker-diarization feature, which is
 * already confirmed working in the same browser/device environment.
 *
 * WHY THIS FEEDS CONTINUOUS RAW AUDIO, NOT DISCRETE PRE-CHUNKED WAV FILES:
 * this engine has real, built-in endpoint detection (an acoustic signal
 * for "an utterance just ended"), which is what actually fixes the
 * repeated-words problem Web Speech had — that bug came from committing
 * still-growing, not-yet-finalized text as if it were final. Chunking the
 * audio ourselves first (as the old Whisper integration did) would throw
 * away exactly the signal this engine is designed to provide. audio.js
 * streams small continuous frames instead; this worker feeds them straight
 * into the recognizer's stream and only ever reports text back to the
 * main thread once the engine itself confirms an utterance boundary.
 *
 * WHY THE MODEL FILE IS SPLIT INTO PARTS: the model data (~191MB) exceeds
 * GitHub's 100MB-per-file limit for a normal git push, and — confirmed by
 * directly checking response headers — GitHub's release-asset host does
 * not send CORS headers, so the browser can't fetch it from there either
 * (the same class of problem that blocked the Whisper model download
 * path). Splitting it into <100MB parts, committing them into this same
 * repo, and reassembling them here via same-origin fetch() sidesteps
 * relying on any third-party host's CORS policy at all.
 */

const ASSET_BASE = './assets/speech-recognition/';
const DATA_PARTS = ['sherpa-onnx-wasm-main-asr.data.part00', 'sherpa-onnx-wasm-main-asr.data.part01', 'sherpa-onnx-wasm-main-asr.data.part02'];

let recognizer = null;
let stream = null;

async function buildReassembledDataUrl(onProgress) {
  const buffers = [];
  let loaded = 0;
  for (const [index, partName] of DATA_PARTS.entries()) {
    const response = await fetch(`${ASSET_BASE}${partName}`);
    if (!response.ok) throw new Error(`Failed to fetch model part ${index + 1}/${DATA_PARTS.length} (HTTP ${response.status})`);
    const buffer = await response.arrayBuffer();
    buffers.push(buffer);
    loaded += buffer.byteLength;
    onProgress?.(index + 1, DATA_PARTS.length, loaded);
  }
  const blob = new Blob(buffers, { type: 'application/octet-stream' });
  return URL.createObjectURL(blob);
}

function waitForRuntime() {
  return new Promise((resolve) => {
    const previous = self.Module.onRuntimeInitialized;
    self.Module.onRuntimeInitialized = () => {
      if (typeof previous === 'function') previous();
      resolve();
    };
  });
}

self.onmessage = async (event) => {
  const { type, requestId } = event.data;
  try {
    if (type === 'load') {
      const dataBlobUrl = await buildReassembledDataUrl((partIndex, totalParts, loadedBytes) => {
        self.postMessage({ type: 'progress', requestId, partIndex, totalParts, loadedBytes });
      });

      self.Module = self.Module || {};
      self.Module.locateFile = (path) => (path.endsWith('.data') ? dataBlobUrl : `${ASSET_BASE}${path}`);

      const runtimeReady = waitForRuntime();
      importScripts(`${ASSET_BASE}sherpa-onnx-asr.js`, `${ASSET_BASE}sherpa-onnx-wasm-main-asr.js`);
      await runtimeReady;

      recognizer = createOnlineRecognizer(self.Module);
      stream = recognizer.createStream();
      self.postMessage({ type: 'loaded', requestId, sampleRate: 16000 });
    } else if (type === 'feed') {
      if (!recognizer || !stream) throw new Error('ASR model is not loaded.');
      const samples = event.data.samples instanceof Float32Array ? event.data.samples : new Float32Array(event.data.samples);

      stream.acceptWaveform(16000, samples);
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      const isEndpoint = recognizer.isEndpoint(stream);
      const text = recognizer.getResult(stream).text.trim();
      if (isEndpoint) {
        recognizer.reset(stream);
      }
      self.postMessage({ type: 'result', requestId, text, isEndpoint });
    } else if (type === 'reset') {
      if (recognizer && stream) recognizer.reset(stream);
      self.postMessage({ type: 'ok', requestId });
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) });
  }
};

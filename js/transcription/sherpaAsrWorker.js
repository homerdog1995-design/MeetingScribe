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

// Relative to THIS FILE's own location (js/transcription/sherpaAsrWorker.js),
// not the site root — fetch()/importScripts() inside a Worker resolve
// against the worker's own script URL (self.location), not the page that
// created it. Two levels up reaches the project root, then into assets/.
const ASSET_BASE = '../../assets/speech-recognition/';
const DATA_PARTS = ['sherpa-onnx-wasm-main-asr.data.part00', 'sherpa-onnx-wasm-main-asr.data.part01', 'sherpa-onnx-wasm-main-asr.data.part02'];

// Decoding tuning — see docs/MODEL_SETUP.md for the reasoning behind each
// value and how to safely change them. modified_beam_search trades some
// speed for meaningfully better accuracy than the default greedy_search,
// which is worth it here since this already runs single-threaded (see
// sherpaAsr.js's file header on why: no SharedArrayBuffer on GitHub Pages)
// and the model itself is small/fast enough to absorb the extra cost.
const DECODING_METHOD = 'modified_beam_search';
const MAX_ACTIVE_PATHS = 8; // beam width for modified_beam_search — higher = more accurate, slower. 8 is a deliberate middle ground over the default of 4.
const RULE1_MIN_TRAILING_SILENCE = 2.4; // seconds of trailing silence that ends an utterance even with a very short amount of recognized speech so far
const RULE2_MIN_TRAILING_SILENCE = 0.8; // seconds of trailing silence that ends an utterance once *some* real speech has been recognized — tightened from the model's default of 1.2s for snappier commits in normal conversation, without going so low it risks cutting off mid-sentence pauses
const RULE3_MIN_UTTERANCE_LENGTH = 20; // seconds — a hard ceiling so one very long unbroken utterance still eventually commits

let recognizer = null;
let stream = null;

/**
 * The library's createOnlineRecognizer(Module, config) REPLACES the whole
 * config object wholesale rather than merging into the defaults — passing
 * a partial override would lose the correctly-populated model file paths
 * (baked in based on which model type this build was compiled for). So
 * this creates a recognizer once with no override to get those paths
 * correctly populated, reads them back off the result, then creates the
 * real recognizer with just the decoding-related fields overridden on top
 * of that verified-correct base config.
 */
function createTunedRecognizer() {
  const probeRecognizer = createOnlineRecognizer(self.Module);
  const baseConfig = probeRecognizer.config;
  probeRecognizer.free();

  return createOnlineRecognizer(self.Module, {
    ...baseConfig,
    decodingMethod: DECODING_METHOD,
    maxActivePaths: MAX_ACTIVE_PATHS,
    rule1MinTrailingSilence: RULE1_MIN_TRAILING_SILENCE,
    rule2MinTrailingSilence: RULE2_MIN_TRAILING_SILENCE,
    rule3MinUtteranceLength: RULE3_MIN_UTTERANCE_LENGTH,
  });
}

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

      recognizer = createTunedRecognizer();
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

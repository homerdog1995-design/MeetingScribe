'use strict';

/* eslint-env worker */
/* global importScripts, Module, createOfflineSpeakerDiarization */

/**
 * Runs sherpa-onnx's offline speaker-diarization pipeline (pyannote speech
 * segmentation + a speaker-embedding network + clustering) inside a
 * dedicated Worker, so extracting embeddings across a full recording never
 * blocks the UI. This is genuinely different from the round-robin
 * silence-gap heuristic used for live transcription: it listens to actual
 * voice characteristics and clusters them, the same category of technique
 * real diarization products use — just running fully on-device.
 *
 * This engine is offline-only (batch) by nature: clustering needs
 * embeddings from across the whole conversation to group speakers
 * correctly, so it only makes sense as a "detect speakers" pass over a
 * *finished* recording, not a live indicator during recording.
 */

const ASSET_BASE = './assets/speaker-diarization/';

self.Module = self.Module || {};
// Explicit override rather than relying on the glue script's own
// auto-detected scriptDirectory: that detection is based on this worker's
// *own* script URL, not the co-located .wasm/.data files' actual location,
// since those are pulled in via importScripts rather than being this
// worker's entry point.
self.Module.locateFile = (path) => `${ASSET_BASE}${path}`;

let sd = null;
let runtimeReadyPromise = null;

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
      runtimeReadyPromise = waitForRuntime();
      importScripts(`${ASSET_BASE}sherpa-onnx-speaker-diarization.js`, `${ASSET_BASE}sherpa-onnx-wasm-main-speaker-diarization.js`);
      await runtimeReadyPromise;
      sd = createOfflineSpeakerDiarization(self.Module);
      self.postMessage({ type: 'loaded', requestId, sampleRate: sd.sampleRate });
    } else if (type === 'diarize') {
      const { samples, numSpeakers, threshold } = event.data;
      if (!sd) throw new Error('Diarization model is not loaded.');
      sd.setConfig({ clustering: { numClusters: numSpeakers ?? -1, threshold: threshold ?? 0.5 } });
      const segments = sd.process(samples);
      self.postMessage({ type: 'result', requestId, segments });
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) });
  }
};

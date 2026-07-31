'use strict';

/**
 * diarization.js — true acoustic speaker diarization, powered by a vendored
 * sherpa-onnx WebAssembly build (Apache-2.0), which bundles a pyannote
 * speech-segmentation model and a speaker-embedding network. Unlike the
 * live round-robin heuristic in editor.js (which only guesses from pause
 * length, since Whisper/Web Speech give no real speaker signal), this
 * clusters actual voice embeddings extracted from the recording — the same
 * category of approach real diarization products use.
 *
 * This only works on a meeting that has actual saved audio
 * (meeting.recording_path) — Web Speech's transcript-only mode (see
 * recording.js) never saves audio at all, so there is nothing to analyze
 * for those meetings.
 */

const ASSET_BASE = './assets/speaker-diarization/';
const REQUIRED_FILES = ['sherpa-onnx-wasm-main-speaker-diarization.data', 'sherpa-onnx-wasm-main-speaker-diarization.wasm', 'sherpa-onnx-speaker-diarization.js'];

let worker = null;
let requestSeq = 0;
const pending = new Map();
let sampleRate = null;
let loadPromise = null;

export async function isAvailable() {
  try {
    const responses = await Promise.all(REQUIRED_FILES.map((name) => fetch(`${ASSET_BASE}${name}`, { method: 'HEAD' })));
    return responses.every((r) => r.ok);
  } catch {
    return false;
  }
}

function call(type, payload, transferList = []) {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    worker.postMessage({ type, requestId, ...payload }, transferList);
  });
}

function handleWorkerMessage(data) {
  const request = pending.get(data.requestId);
  if (!request) return;
  pending.delete(data.requestId);
  if (data.type === 'error') request.reject(new Error(data.message));
  else request.resolve(data);
}

/** The model download is ~56MB (bundled models included) — only actually fetched the first time this is used, and cached by the service worker afterward. */
async function ensureLoaded() {
  if (sampleRate !== null) return;
  if (!loadPromise) {
    worker = new Worker(new URL('./diarizationWorker.js', import.meta.url));
    worker.onmessage = (event) => handleWorkerMessage(event.data);
    loadPromise = call('load', {}).then((result) => { sampleRate = result.sampleRate; });
  }
  await loadPromise;
}

/**
 * @param {Blob} audioBlob - the meeting's full recording
 * @param {{numSpeakers?: number}} [options] - omit numSpeakers (or pass -1) to let the model auto-detect how many speakers there are
 * @returns {Promise<Array<{startMs: number, endMs: number, speaker: number}>>} speaker is a 0-indexed cluster id, sorted by start time
 */
export async function diarizeRecording(audioBlob, { numSpeakers } = {}) {
  await ensureLoaded();

  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
  const decoded = await audioContext.decodeAudioData(arrayBuffer);
  // .slice() makes an independent copy so the buffer can be transferred to
  // the worker (zero-copy) without touching the AudioContext's own data.
  const samples = decoded.getChannelData(0).slice();

  const result = await call('diarize', { samples, numSpeakers: numSpeakers ?? -1 }, [samples.buffer]);
  return result.segments
    .map((seg) => ({ startMs: Math.round(seg.start * 1000), endMs: Math.round(seg.end * 1000), speaker: seg.speaker }))
    .sort((a, b) => a.startMs - b.startMs);
}

export function unload() {
  worker?.terminate();
  worker = null;
  sampleRate = null;
  loadPromise = null;
  pending.clear();
}

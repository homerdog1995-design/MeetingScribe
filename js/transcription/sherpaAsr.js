'use strict';

import { TranscriptionProvider } from './providerBase.js';
import { settingsStore } from '../settingsStore.js';
import { logger } from '../logger.js';

/**
 * Sherpa-ONNX streaming ASR (Zipformer model), replacing the earlier
 * @timur00kh/whisper.wasm integration entirely. See sherpaAsrWorker.js's
 * file header for the full reasoning — same proven WASM toolkit as the
 * working diarization feature, real built-in endpoint detection (fixing
 * the repeated-words problem architecturally rather than by patching), and
 * it runs on audio this app is already capturing, so there's no
 * microphone-conflict problem the way Web Speech has.
 *
 * Unlike every other provider here, this one is fed continuously (see
 * audio.js's 'pcm-frame' event and recording.js's wiring) rather than
 * discrete pre-chunked buffers — chunking the audio ourselves first would
 * throw away the exact signal (the engine's own endpoint detection) that
 * this integration depends on.
 */
export class SherpaAsrProvider extends TranscriptionProvider {
  constructor() {
    super();
    this._worker = null;
    this._requestSeq = 0;
    this._pending = new Map();
    this._streamElapsedMs = 0; // total audio fed so far, i.e. this session's absolute timeline
    this._queue = Promise.resolve();
    this._consecutiveFailures = 0;
    this._pendingFrameCount = 0;
    this._pendingSegments = []; // completed VAD segments awaiting dispatch
  }

  get label() { return 'Whisper (on-device)'; }

  async isAvailable() {
    const settings = await settingsStore.get();
    if (!settings.engines.sherpaAsr.enabled) return false;
    // The engine files are committed directly into this repo (same-origin,
    // no per-user download/setup step) — if this ever fails, it means
    // something is wrong with the deployment itself, not something the
    // user needs to configure.
    try {
      const response = await fetch('./assets/speech-recognition/sherpa-onnx-wasm-main-vad-asr.js', { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async start() {
    this._streamElapsedMs = 0;
    this._pendingSegments = [];
    await this._spawnWorker();
  }

  async _spawnWorker() {
    this._worker?.terminate();
    this._worker = new Worker(new URL('./sherpaAsrWorker.js', import.meta.url));
    this._worker.onmessage = (event) => this._handleWorkerMessage(event.data);
    this._worker.onerror = (event) => {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: event.message || 'Sherpa ASR worker crashed', fatal: true } }));
    };
    await this._call('load', {});
  }

  /**
   * @param {{samples: Float32Array}} detail - a small continuous frame of
   * 16kHz mono audio, not a pre-chunked utterance. Queued rather than
   * processed immediately: every frame is guaranteed to be processed, in
   * order, none dropped — the actual risk in a continuous-streaming
   * design isn't a chunk-boundary word loss (there are no chunk
   * boundaries), it's the queue quietly growing if single-threaded
   * processing can't keep up with real-time audio arrival on a slower
   * device. That's monitored below rather than left invisible.
   */
  async submitAudioChunk({ samples }) {
    this._pendingFrameCount += 1;
    this._queue = this._queue.then(() => this._processFrame(samples));
    return this._queue;
  }

  async _processFrame(samples) {
    this._pendingFrameCount -= 1;
    const QUEUE_DEPTH_WARNING_THRESHOLD = 10; // ~1-2s of backlog at typical frame sizes — worth knowing about, not yet a hard problem
    if (this._pendingFrameCount >= QUEUE_DEPTH_WARNING_THRESHOLD && this._pendingFrameCount % 10 === 0) {
      logger.warn('sherpaAsr', 'Processing is falling behind real-time audio — the live transcript may lag noticeably', { pendingFrames: this._pendingFrameCount });
    }
    if (!this._worker) return;

    const frameDurationMs = (samples.length / 16000) * 1000;
    const frameEndMs = this._streamElapsedMs + frameDurationMs;
    this._streamElapsedMs = frameEndMs;

    try {
      const { results } = await this._call('feed', { samples }, [samples.buffer]);
      this._consecutiveFailures = 0;
      if (!Array.isArray(results) || results.length === 0) return;

      // Each result is one complete, VAD-delimited utterance that Whisper
      // decoded as a whole. Their timestamps are reconstructed by working
      // backwards from the current stream position using each segment's
      // own duration: the VAD only surfaces a segment once it has ended,
      // so "it ended around now, and it lasted this long" is the accurate
      // reading — far better than the previous engine's approximation,
      // though still not sample-exact.
      let cursorMs = frameEndMs;
      for (const result of results.slice().reverse()) {
        const endMs = cursorMs;
        const startMs = Math.max(0, endMs - result.durationMs);
        cursorMs = startMs;
        this._pendingSegments.unshift({ text: result.text, startMs, endMs });
      }

      while (this._pendingSegments.length) {
        const segment = this._pendingSegments.shift();
        this.dispatchEvent(new CustomEvent('segment', {
          detail: {
            text: segment.text,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speakerTurn: false, // a VAD segment boundary means "speech paused", not "a different person is speaking" — editor.js's gap heuristic and the diarization pass handle speaker attribution
            confidence: null,
          },
        }));
      }
    } catch (error) {
      this._consecutiveFailures += 1;
      logger.error('sherpaAsr', 'Frame processing failed', { message: error.message, consecutiveFailures: this._consecutiveFailures });

      const REPEATED_FAILURE_THRESHOLD = 3;
      if (this._consecutiveFailures >= REPEATED_FAILURE_THRESHOLD) {
        await settingsStore.set({ engines: { sherpaAsr: { enabled: false } } });
        this.dispatchEvent(new CustomEvent('error', {
          detail: {
            message: 'Speech recognition failed repeatedly and has been turned off automatically. Future recordings will use Web Speech instead — see Settings → AI Engines to re-enable it.',
            fatal: true,
          },
        }));
        this._worker?.terminate();
        this._worker = null;
        return;
      }

      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Speech recognition error: ${error.message}`, fatal: false } }));
      try {
        await this._spawnWorker();
      } catch (reloadError) {
        logger.error('sherpaAsr', 'Worker recovery failed', { message: reloadError.message });
        this.dispatchEvent(new CustomEvent('error', { detail: { message: `Could not recover speech recognition: ${reloadError.message}`, fatal: true } }));
      }
    }
  }

  async stop() {
    await this._queue.catch(() => {});
    this._worker?.terminate();
    this._worker = null;
    this._pending.clear();
  }

  _call(type, payload, transferList = []) {
    const requestId = ++this._requestSeq;
    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      this._worker.postMessage({ type, requestId, ...payload }, transferList);
    });
  }

  _handleWorkerMessage(data) {
    if (data.type === 'progress') return; // only relevant to a future model-download-progress UI, if ever needed — the model is committed directly into the repo, so there's no per-user download step to show progress for
    const pending = this._pending.get(data.requestId);
    if (!pending) return;
    this._pending.delete(data.requestId);
    if (data.type === 'error') pending.reject(new Error(data.message));
    else if (data.type === 'loaded') pending.resolve();
    else if (data.type === 'result') pending.resolve({ results: data.results ?? [], speechActive: data.speechActive });
    else if (data.type === 'ok') pending.resolve();
  }
}

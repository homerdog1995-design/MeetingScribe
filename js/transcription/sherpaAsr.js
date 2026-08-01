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
    this._utteranceStartMs = 0; // when the current, not-yet-committed utterance began
    this._streamElapsedMs = 0; // total audio fed so far, i.e. this session's absolute timeline
    this._queue = Promise.resolve();
    this._consecutiveFailures = 0;
    this._pendingFrameCount = 0;
    this._hasObservedSignalThisUtterance = false; // guards against committing hallucinated text if the model outputs something despite every fed frame being pure silence/ambient noise
  }

  get label() { return 'Sherpa-ONNX ASR (on-device)'; }

  async isAvailable() {
    const settings = await settingsStore.get();
    if (!settings.engines.sherpaAsr.enabled) return false;
    // The engine files are committed directly into this repo (same-origin,
    // no per-user download/setup step) — if this ever fails, it means
    // something is wrong with the deployment itself, not something the
    // user needs to configure.
    try {
      const response = await fetch('./assets/speech-recognition/sherpa-onnx-wasm-main-asr.js', { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async start() {
    this._utteranceStartMs = 0;
    this._streamElapsedMs = 0;
    this._hasObservedSignalThisUtterance = false;
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
  async submitAudioChunk({ samples, hasSignal }) {
    this._pendingFrameCount += 1;
    this._queue = this._queue.then(() => this._processFrame(samples, hasSignal));
    return this._queue;
  }

  async _processFrame(samples, hasSignal) {
    this._pendingFrameCount -= 1;
    if (hasSignal) this._hasObservedSignalThisUtterance = true;
    const QUEUE_DEPTH_WARNING_THRESHOLD = 10; // ~1-2s of backlog at typical frame sizes — worth knowing about, not yet a hard problem
    if (this._pendingFrameCount >= QUEUE_DEPTH_WARNING_THRESHOLD && this._pendingFrameCount % 10 === 0) {
      logger.warn('sherpaAsr', 'Processing is falling behind real-time audio — the live transcript may lag noticeably', { pendingFrames: this._pendingFrameCount });
    }
    if (!this._worker) return;
    const frameDurationMs = (samples.length / 16000) * 1000;
    const frameStartMs = this._streamElapsedMs;
    this._streamElapsedMs += frameDurationMs;

    try {
      const { text: rawText, isEndpoint } = await this._call('feed', { samples }, [samples.buffer]);
      const text = normalizeCasing(rawText);
      this._consecutiveFailures = 0;
      // Confirmed via real device testing: this class of streaming model
      // can hallucinate short, plausible-sounding filler words ("and",
      // "the") from pure silence/ambient noise, especially with beam
      // search actively searching for higher-scoring output rather than
      // committing to blank/silence. Regardless of the exact cause,
      // trusting output the engine claims is final when every fed frame
      // this utterance was genuinely below the noise floor would mean
      // inserting fabricated content into a meeting transcript, which is
      // worse than briefly missing a word. This is deliberately
      // independent of the audio-preprocessing fix (audio.js's
      // NOISE_FLOOR_RMS) — a second, cheap safeguard, not a replacement
      // for getting the input-side fix right.
      if (isEndpoint && text && !this._hasObservedSignalThisUtterance) {
        logger.warn('sherpaAsr', 'Discarded likely-hallucinated result — no real signal observed this utterance', { text });
        this._utteranceStartMs = frameStartMs + frameDurationMs;
        this._hasObservedSignalThisUtterance = false;
        return;
      }
      if (isEndpoint && text) {
        this.dispatchEvent(new CustomEvent('segment', {
          detail: {
            text,
            startMs: this._utteranceStartMs,
            endMs: frameStartMs + frameDurationMs,
            speakerTurn: false, // an endpoint means "an utterance just ended", not "a different person is now speaking" — editor.js's own gap-based heuristic still decides speaker turns, now with genuinely meaningful timestamps instead of Web Speech's "always now"
            confidence: null,
          },
        }));
      }
      if (isEndpoint) {
        this._utteranceStartMs = frameStartMs + frameDurationMs;
        this._hasObservedSignalThisUtterance = false;
      }
    } catch (error) {
      this._consecutiveFailures += 1;
      logger.error('sherpaAsr', 'Frame processing failed', { message: error.message, consecutiveFailures: this._consecutiveFailures });

      const REPEATED_FAILURE_THRESHOLD = 3;
      if (this._consecutiveFailures >= REPEATED_FAILURE_THRESHOLD) {
        // Failing this consistently means retrying indefinitely has no
        // realistic path to success this session — self-disable so future
        // recordings fall back to Web Speech automatically instead of
        // requiring a manual trip to Settings.
        await settingsStore.set({ engines: { sherpaAsr: { enabled: false } } });
        this.dispatchEvent(new CustomEvent('error', {
          detail: {
            message: 'Sherpa ASR failed repeatedly and has been turned off automatically. Future recordings will use Web Speech instead — see Settings → AI Engines to re-enable it.',
            fatal: true,
          },
        }));
        this._worker?.terminate();
        this._worker = null;
        return;
      }

      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Sherpa ASR error: ${error.message}`, fatal: false } }));
      try {
        await this._spawnWorker();
      } catch (reloadError) {
        logger.error('sherpaAsr', 'Worker recovery failed', { message: reloadError.message });
        this.dispatchEvent(new CustomEvent('error', { detail: { message: `Could not recover Sherpa ASR: ${reloadError.message}`, fatal: true } }));
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
    else if (data.type === 'result') pending.resolve({ text: data.text, isEndpoint: data.isEndpoint });
    else if (data.type === 'ok') pending.resolve();
  }
}

/**
 * This streaming checkpoint was trained on text with casing stripped
 * during preprocessing (a common choice for CTC/transducer ASR training,
 * since raw acoustic modeling doesn't need it) — it never learned casing
 * at all, which is why its raw output is ALL CAPS. This is a
 * post-processing fix, not something tunable in the model itself:
 * lowercase everything, then restore the casing conventions a reader
 * actually expects.
 */
function normalizeCasing(rawText) {
  if (!rawText) return rawText;
  let text = rawText.toLowerCase();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  text = text.replace(/([.!?]\s+)([a-z])/g, (_, sep, letter) => sep + letter.toUpperCase());
  text = text.replace(/\bi\b/g, 'I');
  return text;
}

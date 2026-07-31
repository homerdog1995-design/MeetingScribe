'use strict';

import { TranscriptionProvider } from './providerBase.js';
import { settingsStore } from '../settingsStore.js';
import { logger } from '../logger.js';

/**
 * Runs whisper.cpp entirely in the browser, on-device, via a vendored
 * library (@timur00kh/whisper.wasm, MIT — assets/whisper-wasm-lib/). This
 * is priority #1 in the provider chain (transcription.js): the only fully
 * offline, on-device transcription engine, since whisper.cpp/faster-whisper
 * (native binaries) can't run in a browser under any circumstances.
 *
 * Unlike the earlier hand-rolled integration, this one requires no manual
 * file setup at all — see settings.js's downloadAndEnableWhisperWasm(),
 * which lets the model be fetched and cached (via the library's own
 * IndexedDB caching) directly from whatever browser is running this app.
 * isAvailable() simply checks the settings flag that gets set true once
 * that has happened successfully at least once.
 *
 * CRASH RECOVERY: the underlying WASM engine can hit a low-level Emscripten
 * abort() on bad input (confirmed via real device testing — a very short
 * trailing audio fragment on stop() was one real trigger, now fixed at the
 * source in audio.js's _flushChunk). Once that happens, the engine's
 * internal state is permanently corrupted — Emscripten's runtime doesn't
 * recover from abort(), and every subsequent call fails immediately
 * ("Already transcribing", since its busy flag never gets cleared). Rather
 * than let one bad chunk silently kill transcription for the rest of the
 * recording, chunk processing is serialized through a queue (so concurrent
 * calls can't race into that same failure mode) and a failed chunk triggers
 * a full worker replacement (terminate + recreate + reload the model, which
 * is fast since it's cached in IndexedDB) so transcription can continue on
 * the next chunk instead of staying wedged.
 */
export class WhisperWasmProvider extends TranscriptionProvider {
  constructor() {
    super();
    this._worker = null;
    this._requestSeq = 0;
    this._pending = new Map();
    this._language = 'en';
    this._modelId = 'base.en';
    this._queue = Promise.resolve();
  }

  get label() { return 'Whisper WASM (on-device)'; }

  async isAvailable() {
    const settings = await settingsStore.get();
    return Boolean(settings.engines.whisperWasm.enabled);
  }

  async start({ language }) {
    const settings = await settingsStore.get();
    this._language = language || 'en';
    this._modelId = settings.engines.whisperWasm.modelId || 'base.en';
    await this._spawnWorker();
  }

  async _spawnWorker() {
    this._worker?.terminate();
    this._worker = new Worker(new URL('./whisperWasmWorker.js', import.meta.url), { type: 'module' });
    this._worker.onmessage = (event) => this._handleWorkerMessage(event.data);
    this._worker.onerror = (event) => {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: event.message || 'Whisper WASM worker crashed', fatal: true } }));
    };
    // The model should already be cached from Settings by the time
    // recording starts (see downloadAndEnableWhisperWasm) — this load is
    // expected to be fast (IndexedDB, no network) in the normal case, and
    // also fast when re-run after a crash for the same reason.
    await this._call('load', { modelId: this._modelId });
  }

  async submitAudioChunk({ wavBuffer, startMs }) {
    // Serialized: never let two transcribe() calls race into the engine at
    // once, which would trip the same "Already transcribing" failure mode
    // that recovering from an actual abort also has to handle.
    this._queue = this._queue.then(() => this._processChunk(wavBuffer, startMs));
    return this._queue;
  }

  async _processChunk(wavBuffer, startMs) {
    if (!this._worker) return;
    try {
      const samples = decodeWavPcm16ToFloat32(wavBuffer);
      const segments = await this._call('transcribe', { samples, language: this._language }, [samples.buffer]);
      for (const segment of segments) {
        this.dispatchEvent(new CustomEvent('segment', {
          detail: {
            text: segment.text,
            startMs: startMs + segment.startMs,
            endMs: startMs + segment.endMs,
            speakerTurn: false, // no speaker-turn signal from this engine; the silence-gap fallback in editor.js handles it
            confidence: null,
          },
        }));
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Skipped one chunk after an engine error: ${error.message}`, fatal: false } }));
      // The engine's internal state can't be trusted after any failure here
      // (see file header) — replace the whole worker so the *next* chunk
      // has a clean, working engine instead of inheriting a wedged one.
      try {
        await this._spawnWorker();
      } catch (reloadError) {
        this.dispatchEvent(new CustomEvent('error', { detail: { message: `Could not recover Whisper WASM: ${reloadError.message}`, fatal: true } }));
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
    if (data.type === 'diagnostic') { logger.info('whisperWasm', data.message); return; }
    const pending = this._pending.get(data.requestId);
    if (!pending) return;
    if (data.type === 'progress') return; // only relevant to Settings' download flow, not live transcription
    this._pending.delete(data.requestId);
    if (data.type === 'error') pending.reject(new Error(data.message));
    else if (data.type === 'loaded') pending.resolve();
    else if (data.type === 'result') pending.resolve(data.segments);
  }
}

/** The WAV chunks handed to providers are always 16-bit PCM mono, written by js/audio.js's encodeWavPcm16() with a fixed 44-byte header. */
function decodeWavPcm16ToFloat32(wavArrayBuffer) {
  const HEADER_BYTES = 44;
  const view = new DataView(wavArrayBuffer);
  const sampleCount = (wavArrayBuffer.byteLength - HEADER_BYTES) / 2;
  const floatSamples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(HEADER_BYTES + i * 2, true);
    floatSamples[i] = int16 / (int16 < 0 ? 0x8000 : 0x7fff);
  }
  return floatSamples;
}

'use strict';

import { TranscriptionProvider } from './providerBase.js';

/**
 * Runs whisper.cpp entirely inside the renderer via WebAssembly, in a
 * dedicated Worker (whisperWasmWorker.js). This is priority #3 in the
 * provider chain — used when neither whisper.cpp nor faster-whisper are
 * installed as native binaries, but the user has placed a WASM build under
 * assets/whisper-wasm/ per docs/MODEL_SETUP.md, Option C.
 *
 * Expected files in that directory (matching main/modelDetection.js's
 * detection logic exactly, so "detected" in Settings means it will actually
 * load here too):
 *   whisper.js      — Emscripten-generated glue/loader script
 *   whisper.wasm     — the compiled WASM binary (fetched automatically by
 *                       whisper.js itself, via a relative URL — this class
 *                       never touches it directly)
 *   ggml-*.bin       — one or more GGML model files; the first one found is used
 */
export class WhisperWasmProvider extends TranscriptionProvider {
  constructor() {
    super();
    this._worker = null;
    this._requestSeq = 0;
    this._pending = new Map();
  }

  get label() { return 'Whisper WASM (in-browser)'; }

  async isAvailable() {
    const detection = await window.api.models.detect();
    return Boolean(detection?.whisperWasm?.available && detection.whisperWasm.models?.length);
  }

  async start() {
    const info = await window.api.system.getInfo();
    const detection = await window.api.models.detect();
    const modelFilename = detection?.whisperWasm?.models?.[0];
    if (!modelFilename) {
      throw new Error('No ggml-*.bin model file found in assets/whisper-wasm/. See docs/MODEL_SETUP.md, Option C.');
    }

    const glueScriptUrl = this._assetUrl(info.whisperWasmAssetsDir, 'whisper.js');
    const modelUrl = this._assetUrl(info.whisperWasmAssetsDir, modelFilename);

    this._worker = new Worker(new URL('./whisperWasmWorker.js', import.meta.url));
    this._worker.onmessage = (event) => this._handleWorkerMessage(event.data);
    this._worker.onerror = (event) => {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: event.message || 'Whisper WASM worker crashed', fatal: true } }));
    };

    await this._call('load', { glueScriptUrl, modelUrl });
  }

  async submitAudioChunk({ wavBuffer, startMs }) {
    if (!this._worker) return;
    try {
      const samples = decodeWavPcm16ToFloat32(wavBuffer);
      const segments = await this._call('transcribe', { samples }, [samples.buffer]);
      for (const segment of segments) {
        this.dispatchEvent(new CustomEvent('segment', {
          detail: {
            text: segment.text,
            startMs: startMs + segment.startMs,
            endMs: startMs + segment.endMs,
            speakerTurn: false, // no speaker-turn signal from this engine; silence-gap fallback handles it
            confidence: null,
          },
        }));
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: error.message, fatal: false } }));
    }
  }

  async stop() {
    this._worker?.terminate();
    this._worker = null;
    this._pending.clear();
  }

  // eslint-disable-next-line class-methods-use-this
  _assetUrl(assetsDir, filename) {
    const normalized = assetsDir.replace(/\\/g, '/');
    const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return `file://${withLeadingSlash}/${filename}`;
  }

  _call(type, payload, transferList = []) {
    const requestId = ++this._requestSeq;
    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      this._worker.postMessage({ type, requestId, ...payload }, transferList);
    });
  }

  _handleWorkerMessage(data) {
    const pending = this._pending.get(data.requestId);
    if (!pending) return;
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

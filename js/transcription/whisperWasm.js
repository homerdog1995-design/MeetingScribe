'use strict';

import { TranscriptionProvider } from './providerBase.js';

/**
 * Runs whisper.cpp entirely inside the page via WebAssembly, in a dedicated
 * Worker (whisperWasmWorker.js). This is now priority #1 in the provider
 * chain (see transcription.js) — with whisper.cpp/faster-whisper gone
 * (neither can run in a browser, since both require spawning a native
 * binary), this is the only remaining engine that transcribes fully
 * offline, on-device.
 *
 * CHANGED FROM THE ELECTRON VERSION: assets used to be discovered via an
 * absolute filesystem path (window.api.system.getInfo().whisperWasmAssetsDir)
 * and a directory scan for any `ggml-*.bin` file (main/modelDetection.js).
 * Browsers cannot list directory contents at all, so there is no way to
 * "discover" an arbitrary model filename anymore. Instead, the three
 * required files are fetched by a FIXED relative path within the app
 * itself — the user must name the model file exactly `ggml-model.bin`.
 * This is a real reduction in flexibility (previously any ggml-*.bin name
 * worked) but is the only option without a server-side directory listing.
 *
 * Expected files, relative to the app's own origin (see docs/MODEL_SETUP.md,
 * Option C, for exactly how to produce/place them):
 *   assets/whisper-wasm/whisper.js       — Emscripten-generated glue/loader
 *   assets/whisper-wasm/whisper.wasm     — compiled WASM binary (fetched
 *                                           automatically by whisper.js
 *                                           itself; this class never touches
 *                                           it directly)
 *   assets/whisper-wasm/ggml-model.bin   — the GGML model file (fixed name)
 */
const ASSET_BASE = './assets/whisper-wasm/';

export class WhisperWasmProvider extends TranscriptionProvider {
  constructor() {
    super();
    this._worker = null;
    this._requestSeq = 0;
    this._pending = new Map();
  }

  get label() { return 'Whisper WASM (in-browser, on-device)'; }

  async isAvailable() {
    try {
      const [glueResponse, modelResponse] = await Promise.all([
        fetch(`${ASSET_BASE}whisper.js`, { method: 'HEAD' }),
        fetch(`${ASSET_BASE}ggml-model.bin`, { method: 'HEAD' }),
      ]);
      return glueResponse.ok && modelResponse.ok;
    } catch {
      return false;
    }
  }

  async start() {
    this._worker = new Worker(new URL('./whisperWasmWorker.js', import.meta.url));
    this._worker.onmessage = (event) => this._handleWorkerMessage(event.data);
    this._worker.onerror = (event) => {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: event.message || 'Whisper WASM worker crashed', fatal: true } }));
    };

    await this._call('load', {
      glueScriptUrl: new URL(`${ASSET_BASE}whisper.js`, window.location.href).href,
      modelUrl: new URL(`${ASSET_BASE}ggml-model.bin`, window.location.href).href,
    });
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

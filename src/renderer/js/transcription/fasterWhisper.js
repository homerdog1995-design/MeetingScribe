'use strict';

import { TranscriptionProvider } from './providerBase.js';

/**
 * Wraps main/ipcHandlers.js's transcription:runFasterWhisper channel, which
 * spawns scripts/faster_whisper_bridge.py in the main process. Same
 * serialized-queue approach as WhisperCppProvider, since each invocation
 * pays Python + model-load overhead and running several in parallel would
 * only slow each other down on typical hardware.
 *
 * Like the whisper.cpp provider, the main process reads model size/device/
 * language from settingsStore itself and returns segments with absolute
 * startMs/endMs already offset by the chunk's start time.
 */
export class FasterWhisperProvider extends TranscriptionProvider {
  constructor() {
    super();
    this._queue = Promise.resolve();
  }

  get label() { return 'Faster-Whisper (local)'; }

  async isAvailable() {
    const detection = await window.api.models.detect();
    return Boolean(detection?.fasterWhisper?.available);
  }

  // eslint-disable-next-line class-methods-use-this
  async start() {
    // Nothing to initialize: each chunk spawns an independent bridge process.
  }

  async submitAudioChunk({ wavBuffer, startMs }) {
    this._queue = this._queue.then(() => this._processChunk(wavBuffer, startMs));
    return this._queue;
  }

  async _processChunk(wavBuffer, startMs) {
    try {
      const segments = await window.api.transcription.runFasterWhisper({
        arrayBuffer: wavBuffer,
        chunkStartMs: startMs,
      });
      for (const segment of segments) {
        this.dispatchEvent(new CustomEvent('segment', {
          detail: {
            text: segment.text,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speakerTurn: false, // faster-whisper's bridge does not emit speaker-turn hints; the silence-gap fallback in transcription.js covers this
            confidence: segment.confidence ?? null,
          },
        }));
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: error.message, fatal: false } }));
    }
  }

  async stop() {
    await this._queue;
  }
}

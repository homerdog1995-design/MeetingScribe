'use strict';

import { TranscriptionProvider } from './providerBase.js';

/**
 * Wraps main/ipcHandlers.js's transcription:runWhisperCpp channel. The
 * actual `whisper-cli` process is spawned in the main process (see
 * ARCHITECTURE.md's process-boundary rules) — this class only owns the
 * per-meeting queueing of chunks and translation of raw results into
 * 'segment' events.
 *
 * Note: the main process reads language/model/tinydiarize settings itself
 * (from settingsStore) and already returns segments with absolute
 * startMs/endMs (it adds chunkStartMs internally) — this class passes the
 * chunk's start offset through and uses the returned timestamps as-is.
 */
export class WhisperCppProvider extends TranscriptionProvider {
  constructor() {
    super();
    this._queue = Promise.resolve();
  }

  get label() { return 'whisper.cpp (local)'; }

  async isAvailable() {
    const detection = await window.api.models.detect();
    return Boolean(detection?.whisperCpp?.available);
  }

  // eslint-disable-next-line class-methods-use-this
  async start() {
    // Nothing to initialize: each chunk is an independent whisper-cli
    // invocation in the main process, configured from settingsStore.
  }

  async submitAudioChunk({ wavBuffer, startMs }) {
    // Serialize chunk processing: whisper-cli is a one-shot CLI process per
    // invocation, so overlapping calls would just contend for CPU with no
    // benefit — a simple queue keeps ordering and resource usage predictable.
    this._queue = this._queue.then(() => this._processChunk(wavBuffer, startMs));
    return this._queue;
  }

  async _processChunk(wavBuffer, startMs) {
    try {
      const segments = await window.api.transcription.runWhisperCpp({
        arrayBuffer: wavBuffer,
        chunkStartMs: startMs,
      });
      for (const segment of segments) {
        this.dispatchEvent(new CustomEvent('segment', {
          detail: {
            text: segment.text,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speakerTurn: Boolean(segment.speakerTurn),
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

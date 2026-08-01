'use strict';

/**
 * Contract implemented by every transcription provider (sherpaAsr.js,
 * webSpeech.js — whisperCpp.js/fasterWhisper.js existed in the desktop
 * version but were removed entirely; see transcription.js's file header).
 *
 * The orchestrator (transcription.js) and the UI only ever talk to this
 * interface, never to a specific engine — swapping which engine is active
 * requires no UI changes, per the spec's "the UI should not change
 * regardless of which engine is active" requirement.
 *
 * Providers emit a 'segment' CustomEvent with detail:
 *   {
 *     text: string,
 *     startMs: number,
 *     endMs: number,
 *     speakerTurn: boolean,   // true if the engine detected a probable speaker change
 *     confidence: number|null // 0-1 if the engine reports one, else null
 *   }
 * and a 'error' CustomEvent with detail: { message: string, fatal: boolean }.
 */
export class TranscriptionProvider extends EventTarget {
  /** @returns {Promise<boolean>} whether this engine is usable right now */
  async isAvailable() {
    throw new Error('isAvailable() must be implemented by provider');
  }

  /** @returns {string} a short human-readable engine name for the UI badge */
  get label() {
    throw new Error('label getter must be implemented by provider');
  }

  /**
   * Called once when transcription starts for a meeting.
   * @param {{ meetingId: string, language: string }} options
   */
  async start(options) {
    throw new Error('start() must be implemented by provider');
  }

  /**
   * Feeds one audio chunk (16kHz mono WAV ArrayBuffer, from js/audio.js's
   * VAD chunker) to the engine. Providers that stream live (Web Speech API)
   * may ignore this and rely on their own live recognition instead.
   * @param {{ wavBuffer: ArrayBuffer, startMs: number, endMs: number }} chunk
   */
  async submitAudioChunk(chunk) {
    throw new Error('submitAudioChunk() must be implemented by provider');
  }

  /** Called once when transcription ends for a meeting. */
  async stop() {
    throw new Error('stop() must be implemented by provider');
  }
}

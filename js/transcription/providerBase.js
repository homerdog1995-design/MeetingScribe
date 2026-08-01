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
   * @returns {boolean} true if this engine needs sole, exclusive access to
   * the microphone and can't share it with this app's own audio capture
   * (confirmed true for Web Speech via real device testing — see its file
   * header). Providers that process audio this app is already capturing
   * (the normal case) leave this false. recording.js uses this to decide
   * whether a recording needs to skip its own audio pipeline entirely
   * (transcript-only mode) — it never checks which specific engine is
   * active by name.
   */
  get needsExclusiveMicrophone() {
    return false;
  }

  /**
   * @returns {boolean} true if this engine can only report "now" as both
   * a segment's start and end time, with no real acoustic timing (true for
   * Web Speech, which has no concept of when speech actually started).
   * editor.js uses this to widen its speaker-turn silence-gap heuristic,
   * rather than checking which specific engine is active by name.
   */
  get hasApproximateTimestamps() {
    return false;
  }

  /**
   * @returns {boolean} true if this engine sends audio/data outside this
   * device (Web Speech sends audio to Google's servers) and needs the
   * persistent in-app privacy banner. Providers that run fully on-device
   * (the normal case) leave this false.
   */
  get requiresPrivacyDisclosure() {
    return false;
  }

  /**
   * Called once when transcription starts for a meeting.
   * @param {{ meetingId: string, language: string }} options
   */
  async start(options) {
    throw new Error('start() must be implemented by provider');
  }

  /**
   * Feeds one unit of audio to the engine — the shape depends on the
   * provider: a continuous small PCM frame for streaming engines (Sherpa
   * ASR), or ignored entirely for engines that listen to the microphone
   * independently (Web Speech).
   */
  async submitAudioChunk(chunk) {
    throw new Error('submitAudioChunk() must be implemented by provider');
  }

  /** Called once when transcription ends for a meeting. */
  async stop() {
    throw new Error('stop() must be implemented by provider');
  }
}

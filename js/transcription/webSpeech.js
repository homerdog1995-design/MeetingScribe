'use strict';

import { TranscriptionProvider } from './providerBase.js';
import { settingsStore } from '../settingsStore.js';

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * Priority #4, last-resort provider. UNLIKE the other three providers, this
 * one sends microphone audio to Google's servers for recognition — it is
 * NOT offline. It only activates if the user has explicitly enabled it and
 * acknowledged that disclosure in Settings (see ARCHITECTURE.md §9), and
 * `security.js` only allows the network request through after that same
 * opt-in. The #web-speech-banner stays visible in the UI for the entire
 * session whenever this provider is active.
 *
 * Platform limitation: the standard SpeechRecognition API has no way to
 * accept a custom MediaStream — it always listens to the OS default input
 * device directly. That means this provider can only usefully support
 * microphone-mode recording; for system-audio or mixed-mode recording it
 * will still run (so the UI does not need special-case logic) but it will
 * only pick up whatever mixes into the default mic capture, which is not
 * meaningful for that use case. This is disclosed rather than hidden.
 */
export class WebSpeechProvider extends TranscriptionProvider {
  constructor() {
    super();
    this._recognition = null;
    this._language = 'en-US';
    this._sessionStartPerfMs = 0;
    this._stopped = true;
  }

  get label() { return 'Web Speech API (online, not private)'; }

  async isAvailable() {
    if (!SpeechRecognitionImpl) return false;
    const settings = await settingsStore.get();
    return Boolean(settings?.engines?.webSpeech?.enabled && settings?.engines?.webSpeech?.acknowledgedDisclosure);
  }

  async start({ language }) {
    if (!SpeechRecognitionImpl) throw new Error('The Web Speech API is not available in this build of Electron.');
    this._language = toBcp47(language);
    this._stopped = false;
    this._sessionStartPerfMs = performance.now();
    this._launchRecognition();
  }

  _launchRecognition() {
    if (this._stopped) return;

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = this._language;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const text = result[0].transcript.trim();
        if (!text) continue;
        const nowMs = performance.now() - this._sessionStartPerfMs;
        this.dispatchEvent(new CustomEvent('segment', {
          detail: { text, startMs: nowMs, endMs: nowMs, speakerTurn: false, confidence: result[0].confidence ?? null },
        }));
      }
    };

    recognition.onerror = (event) => {
      const fatal = event.error === 'not-allowed' || event.error === 'service-not-allowed';
      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Web Speech API error: ${event.error}`, fatal } }));
    };

    // The browser ends a recognition session on its own after a period of
    // silence or a time limit; restart transparently so live transcription
    // continues for as long as the meeting is being recorded.
    recognition.onend = () => {
      if (!this._stopped) this._launchRecognition();
    };

    this._recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      // Android Chrome in particular can throw synchronously here (e.g.
      // InvalidStateError) if a new session starts too soon after the
      // previous one's onend — without this catch, that exception was
      // unhandled and silently ended the whole restart loop with no
      // visible error at all, which is indistinguishable from "broken."
      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Web Speech API failed to (re)start: ${error.message}`, fatal: false } }));
      if (!this._stopped) setTimeout(() => this._launchRecognition(), 300);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async submitAudioChunk() {
    // Intentionally a no-op: this engine listens to the live microphone
    // through the browser's own audio pipeline rather than consuming the
    // WAV chunks produced by js/audio.js's VAD chunker.
  }

  async stop() {
    this._stopped = true;
    this._recognition?.stop();
    this._recognition = null;
  }
}

function toBcp47(language) {
  if (!language) return 'en-US';
  if (language.includes('-')) return language;
  const REGION_HINTS = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT', it: 'it-IT' };
  return REGION_HINTS[language] || language;
}

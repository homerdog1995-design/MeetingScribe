'use strict';

import { TranscriptionProvider } from './providerBase.js';
import { settingsStore } from '../settingsStore.js';
import { logger } from '../logger.js';

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
const STALL_WATCHDOG_MS = 7000;

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

    // Chrome's continuous mode has a real-world quirk where a given result
    // index can be redelivered across onresult events (event.resultIndex
    // doesn't always reliably mark "everything before this was already
    // seen") — tracking the highest index WE'VE already committed
    // ourselves, and never processing backwards from there, is what
    // actually prevents the same finalized phrase from being turned into
    // duplicate segments (visible as repeated/echoed words in the
    // transcript). Reset per session since each new recognition object
    // starts its own fresh results array.
    this._lastProcessedResultIndex = -1;
    this._lastCommittedFinalText = null;
    this._lastCommittedFinalAtPerfMs = null;

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    // interimResults stays on purely for diagnostics and the stall
    // watchdog below — interim hypotheses are never appended anywhere,
    // never displayed, and never persisted. Only results where
    // isFinal === true are ever turned into a segment, and only once each
    // (see _lastProcessedResultIndex/_lastCommittedFinalText below) — this
    // is what actually prevents a still-growing, not-yet-finalized
    // hypothesis from being committed multiple times as it grows, which is
    // what repeated/stacked words in the transcript actually was.
    recognition.interimResults = true;
    recognition.lang = this._language;

    this._clearStallWatchdog();
    this._armStallWatchdog();

    recognition.onresult = (event) => {
      this._clearStallWatchdog();
      this._armStallWatchdog();
      const startAt = Math.max(event.resultIndex, this._lastProcessedResultIndex + 1);
      for (let i = startAt; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) {
          logger.info('webSpeech', 'Interim result (not yet committed)', { transcript: result[0].transcript });
          continue;
        }
        this._lastProcessedResultIndex = i;
        const text = result[0].transcript.trim();
        if (!text) continue;
        // Belt-and-braces: even among results Chrome marks as genuinely
        // final, a later one can occasionally be a growing revision of the
        // text just committed (editor.js also guards against this
        // downstream, but catching it here means it never leaves this
        // provider as a duplicate in the first place). Tightly time-boxed:
        // the actual growing-revision pattern this exists for happens
        // within about a second, so a wide window risks misreading two
        // different, sequential sentences that happen to share a common
        // starting word ("I", "so", "the") as one being a revision of the
        // other — which silently drops everything after the shared word.
        const nowPerf = performance.now();
        const withinRevisionWindow = this._lastCommittedFinalAtPerfMs !== null && (nowPerf - this._lastCommittedFinalAtPerfMs) < 1500;
        if (withinRevisionWindow && this._lastCommittedFinalText && text.startsWith(this._lastCommittedFinalText)) {
          this._lastCommittedFinalText = text;
          this._lastCommittedFinalAtPerfMs = nowPerf;
          continue;
        }
        this._lastCommittedFinalText = text;
        this._lastCommittedFinalAtPerfMs = nowPerf;
        logger.info('webSpeech', 'Final result committed as a segment', { text });
        const nowMs = performance.now() - this._sessionStartPerfMs;
        this.dispatchEvent(new CustomEvent('segment', {
          detail: { text, startMs: nowMs, endMs: nowMs, speakerTurn: false, confidence: result[0].confidence ?? null },
        }));
      }
    };

    recognition.onspeechstart = () => logger.info('webSpeech', 'Speech detected by the recognizer');
    recognition.onaudiostart = () => logger.info('webSpeech', 'Audio capture started for this recognition session');
    recognition.onnomatch = () => logger.warn('webSpeech', 'Speech was detected but could not be recognized (onnomatch)');

    recognition.onerror = (event) => {
      logger.error('webSpeech', 'Recognition error', { error: event.error });
      const fatal = event.error === 'not-allowed' || event.error === 'service-not-allowed';
      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Web Speech API error: ${event.error}`, fatal } }));
    };

    // The browser ends a recognition session on its own after a period of
    // silence or a time limit; restart transparently so live transcription
    // continues for as long as the meeting is being recorded.
    recognition.onend = () => {
      logger.info('webSpeech', 'Recognition session ended; restarting if still recording');
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
      logger.error('webSpeech', 'recognition.start() threw synchronously', { message: error.message });
      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Web Speech API failed to (re)start: ${error.message}`, fatal: false } }));
      if (!this._stopped) setTimeout(() => this._launchRecognition(), 300);
    }
  }

  /** If literally nothing happens (no result, no error, no speech detected) for several seconds, that's silent to the user otherwise — surface it explicitly instead of leaving an unexplained empty transcript. */
  _armStallWatchdog() {
    this._stallTimer = setTimeout(() => {
      if (this._stopped) return;
      logger.warn('webSpeech', `No recognition activity at all for ${STALL_WATCHDOG_MS}ms`);
      this.dispatchEvent(new CustomEvent('error', {
        detail: {
          message: 'Web Speech API has produced no results for several seconds. Check Settings → View diagnostics log for details, or try Sherpa-ONNX ASR instead.',
          fatal: false,
        },
      }));
    }, STALL_WATCHDOG_MS);
  }

  _clearStallWatchdog() {
    if (this._stallTimer) clearTimeout(this._stallTimer);
    this._stallTimer = null;
  }

  // eslint-disable-next-line class-methods-use-this
  async submitAudioChunk() {
    // Intentionally a no-op: this engine listens to the live microphone
    // through the browser's own audio pipeline rather than consuming the
    // WAV chunks produced by js/audio.js's VAD chunker.
  }

  async stop() {
    this._stopped = true;
    this._clearStallWatchdog();
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

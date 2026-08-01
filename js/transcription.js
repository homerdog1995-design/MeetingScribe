'use strict';

import { SherpaAsrProvider } from './transcription/sherpaAsr.js';
import { WebSpeechProvider } from './transcription/webSpeech.js';

// Priority order: Sherpa-ONNX ASR is the primary fully-offline, on-device
// engine (replaces the earlier Whisper WASM integration entirely, which
// crashed reliably on real device testing — see sherpaAsr.js's file
// header for the full evidence trail). Web Speech API remains the
// disclosed, non-offline last resort.
const PROVIDER_CHAIN = [SherpaAsrProvider, WebSpeechProvider];

/**
 * The single object the rest of the renderer talks to for live
 * transcription. It hides which concrete provider is active — per the
 * spec, "the UI should not change regardless of which engine is active."
 */
class TranscriptionManager extends EventTarget {
  constructor() {
    super();
    this._activeProvider = null;
    this._activeLabel = null;
    this._onSegment = (event) => this.dispatchEvent(new CustomEvent('segment', { detail: event.detail }));
    this._onError = (event) => this.dispatchEvent(new CustomEvent('provider-error', { detail: event.detail }));
  }

  get activeEngineLabel() {
    return this._activeLabel;
  }

  get isWebSpeech() {
    return this._activeProvider instanceof WebSpeechProvider;
  }

  /** Probes providers in priority order and returns the label of whichever would activate, without starting it. */
  async detectAvailableEngine() {
    for (const ProviderClass of PROVIDER_CHAIN) {
      const provider = new ProviderClass();
      try {
        if (await provider.isAvailable()) return provider.label;
      } catch {
        // Detection failures are treated as "not available"; keep probing the chain.
      }
    }
    return null;
  }

  async start(meetingId, { language = 'en' } = {}) {
    await this.stop();

    for (const ProviderClass of PROVIDER_CHAIN) {
      const provider = new ProviderClass();
      let available = false;
      try {
        available = await provider.isAvailable();
      } catch {
        available = false;
      }
      if (!available) continue;

      try {
        provider.addEventListener('segment', this._onSegment);
        provider.addEventListener('error', this._onError);
        await provider.start({ meetingId, language });
        this._activeProvider = provider;
        this._activeLabel = provider.label;
        this.dispatchEvent(new CustomEvent('engine-changed', { detail: { label: this._activeLabel } }));
        return this._activeLabel;
      } catch (error) {
        provider.removeEventListener('segment', this._onSegment);
        provider.removeEventListener('error', this._onError);
        this.dispatchEvent(new CustomEvent('provider-error', { detail: { message: `${provider.label} failed to start: ${error.message}`, fatal: false } }));
        // Fall through and try the next provider in the chain.
      }
    }

    this._activeProvider = null;
    this._activeLabel = null;
    this.dispatchEvent(new CustomEvent('engine-changed', { detail: { label: null } }));
    return null;
  }

  async submitAudioChunk(chunk) {
    if (!this._activeProvider) return;
    try {
      await this._activeProvider.submitAudioChunk(chunk);
    } catch (error) {
      this.dispatchEvent(new CustomEvent('provider-error', { detail: { message: error.message, fatal: false } }));
    }
  }

  async stop() {
    if (!this._activeProvider) return;
    this._activeProvider.removeEventListener('segment', this._onSegment);
    this._activeProvider.removeEventListener('error', this._onError);
    await this._activeProvider.stop();
    this._activeProvider = null;
    this._activeLabel = null;
  }
}

export const transcriptionManager = new TranscriptionManager();

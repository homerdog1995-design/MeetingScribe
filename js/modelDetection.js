'use strict';

/**
 * modelDetection.js — browser reconstruction of the old main-process
 * modelDetection.js. The original scanned the filesystem for whisper.cpp/
 * faster-whisper binaries and any assets/whisper-wasm/*.bin file; none of
 * that filesystem access exists in a browser. What's left:
 *   - Whisper WASM: fetch() HEAD checks against fixed relative paths
 *     (browsers can't list a directory, so unlike before, the model file
 *     must be named exactly `ggml-model.bin` — see whisperWasm.js).
 *   - Web Speech API: a capability check (is SpeechRecognition present in
 *     this browser) plus whether the user has enabled + acknowledged it.
 *   - Ollama / llama.cpp: unchanged in spirit (HTTP reachability checks),
 *     but now via the page's own fetch() rather than Node's HTTP client —
 *     see summaryEngine.js's file header for the CORS caveat this implies.
 */

import { settingsStore } from './settingsStore.js';
import { detectAvailableLlm } from './summaryEngine.js';
import { isAvailable as isDiarizationAvailable } from './diarization.js';

const ASSET_BASE = './assets/whisper-wasm/';

async function detectWhisperWasm() {
  try {
    const [glue, model] = await Promise.all([
      fetch(`${ASSET_BASE}whisper.js`, { method: 'HEAD' }),
      fetch(`${ASSET_BASE}ggml-model.bin`, { method: 'HEAD' }),
    ]);
    return { available: glue.ok && model.ok };
  } catch {
    return { available: false };
  }
}

async function detectWebSpeech(settings) {
  const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  return {
    supported,
    enabled: supported && Boolean(settings.engines.webSpeech.enabled && settings.engines.webSpeech.acknowledgedDisclosure),
  };
}

export async function detectAll() {
  const settings = await settingsStore.get();
  const [whisperWasm, webSpeech, llm, diarization] = await Promise.all([
    detectWhisperWasm(),
    detectWebSpeech(settings),
    detectAvailableLlm(),
    isDiarizationAvailable(),
  ]);
  return {
    whisperWasm,
    webSpeech,
    ollama: llm.ollama,
    llamaCpp: llm.llamaCpp,
    diarization: { available: diarization },
    detectedAt: Date.now(),
  };
}

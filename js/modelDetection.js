'use strict';

/**
 * modelDetection.js — browser reconstruction of the old main-process
 * modelDetection.js. The original scanned the filesystem for whisper.cpp/
 * faster-whisper binaries; none of that filesystem access exists in a
 * browser. What's left:
 *   - Sherpa ASR: a fetch() HEAD check against the vendored engine files,
 *     plus the settings enable/disable flag (see sherpaAsr.js). Unlike the
 *     earlier Whisper WASM integration, there's no per-user download step —
 *     the engine files are committed directly into this repo — so this
 *     should normally always be true unless the user has explicitly
 *     disabled it or a deployment issue is genuinely missing the files.
 *   - Web Speech API: a capability check (is SpeechRecognition present in
 *     this browser) plus whether the user has enabled + acknowledged it.
 *   - Speaker diarization: a fetch() HEAD check against the vendored
 *     sherpa-onnx diarization assets, also committed directly into this repo.
 *   - Ollama / llama.cpp: unchanged in spirit (HTTP reachability checks),
 *     but now via the page's own fetch() rather than Node's HTTP client —
 *     see summaryEngine.js's file header for the CORS caveat this implies.
 */

import { settingsStore } from './settingsStore.js';
import { detectAvailableLlm } from './summaryEngine.js';
import { isAvailable as isDiarizationAvailable } from './diarization.js';

async function detectSherpaAsr(settings) {
  if (!settings.engines.sherpaAsr.enabled) return { available: false };
  try {
    const response = await fetch('./assets/speech-recognition/sherpa-onnx-wasm-main-asr.js', { method: 'HEAD' });
    return { available: response.ok };
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
  const [sherpaAsr, webSpeech, llm, diarization] = await Promise.all([
    detectSherpaAsr(settings),
    detectWebSpeech(settings),
    detectAvailableLlm(),
    isDiarizationAvailable(),
  ]);
  return {
    sherpaAsr,
    webSpeech,
    ollama: llm.ollama,
    llamaCpp: llm.llamaCpp,
    diarization: { available: diarization },
    detectedAt: Date.now(),
  };
}

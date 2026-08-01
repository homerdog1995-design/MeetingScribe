'use strict';

/**
 * modelDetection.js — browser reconstruction of the old main-process
 * modelDetection.js. The original scanned the filesystem for whisper.cpp/
 * faster-whisper binaries; none of that filesystem access exists in a
 * browser. What's left:
 *   - Whisper WASM: no longer a file-existence check. Since switching to
 *     @timur00kh/whisper.wasm (see whisperWasm.js's file header), the model
 *     is fetched and cached in IndexedDB by the library itself, triggered
 *     from Settings — there are no files to look for on a fixed path
 *     anymore. "Detected" just means the user has successfully downloaded
 *     and enabled a model at least once (settings.engines.whisperWasm.enabled).
 *   - Web Speech API: a capability check (is SpeechRecognition present in
 *     this browser) plus whether the user has enabled + acknowledged it.
 *   - Speaker diarization: a fetch() HEAD check against the vendored
 *     sherpa-onnx assets, which — unlike Whisper WASM — are committed
 *     directly into this repo, so this should normally always be true.
 *   - Ollama / llama.cpp: unchanged in spirit (HTTP reachability checks),
 *     but now via the page's own fetch() rather than Node's HTTP client —
 *     see summaryEngine.js's file header for the CORS caveat this implies.
 */

import { settingsStore } from './settingsStore.js';
import { detectAvailableLlm } from './summaryEngine.js';
import { isAvailable as isDiarizationAvailable } from './diarization.js';

async function detectWebSpeech(settings) {
  const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  return {
    supported,
    enabled: supported && Boolean(settings.engines.webSpeech.enabled && settings.engines.webSpeech.acknowledgedDisclosure),
  };
}

export async function detectAll() {
  const settings = await settingsStore.get();
  const [webSpeech, llm, diarization] = await Promise.all([
    detectWebSpeech(settings),
    detectAvailableLlm(),
    isDiarizationAvailable(),
  ]);
  return {
    whisperWasm: { available: Boolean(settings.engines.whisperWasm.enabled && settings.engines.whisperWasm.active), modelId: settings.engines.whisperWasm.modelId },
    webSpeech,
    ollama: llm.ollama,
    llamaCpp: llm.llamaCpp,
    diarization: { available: diarization },
    detectedAt: Date.now(),
  };
}

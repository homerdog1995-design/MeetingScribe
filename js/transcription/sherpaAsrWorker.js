'use strict';

/* eslint-env worker */
/* global importScripts, Module, createVad, OfflineRecognizer, CircularBuffer */

/**
 * Runs Whisper (tiny.en) via sherpa-onnx's official prebuilt WASM package,
 * gated by Silero VAD. Both the VAD and Whisper models are bundled in the
 * package's .data file — nothing is fetched from a third-party host at
 * runtime, and there's no per-user setup step.
 *
 * WHY WHISPER + VAD RATHER THAN THE PREVIOUS STREAMING ZIPFORMER: the
 * streaming model committed to words after hearing only a fraction of a
 * second of context, which produced poor real-world accuracy, ALL-CAPS
 * output (its checkpoint was trained on casing-stripped text), and
 * hallucinated filler words during silence. Whisper is a non-streaming
 * ("offline") model: it sees a whole utterance before deciding anything,
 * and produces natural casing and punctuation itself. VAD is what makes
 * that practical here — rather than this app guessing where utterances
 * begin and end, Silero VAD segments real speech acoustically and only
 * complete speech segments ever reach Whisper. Silence never reaches the
 * model at all, which addresses hallucination-during-silence at the
 * source instead of filtering it after the fact.
 *
 * The trade-off, stated plainly: text appears once a speech segment
 * *finishes* rather than word-by-word as it's spoken. For meeting notes
 * that's generally the better trade, but it is a real behavioural change.
 *
 * WHY THE MODEL FILE IS SPLIT INTO PARTS: the bundled model data (~104MB)
 * exceeds GitHub's 100MB-per-file limit for a normal git push, and GitHub's
 * release-asset host doesn't send CORS headers (confirmed by checking
 * response headers directly), so the browser can't fetch it from there
 * either. Splitting into <100MB parts committed to this same repo, then
 * reassembling via same-origin fetch(), avoids depending on any
 * third-party host's CORS policy.
 */

// Relative to THIS FILE's own location (js/transcription/sherpaAsrWorker.js),
// not the site root — fetch()/importScripts() inside a Worker resolve
// against the worker's own script URL, not the page that created it.
const ASSET_BASE = '../../assets/speech-recognition/';
const DATA_PARTS = ['sherpa-onnx-wasm-main-vad-asr.data.part00', 'sherpa-onnx-wasm-main-vad-asr.data.part01'];
const SAMPLE_RATE = 16000;

let recognizer = null;
let vad = null;
let circularBuffer = null;

async function buildReassembledDataUrl(onProgress) {
  const buffers = [];
  let loaded = 0;
  for (const [index, partName] of DATA_PARTS.entries()) {
    const response = await fetch(`${ASSET_BASE}${partName}`);
    if (!response.ok) throw new Error(`Failed to fetch model part ${index + 1}/${DATA_PARTS.length} (HTTP ${response.status})`);
    const buffer = await response.arrayBuffer();
    buffers.push(buffer);
    loaded += buffer.byteLength;
    onProgress?.(index + 1, DATA_PARTS.length, loaded);
  }
  return URL.createObjectURL(new Blob(buffers, { type: 'application/octet-stream' }));
}

function waitForRuntime() {
  return new Promise((resolve) => {
    const previous = self.Module.onRuntimeInitialized;
    self.Module.onRuntimeInitialized = () => {
      if (typeof previous === 'function') previous();
      resolve();
    };
  });
}

/** Mirrors the model-detection pattern from sherpa-onnx's own demo: the .data package bundles whisper-encoder.onnx/whisper-decoder.onnx/tokens.txt at the virtual filesystem root. */
function createWhisperRecognizer() {
  return new OfflineRecognizer({
    modelConfig: {
      debug: 0,
      tokens: './tokens.txt',
      whisper: {
        encoder: './whisper-encoder.onnx',
        decoder: './whisper-decoder.onnx',
      },
    },
  }, self.Module);
}

self.onmessage = async (event) => {
  const { type, requestId } = event.data;
  try {
    if (type === 'load') {
      const dataBlobUrl = await buildReassembledDataUrl((partIndex, totalParts, loadedBytes) => {
        self.postMessage({ type: 'progress', requestId, partIndex, totalParts, loadedBytes });
      });

      self.Module = self.Module || {};
      self.Module.locateFile = (path) => (path.endsWith('.data') ? dataBlobUrl : `${ASSET_BASE}${path}`);

      const runtimeReady = waitForRuntime();
      importScripts(
        `${ASSET_BASE}sherpa-onnx-asr.js`,
        `${ASSET_BASE}sherpa-onnx-vad.js`,
        `${ASSET_BASE}sherpa-onnx-wasm-main-vad-asr.js`,
      );
      await runtimeReady;

      recognizer = createWhisperRecognizer();
      vad = createVad(self.Module);
      // Buffers incoming audio until at least one full VAD window is
      // available — frame sizes arriving from audio.js won't line up with
      // the VAD's required window size, and feeding partial windows would
      // desynchronize its speech detection.
      circularBuffer = new CircularBuffer(30 * SAMPLE_RATE, self.Module);
      self.postMessage({ type: 'loaded', requestId, sampleRate: SAMPLE_RATE });

    } else if (type === 'feed') {
      if (!recognizer || !vad || !circularBuffer) throw new Error('ASR model is not loaded.');

      // Each stage is labelled so a failure reports where it actually
      // happened. An earlier bug here surfaced only as a bare
      // "Cannot read properties of undefined" with no indication of which
      // call produced it, which made it far harder to locate than it
      // should have been.
      let stage = 'decode-samples';
      const samples = event.data.samples instanceof Float32Array ? event.data.samples : new Float32Array(event.data.samples);

      try {
        stage = 'circularBuffer.push';
        circularBuffer.push(samples);

        stage = 'read-vad-window-size';
        const windowSize = vad.config.sileroVad.windowSize;

        stage = 'vad.acceptWaveform';
        while (circularBuffer.size() > windowSize) {
          vad.acceptWaveform(circularBuffer.get(circularBuffer.head(), windowSize));
          circularBuffer.pop(windowSize);
        }
      } catch (stageError) {
        throw new Error(`[${stage}] ${stageError.message}`);
      }

      // Each completed VAD segment is one acoustically-delimited utterance:
      // decode it as a whole, which is exactly what Whisper is good at.
      const results = [];
      try {
        while (!vad.isEmpty()) {
          const segment = vad.front();
          const durationMs = (segment.samples.length / SAMPLE_RATE) * 1000;
          vad.pop();

          const stream = recognizer.createStream();
          stream.acceptWaveform(SAMPLE_RATE, segment.samples);
          recognizer.decode(stream);
          const text = recognizer.getResult(stream).text.trim();
          stream.free();

          if (text) results.push({ text, durationMs });
        }
      } catch (recogError) {
        throw new Error(`[recognize-segment] ${recogError.message}`);
      }

      self.postMessage({ type: 'result', requestId, results, speechActive: vad.isDetected() });

    } else if (type === 'reset') {
      vad?.reset();
      circularBuffer?.reset();
      self.postMessage({ type: 'ok', requestId });

    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) });
  }
};

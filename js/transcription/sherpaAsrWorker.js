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

/**
 * The larger base.en model is NOT baked into the WASM bundle (only tiny.en
 * is, since that's what sherpa-onnx ships prebuilt). Instead its ONNX files
 * are vendored separately in this repo and written into the WASM virtual
 * filesystem at runtime via Module.FS_createDataFile — an explicitly
 * exported Emscripten runtime method, verified present in this build. That
 * avoids needing a computer with Emscripten to compile a custom bundle.
 *
 * Trade-off, disclosed in Settings: the bundled tiny.en model is loaded
 * regardless (the Silero VAD model lives in the same bundle and can't be
 * separated), so choosing base.en means downloading both — roughly 263MB
 * total rather than 103MB. It's cached afterward and only downloaded if
 * the user opts in.
 */
const RUNTIME_MODELS = {
  'base.en': {
    assetBase: '../../assets/whisper-base-en/',
    encoder: { name: 'base.en-encoder.int8.onnx', parts: ['base.en-encoder.int8.onnx'] },
    decoder: { name: 'base.en-decoder.int8.onnx', parts: ['base.en-decoder.int8.onnx.part00', 'base.en-decoder.int8.onnx.part01'] },
    tokens: { name: 'base.en-tokens.txt', parts: ['base.en-tokens.txt'] },
    language: '',
  },
  'base-multilingual': {
    assetBase: '../../assets/whisper-base-multilingual/',
    encoder: { name: 'base-encoder.int8.onnx', parts: ['base-encoder.int8.onnx'] },
    decoder: { name: 'base-decoder.int8.onnx', parts: ['base-decoder.int8.onnx.part00', 'base-decoder.int8.onnx.part01'] },
    tokens: { name: 'base-tokens.txt', parts: ['base-tokens.txt'] },
    // Multilingual checkpoints need the language stated explicitly,
    // otherwise they spend effort detecting it and can mis-detect on short
    // utterances. These models were trained on far more accent diversity
    // than the .en variants, which is why they handle non-American English
    // (e.g. Australian) noticeably better despite being the same size.
    language: 'en',
  },
};

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

/** Fetches the vendored base.en model parts and writes them into the WASM virtual filesystem, so the recognizer can reference them by path exactly like the bundled tiny.en files. */
async function installRuntimeModel(modelId, onProgress) {
  const model = RUNTIME_MODELS[modelId];
  let completed = 0;
  const specs = [model.encoder, model.decoder, model.tokens];
  const totalFiles = specs.length;
  for (const spec of specs) {
    const buffers = [];
    for (const partName of spec.parts) {
      const response = await fetch(`${model.assetBase}${partName}`);
      if (!response.ok) throw new Error(`Failed to fetch ${partName} (HTTP ${response.status})`);
      buffers.push(new Uint8Array(await response.arrayBuffer()));
    }
    const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const b of buffers) { merged.set(b, offset); offset += b.length; }
    self.Module.FS_createDataFile('/', spec.name, merged, true, true, true);
    completed += 1;
    onProgress?.(completed, totalFiles);
  }
}

/**
 * tiny.en (and tokens.txt) are bundled in the WASM .data package at the
 * virtual filesystem root; base.en is installed at runtime by
 * installRuntimeModel() above, so both end up addressable the same way.
 */
function createWhisperRecognizer(modelId) {
  const model = RUNTIME_MODELS[modelId];
  const whisper = model
    ? { encoder: `./${model.encoder.name}`, decoder: `./${model.decoder.name}`, language: model.language, task: 'transcribe' }
    : { encoder: './whisper-encoder.onnx', decoder: './whisper-decoder.onnx' };
  const tokens = model ? `./${model.tokens.name}` : './tokens.txt';

  return new OfflineRecognizer({
    modelConfig: { debug: 0, tokens, whisper },
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

      const requestedModelId = event.data.modelId;
      const modelId = RUNTIME_MODELS[requestedModelId] ? requestedModelId : 'tiny.en';
      if (RUNTIME_MODELS[modelId]) {
        try {
          await installRuntimeModel(modelId, (done, total) => {
            self.postMessage({ type: 'progress', requestId, stage: 'model', done, total });
          });
        } catch (installError) {
          // Fall back to the bundled tiny.en rather than failing outright —
          // the user still gets working transcription, just not the
          // higher-accuracy model they opted into.
          self.postMessage({ type: 'model-fallback', requestId, message: installError.message });
          recognizer = createWhisperRecognizer('tiny.en');
          vad = createVad(self.Module, {
        sileroVad: {
          model: './silero_vad.onnx',
          // Raised from the 0.50 default: a higher bar for "this is
          // speech" makes the VAD less likely to trigger on background
          // noise, which otherwise gets fed to Whisper as if it were
          // speech and produces junk text.
          threshold: 0.60,
          // Raised from 0.50s. At a normal conversational pace people
          // pause briefly mid-sentence; ending a segment that early
          // chops sentences into fragments and denies Whisper the
          // surrounding context it needs to transcribe accurately.
          minSilenceDuration: 0.80,
          // Raised from 0.25s so brief noises (a cough, a door, a chair)
          // aren't treated as utterances in their own right.
          minSpeechDuration: 0.35,
          // Whisper is trained on 30s windows, so allowing longer
          // segments than the 20s default costs nothing and avoids
          // arbitrarily cutting long uninterrupted speech.
          maxSpeechDuration: 28,
          windowSize: 512,
        },
        tenVad: { model: '', threshold: 0.50, minSilenceDuration: 0.50, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        bufferSizeInSeconds: 30,
      });
          circularBuffer = new CircularBuffer(30 * SAMPLE_RATE, self.Module);
          self.postMessage({ type: 'loaded', requestId, sampleRate: SAMPLE_RATE, modelId: 'tiny.en' });
          return;
        }
      }
      recognizer = createWhisperRecognizer(modelId);
      vad = createVad(self.Module, {
        sileroVad: {
          model: './silero_vad.onnx',
          // Raised from the 0.50 default: a higher bar for "this is
          // speech" makes the VAD less likely to trigger on background
          // noise, which otherwise gets fed to Whisper as if it were
          // speech and produces junk text.
          threshold: 0.60,
          // Raised from 0.50s. At a normal conversational pace people
          // pause briefly mid-sentence; ending a segment that early
          // chops sentences into fragments and denies Whisper the
          // surrounding context it needs to transcribe accurately.
          minSilenceDuration: 0.80,
          // Raised from 0.25s so brief noises (a cough, a door, a chair)
          // aren't treated as utterances in their own right.
          minSpeechDuration: 0.35,
          // Whisper is trained on 30s windows, so allowing longer
          // segments than the 20s default costs nothing and avoids
          // arbitrarily cutting long uninterrupted speech.
          maxSpeechDuration: 28,
          windowSize: 512,
        },
        tenVad: { model: '', threshold: 0.50, minSilenceDuration: 0.50, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        bufferSizeInSeconds: 30,
      });
      // Buffers incoming audio until at least one full VAD window is
      // available — frame sizes arriving from audio.js won't line up with
      // the VAD's required window size, and feeding partial windows would
      // desynchronize its speech detection.
      circularBuffer = new CircularBuffer(30 * SAMPLE_RATE, self.Module);
      self.postMessage({ type: 'loaded', requestId, sampleRate: SAMPLE_RATE, modelId });

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

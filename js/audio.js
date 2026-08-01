'use strict';

/**
 * Owns every Web Audio / MediaStream concern:
 *  - microphone capture
 *  - system-audio capture via the browser's native getDisplayMedia() picker
 *    (see _captureSystemAudio below for what changed from the Electron version)
 *  - mixing microphone + system audio into one synchronized graph for
 *    "mixed" recording mode
 *  - live input-level metering (per source, for the recording toolbar)
 *  - a continuous PCM stream tap, resampled to 16kHz mono, for handoff to
 *    the Sherpa ASR provider (see js/transcription/sherpaAsr.js)
 *  - the MediaRecorder that produces the actual saved recording file
 *
 * CHANGED: this used to buffer audio into silence-delimited chunks and
 * encode each one as a WAV file, for the old (now-removed) Whisper WASM
 * integration, which needed discrete pre-segmented utterances. Sherpa's
 * ASR engine has its own real, built-in endpoint detection and expects a
 * continuous stream of small raw audio frames instead — pre-chunking the
 * audio here would throw away exactly the signal that engine depends on.
 * See sherpaAsr.js's file header for the full reasoning.
 *
 * See ARCHITECTURE.md §10 for the platform limitation that system-audio
 * loopback captures the whole OS audio mix, not a single selected window.
 */

import { clamp } from './utils.js';

const TARGET_SAMPLE_RATE = 16000; // the Sherpa ASR engine expects 16kHz mono
const ANALYSER_FFT_SIZE = 1024;
const STREAM_BUFFER_SIZE = 4096; // ScriptProcessorNode block size (~85-256ms depending on native sample rate)

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.audioContext = null;
    this.micStream = null;
    this.systemStream = null;
    this.mixedDestinationStream = null;
    this.mediaRecorder = null;
    this.recorderChunkIndex = 0;

    this._micAnalyser = null;
    this._systemAnalyser = null;
    this._levelLoopHandle = null;

    this._streamNode = null;
  }

  /** @param {'microphone'|'system'|'mixed'} mode */
  async start(mode, { audioBitsPerSecond = 96000 } = {}) {
    this.audioContext = new AudioContext();
    this.recorderChunkIndex = 0;

    if (mode === 'microphone' || mode === 'mixed') {
      // Sherpa ASR (this app's primary transcription engine) processes
      // this same captured stream directly — it never needs its own,
      // separate microphone session the way Web Speech does, so there's
      // no reason to drop these constraints for its benefit. Web Speech's
      // mic-conflict problem (see recording.js's transcript-only mode) is
      // instead solved by never starting this AudioEngine at all when Web
      // Speech ends up being the active engine, rather than by weakening
      // these constraints — noise suppression and echo cancellation
      // generally help ASR accuracy rather than hurt it.
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }

    if (mode === 'system' || mode === 'mixed') {
      this.systemStream = await this._captureSystemAudio();
    }

    const destination = this.audioContext.createMediaStreamDestination();
    // destination (MediaStreamAudioDestinationNode) has ZERO outputs by
    // design — it's a terminal sink whose .stream is read, never something
    // you connect FROM. A separate mix bus (a plain GainNode, which does
    // have outputs) is what both the recorder and the PCM stream tap
    // actually use.
    const mixBus = this.audioContext.createGain();
    mixBus.gain.value = 1;
    mixBus.connect(destination);

    if (this.micStream) {
      const micSource = this.audioContext.createMediaStreamSource(this.micStream);
      this._micAnalyser = this.audioContext.createAnalyser();
      this._micAnalyser.fftSize = ANALYSER_FFT_SIZE;
      micSource.connect(this._micAnalyser);
      micSource.connect(mixBus);
    }

    if (this.systemStream) {
      const systemSource = this.audioContext.createMediaStreamSource(this.systemStream);
      this._systemAnalyser = this.audioContext.createAnalyser();
      this._systemAnalyser.fftSize = ANALYSER_FFT_SIZE;
      systemSource.connect(this._systemAnalyser);
      systemSource.connect(mixBus);
    }

    this.mixedDestinationStream = destination.stream;

    this._startLevelMetering();
    this._startPcmStream(mixBus);
    this._startMediaRecorder(this.mixedDestinationStream, audioBitsPerSecond);

    return { sampleRate: this.audioContext.sampleRate };
  }

  pause() {
    this.mediaRecorder?.state === 'recording' && this.mediaRecorder.pause();
    this.audioContext?.suspend();
  }

  resume() {
    this.mediaRecorder?.state === 'paused' && this.mediaRecorder.resume();
    this.audioContext?.resume();
  }

  async stop() {
    this._stopLevelMetering();

    if (this._streamNode) {
      this._streamNode.disconnect();
      this._streamNode = null;
    }

    const recorderStopped = new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return resolve();
      this.mediaRecorder.addEventListener('stop', resolve, { once: true });
      this.mediaRecorder.stop();
    });
    await recorderStopped;

    [this.micStream, this.systemStream].forEach((stream) => stream?.getTracks().forEach((t) => t.stop()));
    await this.audioContext?.close();

    this.micStream = null;
    this.systemStream = null;
    this.audioContext = null;
    this.mediaRecorder = null;
  }

  /**
   * CHANGED FROM THE ELECTRON VERSION: Electron let the app show its own
   * custom source-picker (a thumbnail grid built from desktopCapturer.
   * getSources() over IPC) and then silently pre-approve that exact choice
   * via setDisplayMediaRequestHandler. A real browser has no equivalent —
   * getDisplayMedia() always shows the browser's own native
   * screen/window/tab picker, and there is no way to bypass it or pass in a
   * pre-selected source. So this is now just a direct call; recording.js no
   * longer needs (or has) a custom source-picker UI at all.
   *
   * Also worth knowing: whether "audio" is actually captured alongside the
   * picked source varies a lot by browser/OS. Chrome reliably captures
   * audio for a shared *browser tab*; whole-screen/window audio capture is
   * inconsistent (works on Windows/ChromeOS, generally unavailable on
   * macOS). recording.js surfaces this as an in-app note rather than
   * pretending it always works.
   */
  async _captureSystemAudio() {
    // Mobile browsers (Android Chrome, iOS Safari) don't implement
    // getDisplayMedia() at all as of today — screen/tab capture is
    // considered desktop-only by every mobile browser vendor, not
    // something MeetingScribe can polyfill or work around. Checking this
    // upfront turns a cryptic "getDisplayMedia is not a function" into a
    // clear explanation instead.
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      throw new Error('System audio capture isn\'t available on this browser/device — it requires a desktop browser (Chrome, Edge, or Firefox on Windows/Mac/Linux). Try Microphone mode instead.');
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by getDisplayMedia's contract even though we discard it
      audio: true,
    });
    stream.getVideoTracks().forEach((track) => {
      track.stop();
      stream.removeTrack(track);
    });
    return stream;
  }

  _startLevelMetering() {
    const micData = this._micAnalyser ? new Uint8Array(this._micAnalyser.frequencyBinCount) : null;
    const systemData = this._systemAnalyser ? new Uint8Array(this._systemAnalyser.frequencyBinCount) : null;

    const tick = () => {
      let micLevel = 0;
      let systemLevel = 0;
      if (this._micAnalyser) {
        this._micAnalyser.getByteTimeDomainData(micData);
        micLevel = rmsFromByteTimeDomain(micData);
      }
      if (this._systemAnalyser) {
        this._systemAnalyser.getByteTimeDomainData(systemData);
        systemLevel = rmsFromByteTimeDomain(systemData);
      }
      this.dispatchEvent(new CustomEvent('level', { detail: { mic: micLevel, system: systemLevel } }));
      this._levelLoopHandle = requestAnimationFrame(tick);
    };
    this._levelLoopHandle = requestAnimationFrame(tick);
  }

  _stopLevelMetering() {
    if (this._levelLoopHandle) cancelAnimationFrame(this._levelLoopHandle);
    this._levelLoopHandle = null;
  }

  /**
   * Continuous PCM tap: every audio block from the mixed graph is
   * resampled to 16kHz mono and emitted immediately as a 'pcm-frame' event
   * — no buffering, no silence detection, no chunking. The ASR engine
   * (sherpaAsr.js) decides utterance boundaries itself via real endpoint
   * detection; this just needs to keep the samples flowing.
   */
  _startPcmStream(mixBus) {
    this._streamNode = this.audioContext.createScriptProcessor(STREAM_BUFFER_SIZE, 1, 1);
    // Explicit rather than relying on the browser's implicit defaults:
    // 'speakers' interpretation is what makes a stereo/multi-channel source
    // properly *downmix* into this node's single channel (summing left+
    // right correctly) rather than silently discarding every channel but
    // the first.
    this._streamNode.channelCount = 1;
    this._streamNode.channelCountMode = 'explicit';
    this._streamNode.channelInterpretation = 'speakers';

    const monoTap = this.audioContext.createGain();
    monoTap.gain.value = 1;
    mixBus.connect(monoTap);
    monoTap.connect(this._streamNode);

    // A ScriptProcessorNode only fires onaudioprocess while it's part of a
    // graph that reaches audioContext.destination — routing through a
    // zero-gain node keeps it "live" without producing any audible echo.
    const silentSink = this.audioContext.createGain();
    silentSink.gain.value = 0;
    this._streamNode.connect(silentSink);
    silentSink.connect(this.audioContext.destination);

    this._streamNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleLinear(input, this.audioContext.sampleRate, TARGET_SAMPLE_RATE);
      const { samples: normalized, hasSignal } = normalizeGain(resampled);
      this.dispatchEvent(new CustomEvent('pcm-frame', { detail: { samples: normalized, hasSignal } }));
    };
  }

  _startMediaRecorder(stream, audioBitsPerSecond) {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond });
    this.mediaRecorder.addEventListener('dataavailable', async (event) => {
      if (event.data.size === 0) return;
      const arrayBuffer = await event.data.arrayBuffer();
      this.dispatchEvent(new CustomEvent('master-chunk', { detail: { arrayBuffer, index: this.recorderChunkIndex++ } }));
    });
    this.mediaRecorder.start(5000); // emit a chunk every 5s for crash-safe incremental saving
  }
}

function rmsFromByteTimeDomain(byteData) {
  let sumSquares = 0;
  for (let i = 0; i < byteData.length; i++) {
    const normalized = (byteData[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return clamp(Math.sqrt(sumSquares / byteData.length) * 3.2, 0, 1); // *3.2 empirically maps typical speech RMS into a usable 0-1 meter range
}

const TARGET_RMS = 0.08; // a reasonable target loudness for typical speech, matching what these models are generally trained on
const NOISE_FLOOR_RMS = 0.012; // below this, treat it as ambient room noise/mic self-noise rather than quiet speech — confirmed via real device testing that a too-low threshold here (1e-4, essentially only true digital silence) let real ambient noise get amplified into the model's hearing range, causing hallucinated repeated words during actual silence
const MAX_NORMALIZATION_GAIN = 3; // lowered from 6 as an additional safety margin against amplifying noise into audible/model-perceptible artifacts

/** Boosts (or gently attenuates) a frame toward a consistent target loudness, based on its RMS energy. Also reports whether the frame had any real signal above the noise floor, for use as an independent guard against committing hallucinated ASR output during actual silence. */
function normalizeGain(samples) {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  const rms = Math.sqrt(sumSquares / samples.length);
  const hasSignal = rms >= NOISE_FLOOR_RMS;
  if (!hasSignal) return { samples, hasSignal }; // ambient noise or silence — leave it exactly as captured rather than amplifying it into something the model might mistake for quiet speech
  const gain = Math.min(TARGET_RMS / rms, MAX_NORMALIZATION_GAIN);
  if (Math.abs(gain - 1) < 0.05) return { samples, hasSignal }; // already close enough — skip the redundant pass
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) output[i] = clamp(samples[i] * gain, -1, 1);
  return { samples: output, hasSignal };
}

/**
 * Simple linear-interpolation resampler — deliberately not the
 * OfflineAudioContext-based approach used elsewhere in this app for
 * one-shot exports: this runs on every ~85-256ms audio block in real time,
 * and creating a new OfflineAudioContext that often would be far too slow.
 * Speech recognition tolerates the minor quality loss from a fast
 * approximate resample fine; perfect audio fidelity isn't the goal here.
 */
function resampleLinear(input, inputRate, outputRate) {
  if (inputRate === outputRate) return new Float32Array(input);

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const frac = srcIndex - srcIndexFloor;
    const s0 = input[srcIndexFloor] ?? 0;
    const s1 = input[srcIndexFloor + 1] ?? s0;
    output[i] = s0 + (s1 - s0) * frac;
  }
  return output;
}

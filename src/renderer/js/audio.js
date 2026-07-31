'use strict';

/**
 * Owns every Web Audio / MediaStream concern:
 *  - microphone capture
 *  - system-audio loopback capture (via Electron's setDisplayMediaRequestHandler,
 *    see main/desktopCapture.js)
 *  - mixing microphone + system audio into one synchronized graph for
 *    "mixed" recording mode
 *  - live input-level metering (per source, for the recording toolbar)
 *  - a voice-activity-based chunker that slices the live audio into short
 *    WAV segments at natural silence gaps, for handoff to a transcription
 *    provider (see js/transcription.js)
 *  - the MediaRecorder that produces the actual saved recording file
 *
 * See ARCHITECTURE.md §10 for the platform limitation that system-audio
 * loopback captures the whole OS audio mix, not a single selected window.
 */

import { clamp } from './utils.js';

const TARGET_SAMPLE_RATE = 16000; // whisper.cpp / faster-whisper expect 16kHz mono
const ANALYSER_FFT_SIZE = 1024;
const CHUNKER_BUFFER_SIZE = 4096; // ScriptProcessorNode block size

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

    this._chunkerNode = null;
    this._chunkerBuffer = [];
    this._chunkerSamplesSinceSilence = 0;
    this._chunkerSilenceMs = 700;
    this._chunkerMaxChunkMs = 15000;
    this._chunkerStartMs = 0;
    this._chunkerRecordingStartedAt = 0;
    this._isSilent = true;
    this._silenceStartedAt = 0;
  }

  /** @param {'microphone'|'system'|'mixed'} mode */
  async start(mode, { systemSourceId = null, speakerChangeSilenceMs = 700, audioBitsPerSecond = 96000 } = {}) {
    this._chunkerSilenceMs = speakerChangeSilenceMs;
    this.audioContext = new AudioContext();
    this.recorderChunkIndex = 0;

    if (mode === 'microphone' || mode === 'mixed') {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }

    if (mode === 'system' || mode === 'mixed') {
      this.systemStream = await this._captureSystemAudio(systemSourceId);
    }

    const destination = this.audioContext.createMediaStreamDestination();

    if (this.micStream) {
      const micSource = this.audioContext.createMediaStreamSource(this.micStream);
      this._micAnalyser = this.audioContext.createAnalyser();
      this._micAnalyser.fftSize = ANALYSER_FFT_SIZE;
      micSource.connect(this._micAnalyser);
      micSource.connect(destination);
    }

    if (this.systemStream) {
      const systemSource = this.audioContext.createMediaStreamSource(this.systemStream);
      this._systemAnalyser = this.audioContext.createAnalyser();
      this._systemAnalyser.fftSize = ANALYSER_FFT_SIZE;
      systemSource.connect(this._systemAnalyser);
      systemSource.connect(destination);
    }

    this.mixedDestinationStream = destination.stream;
    this._chunkerRecordingStartedAt = performance.now();
    this._chunkerStartMs = 0;

    this._startLevelMetering();
    this._startChunker(destination);
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
    this._flushChunk(true);

    if (this._chunkerNode) {
      this._chunkerNode.disconnect();
      this._chunkerNode = null;
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

  async _captureSystemAudio(sourceId) {
    await window.api.desktopCapture.selectSource(sourceId, true);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by the loopback-audio implementation even though we discard it
      audio: true,
    });
    stream.getVideoTracks().forEach((track) => {
      track.stop();
      stream.removeTrack(track);
    });
    await window.api.desktopCapture.clearSelection();
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
   * Voice-activity-based chunker: buffers mono PCM samples from the mixed
   * graph and flushes a chunk as soon as it detects a silence gap at or
   * beyond the configured threshold, or when a maximum chunk duration is
   * reached (so continuous uninterrupted speech still gets transcribed
   * incrementally rather than only at the very end of the meeting).
   */
  _startChunker(destinationNode) {
    this._chunkerNode = this.audioContext.createScriptProcessor(CHUNKER_BUFFER_SIZE, 1, 1);
    const monoTap = this.audioContext.createGain();
    destinationNode.connect(monoTap);
    monoTap.connect(this._chunkerNode);
    this._chunkerNode.connect(this.audioContext.destination === null ? monoTap : monoTap); // tap only, no audible output

    // Route through a zero-gain node so the tap never causes audible echo.
    monoTap.gain.value = 1;
    const silentSink = this.audioContext.createGain();
    silentSink.gain.value = 0;
    this._chunkerNode.connect(silentSink);
    silentSink.connect(this.audioContext.destination);

    this._chunkerNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const samples = new Float32Array(input.length);
      samples.set(input);

      const energy = rmsFromFloat32(samples);
      const nowMs = performance.now() - this._chunkerRecordingStartedAt;
      const SILENCE_ENERGY_THRESHOLD = 0.012;

      if (energy < SILENCE_ENERGY_THRESHOLD) {
        if (!this._isSilent) {
          this._isSilent = true;
          this._silenceStartedAt = nowMs;
        }
      } else {
        this._isSilent = false;
      }

      this._chunkerBuffer.push(samples);
      const bufferedMs = (this._chunkerBuffer.length * CHUNKER_BUFFER_SIZE / this.audioContext.sampleRate) * 1000;
      const silenceDuration = this._isSilent ? nowMs - this._silenceStartedAt : 0;

      const shouldFlushForSilence = this._isSilent && silenceDuration >= this._chunkerSilenceMs && bufferedMs >= 500;
      const shouldFlushForMaxLength = bufferedMs >= this._chunkerMaxChunkMs;

      if (shouldFlushForSilence || shouldFlushForMaxLength) {
        this._flushChunk(false);
      }
    };
  }

  _flushChunk(isFinal) {
    if (this._chunkerBuffer.length === 0) return;

    const totalLength = this._chunkerBuffer.reduce((sum, b) => sum + b.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of this._chunkerBuffer) { merged.set(buf, offset); offset += buf.length; }

    const durationMs = (totalLength / this.audioContext.sampleRate) * 1000;
    const startMs = this._chunkerStartMs;
    const endMs = startMs + durationMs;
    this._chunkerStartMs = endMs;
    this._chunkerBuffer = [];

    resampleTo16kMono(merged, this.audioContext.sampleRate).then((resampled) => {
      const wavBuffer = encodeWavPcm16(resampled, TARGET_SAMPLE_RATE);
      this.dispatchEvent(new CustomEvent('chunk-ready', { detail: { wavBuffer, startMs, endMs, isFinal } }));
    });
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

function rmsFromFloat32(samples) {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length);
}

async function resampleTo16kMono(float32Samples, originalSampleRate) {
  if (originalSampleRate === TARGET_SAMPLE_RATE) return float32Samples;

  const targetLength = Math.ceil(float32Samples.length * (TARGET_SAMPLE_RATE / originalSampleRate));
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  const sourceBuffer = offlineCtx.createBuffer(1, float32Samples.length, originalSampleRate);
  sourceBuffer.copyToChannel(float32Samples, 0);

  const source = offlineCtx.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(offlineCtx.destination);
  source.start();

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/** Encodes 32-bit float PCM samples into a standard 16-bit PCM WAV file. */
function encodeWavPcm16(float32Samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + float32Samples.length * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + float32Samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, float32Samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < float32Samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

#!/usr/bin/env python3
"""
Bridge script invoked by MeetingScribe's main process (see
src/main/ipcHandlers.js -> transcription:runFasterWhisper) to run a locally
installed faster-whisper model against a short WAV chunk and report back
timestamped segments as newline-delimited JSON on stdout.

This script never makes a network call itself. faster-whisper downloads and
caches model weights from Hugging Face on first use of a given model size
(a one-time, user-initiated action per docs/MODEL_SETUP.md) and reads from
that local cache on every subsequent run.

Usage:
    python3 faster_whisper_bridge.py <wav_path> <model_size> <device> [language]

Output (stdout, one JSON object per line, in chronological order):
    {"start": 0.0, "end": 2.4, "text": "Hello everyone.", "confidence": 0.93}

Any fatal error is reported as a single JSON line on stdout with an "error"
key, so the calling Node process can treat "did it print at least one valid
JSON line" as a simple health check without depending on stderr formatting.
"""

import sys
import json


def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(1)


def main():
    if len(sys.argv) < 4:
        fail("usage: faster_whisper_bridge.py <wav_path> <model_size> <device> [language]")

    wav_path = sys.argv[1]
    model_size = sys.argv[2]
    device = sys.argv[3]
    language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "auto" else None

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        fail("faster-whisper is not installed in this Python environment. "
             "Run: pip install faster-whisper")
        return

    try:
        compute_type = "float16" if device == "cuda" else "int8"
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
    except Exception as exc:  # noqa: BLE001 - surface any load failure to the caller
        fail(f"failed to load faster-whisper model '{model_size}': {exc}")
        return

    try:
        segments, _info = model.transcribe(
            wav_path,
            language=language,
            vad_filter=True,
            beam_size=5,
        )
        for segment in segments:
            avg_logprob = getattr(segment, "avg_logprob", None)
            confidence = None
            if avg_logprob is not None:
                # avg_logprob is a log-probability (<= 0); map to a rough 0-1
                # confidence for display purposes only, not a calibrated metric.
                confidence = max(0.0, min(1.0, 1.0 + (avg_logprob / 5.0)))
            print(json.dumps({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
                "confidence": confidence,
            }))
            sys.stdout.flush()
    except Exception as exc:  # noqa: BLE001
        fail(f"transcription failed: {exc}")


if __name__ == "__main__":
    main()

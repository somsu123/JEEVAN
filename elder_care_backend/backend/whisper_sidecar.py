"""
whisper_sidecar.py — faster-whisper HTTP sidecar for JEEVAN voice assistant

Binds to 127.0.0.1:5051 (local-only).
Endpoints:
  GET  /health      -> {"status": "ok"}
  POST /transcribe  -> body: raw WAV bytes
                    -> {"text": "<transcript>"}

Startup: prints "READY" to stdout when the model is loaded so the
         Node.js bridge knows it can start sending requests.
"""

import os
import sys
import io
import tempfile
import logging
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

logging.basicConfig(
    level=logging.INFO,
    format="[%(levelname)s] %(message)s",
    stream=sys.stdout,
)

MODEL_SIZE  = os.environ.get("WHISPER_MODEL", "base")
PORT        = int(os.environ.get("WHISPER_PORT", "5051"))
DEVICE      = "cuda" if os.environ.get("USE_CUDA", "").lower() == "true" else "cpu"
COMPUTE     = "float16" if DEVICE == "cuda" else "int8"

app = Flask(__name__)
model: WhisperModel | None = None


def load_model() -> None:
    global model
    logging.info(f"Loading faster-whisper model '{MODEL_SIZE}' on {DEVICE}/{COMPUTE} ...")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
    logging.info("Model loaded.")
    # Signal to Node.js bridge
    print("READY", flush=True)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE})


@app.post("/transcribe")
def transcribe():
    wav_bytes = request.get_data()
    if not wav_bytes:
        return jsonify({"error": "Empty audio payload"}), 400

    try:
        # Write to temp file (faster-whisper needs a path or file-like object)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            tmp_path = tmp.name

        segments, info = model.transcribe(tmp_path, beam_size=5, language="en")
        text = " ".join(seg.text.strip() for seg in segments).strip()

        logging.info(f"Transcribed ({info.duration:.1f}s): {text[:80]}")
        return jsonify({"text": text, "duration": info.duration, "language": info.language})

    except Exception as e:
        logging.error(f"Transcription error: {e}")
        return jsonify({"error": str(e)}), 500

    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


if __name__ == "__main__":
    load_model()
    logging.info(f"Whisper sidecar listening on 127.0.0.1:{PORT}")
    app.run(host="127.0.0.1", port=PORT, threaded=True, debug=False)

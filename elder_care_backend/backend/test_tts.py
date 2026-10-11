import subprocess
import sys
import tempfile
import os

temp_wav = tempfile.mktemp(suffix='.wav')
try:
    script = f"""
import pyttsx3
engine = pyttsx3.init()
engine.save_to_file("Hello there, this is a test", {repr(temp_wav)})
engine.runAndWait()
"""
    subprocess.run([sys.executable, "-c", script], check=True)
    if os.path.exists(temp_wav) and os.path.getsize(temp_wav) > 1000:
        print("PASS: TTS generation works successfully in subprocess!")
    else:
        print("FAIL: WAV file was not created or is empty.")
finally:
    if os.path.exists(temp_wav):
        os.remove(temp_wav)

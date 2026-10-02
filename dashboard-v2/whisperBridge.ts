/**
 * whisperBridge.ts -- faster-whisper STT bridge for JEEVAN voice assistant
 *
 * Spawns and manages backend/whisper_sidecar.py.
 * Binds sidecar to 127.0.0.1:5051 (local-only, never externally reachable).
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIDECAR_URL   = process.env.WHISPER_SIDECAR_URL || "http://127.0.0.1:5051";
const SIDECAR_PORT  = "5051";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const BACKEND_DIR   = path.resolve(__dirname, "..", "backend");

let sidecarProc: ChildProcess | null = null;
let sidecarReady = false;
let startPromise: Promise<void> | null = null;

async function isSidecarAlive(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`${SIDECAR_URL}/health`, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

function launchSidecar(): Promise<void> {
  if (startPromise) return startPromise;
  startPromise = new Promise<void>((resolve, reject) => {
    const pyCmd = process.platform === "win32" ? "py" : "python3";
    const pyArgs = process.platform === "win32"
      ? ["-3.11", path.join(BACKEND_DIR, "whisper_sidecar.py")]
      : [path.join(BACKEND_DIR, "whisper_sidecar.py")];

    console.log(`[WHISPER] Starting sidecar: ${pyCmd} ${pyArgs.join(" ")}`);
    sidecarProc = spawn(pyCmd, pyArgs, {
      env: { ...process.env, WHISPER_MODEL, WHISPER_PORT: SIDECAR_PORT },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    sidecarProc.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      console.log(`[WHISPER SIDECAR] ${line}`);
      if (line.includes("READY")) { sidecarReady = true; resolve(); }
    });

    sidecarProc.stderr?.on("data", (d: Buffer) => {
      console.warn(`[WHISPER SIDECAR ERR] ${d.toString().trim()}`);
    });

    sidecarProc.on("close", (code) => {
      console.warn(`[WHISPER] Sidecar exited (code ${code})`);
      sidecarReady = false; sidecarProc = null; startPromise = null;
    });

    let waited = 0;
    const poll = setInterval(async () => {
      waited += 1000;
      if (await isSidecarAlive()) { sidecarReady = true; clearInterval(poll); resolve(); }
      else if (waited >= 30_000) { clearInterval(poll); reject(new Error("Whisper sidecar did not start within 30 s")); }
    }, 1_000);
  });
  return startPromise;
}

async function ensureSidecar(): Promise<void> {
  if (sidecarReady && (await isSidecarAlive())) return;
  sidecarReady = false; startPromise = null;
  await launchSidecar();
}

export async function transcribeAudio(wavBuffer: Buffer): Promise<string> {
  await ensureSidecar();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${SIDECAR_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBuffer,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "unknown");
      throw new Error(`Whisper sidecar HTTP ${res.status}: ${err}`);
    }
    const json = await res.json() as { text: string };
    const text = (json.text || "").trim();
    console.log(`[WHISPER] Transcribed: "${text.slice(0, 80)}"`);
    return text;
  } finally { clearTimeout(timer); }
}

process.on("exit", () => {
  if (sidecarProc && !sidecarProc.killed) sidecarProc.kill();
});

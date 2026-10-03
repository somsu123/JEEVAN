import dns from "node:dns";
try { dns.setDefaultResultOrder("ipv4first"); } catch { }
import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import dotenv from "dotenv";
import {
  extractWithVision,
  generateWithText,
  isOllamaReady,
  sanitizeRxMeds,
  sanitizeScanReport,
  VISION_MODEL,
  TEXT_MODEL,
  LOCAL_AI_ONLY,
} from "./localAi.js";
import {
  preprocessImage,
  checkImageQuality,
  classifyDocument,
  pdfFirstPageToPng,
} from "./tfPreprocess.js";
import { transcribeAudio } from "./whisperBridge.js";
import twilio from "twilio";
import { createServer as createViteServer } from "vite";
import { MongoClient, Db, ObjectId } from "mongodb";

dotenv.config();

process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRITICAL] Unhandled promise rejection:", reason);
});

const RX_EXTRACTION_PROMPT = `You are an expert clinical AI assistant and medical OCR specialist.
Carefully examine this medical prescription / medication list document.

CRITICAL EXTRACTION REQUIREMENTS:
1. Extract EVERY SINGLE medicine / drug listed in the document. DO NOT omit, summarize, or stop after the first few items. If there are 5, 10, 15, or 20 medications, extract every single one individually as a separate item in the medicines list.
2. For each medication:
   - name: exact brand or generic drug name as written (e.g. "Albuterol HFA", "Aspirin", "Carvedilol", "Metformin", "Paracetamol")
   - dosage: strength and unit (e.g. "500mg", "81 mg", "90", "28 units", "25 mg", "1000 mg"), null if unclear
   - frequency: full dosing instructions (e.g. "1 daily", "2 puffs twice a day", "1 twice daily", "28 units at bedtime", "2 puffs every 4 hours as needed")
   - suggestedTime: extract the exact time of dose ONLY if explicitly written in the prescription (e.g. "08:00", "8:30 AM", "14:00", "9:00 PM"). If NO specific clock time is mentioned in the prescription, return null. DO NOT guess, assume, or invent any timing.
   - confidence: "high" if clearly readable, "low" if ambiguous
3. prescriptionNumber: extract any Rx #, Rx ID, Script #, or Prescription Number printed on the paper. If not found, return null.

Return ONLY a valid JSON object matching this schema:
{
  "prescriptionNumber": "string or null",
  "medicines": [
    {
      "name": "exact drug name",
      "dosage": "strength and unit or null",
      "frequency": "dosing instructions or null",
      "suggestedTime": "HH:MM or null",
      "confidence": "high"
    }
  ]
}`;

function extractRxNumber(parsed: any, ocrText?: string): string | null {
  if (parsed && typeof parsed === "object") {
    const candidate = parsed.prescriptionNumber || parsed.rxNumber || parsed.rxNo || parsed.rxId || parsed.prescriptionId || parsed.prescriptionNo;
    if (candidate && typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (ocrText && typeof ocrText === "string") {
    const patterns = [
      /(?:rx\s*(?:#|no\.?|number|num)?|prescription\s*(?:#|no\.?|id|number)?)\s*[:#.\-]?\s*([a-z0-9\-_/]{3,25})/i,
      /(?:presc(?:ription)?\s*(?:id|num|number|#))\s*[:#.\-]?\s*([a-z0-9\-_/]{3,25})/i,
      /(?:rx\s*id|rxid)\s*[:#.\-]?\s*([a-z0-9\-_/]{3,25})/i,
      /\bRx\s*#?\s*([0-9]{3,10})\b/i,
    ];
    for (const pat of patterns) {
      const match = ocrText.match(pat);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }
  return null;
}

function getMedsFingerprint(meds: any[]): string {
  if (!Array.isArray(meds)) return "";
  return meds
    .map(m => `${String(m?.name || "").toLowerCase().trim()}|${String(m?.dosage || "").toLowerCase().trim()}`)
    .sort()
    .join(";;");
}

const SCAN_EXTRACTION_PROMPT = `You are a clinical AI assistant.
Examine this clinical document (e.g. blood test, pathology report, discharge summary) carefully.
Extract a summary of the findings, key metrics, recommended action items, and a medical disclaimer.

Return ONLY a valid JSON object matching this schema:
{
  "overview": "A clear, 2-3 sentence summary of the report",
  "metrics": [{"name": "Metric Name", "value": "Value", "status": "NORMAL|ELEVATED|CONCERNING", "interpretation": "Short explanation"}],
  "actions": ["Action item 1", "Action item 2"],
  "doctorQuestions": ["Question 1"],
  "disclaimer": "Standard disclaimer"
}`;

// ─── MongoDB Atlas Connection ───────────────────────────────────────────────
let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;

async function connectFirebase() {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI is not set in environment.");
    }
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    mongoDb = mongoClient.db("JEEVAN");
    console.log(`[MongoDB] ✅ Connected to Atlas -> JEEVAN`);
  } catch (err: any) {
    console.error("[MongoDB] ❌ Failed to initialize:", err.message);
  }
}

function fireReady(): boolean {
  return !!mongoDb;
}

// ── Medbox schedule types & helpers (MongoDB-backed) ──────────────────────────
export interface DoseEntry {
  time: string;
  medicine: string;
  dosage: string;
  boxNumber: number;
  taken: boolean;
  takenAt?: string;
  missed?: boolean;
  timeoutMinutes?: number;
}

let inMemoryScheduleDoses: DoseEntry[] = [];
function saveScheduleLocally(doses: DoseEntry[]) {
  inMemoryScheduleDoses = [...doses];
}

async function readSchedule(): Promise<DoseEntry[]> {
  if (!fireReady()) return inMemoryScheduleDoses;
  try {
    const docs = await mongoDb!.collection("medbox_schedule").find({}).toArray();
    const result = docs.map((d: any) => {
      const { _id, ...rest } = d;
      return rest as DoseEntry;
    });
    if (result.length > 0) inMemoryScheduleDoses = result;
    return result;
  } catch {
    return inMemoryScheduleDoses;
  }
}

async function writeSchedule(doses: DoseEntry[]): Promise<void> {
  if (!fireReady()) return;
  try {
    const col = mongoDb!.collection("medbox_schedule");
    await col.deleteMany({});
    if (doses.length > 0) {
      await col.insertMany(doses);
    }
  } catch (err: any) {
    console.error("[MongoDB] writeSchedule failed:", err.message);
  }
}

async function appendMedboxEvent(entry: object): Promise<void> {
  if (!fireReady()) return;
  try {
    await mongoDb!.collection("medbox_events").insertOne({
      ...entry,
      loggedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[MongoDB] appendMedboxEvent failed:", err.message);
  }
}


const app = express();
const PORT = parseInt(process.env.PORT || "5050", 10);
const FLASK_URL = process.env.FLASK_BACKEND_URL || "http://localhost:5000";

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use((err: any, _req: any, res: any, next: any) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }
  next(err);
});



// CORS for development
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});




// ─── Local AI (Ollama) initialization ────────────────────────────────────────
console.log(`[AI] LOCAL_AI_ONLY=${LOCAL_AI_ONLY} (Local Ollama + Whisper stack)`);
isOllamaReady().then((ready) => {
  if (ready) {
    console.log("[AI] ✅ Ollama is reachable — local AI stack active.");
  } else {
    console.warn("[AI] ⚠️  Ollama is NOT reachable. Please ensure Ollama is running on port 11434.");
  }
}).catch(() => {
  console.warn("[AI] ⚠️  Ollama health check failed. Please ensure Ollama is running on port 11434.");
});

// ─── SSE clients ─────────────────────────────────────────────────────────────
const sseClients: express.Response[] = [];

function broadcastSSE(eventName: string, data: object) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { /* client gone */ }
  }
}

// ─── Fall event record shape ─────────────────────────────────────────────────
interface FallEventRecord {
  id: string;
  timestamp: string;
  isoTimestamp: string;
  type: string;
  source: string;
  location: string;
  confidence: number | null;
  status: "active" | "resolved";
  resolvedAt?: string;
}

// ── MongoDB-backed fall event helpers ─────────────────────────────────────────
async function saveFallEvent(event: FallEventRecord): Promise<void> {
  if (!fireReady()) return;
  try {
    await mongoDb!.collection("fall_events").replaceOne(
      { id: event.id },
      { ...event },
      { upsert: true }
    );
  } catch (err: any) {
    console.error("[MongoDB] saveFallEvent failed:", err.message);
  }
}

async function getFallEvents(limit = 50): Promise<FallEventRecord[]> {
  if (!fireReady()) return [];
  try {
    const docs = await mongoDb!.collection("fall_events")
      .find({})
      .sort({ isoTimestamp: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d: any) => {
      const { _id, ...rest } = d;
      return rest as FallEventRecord;
    });
  } catch (err: any) {
    console.error("[MongoDB] getFallEvents failed:", err.message);
    return [];
  }
}

async function resolveFallEvent(id: string): Promise<boolean> {
  if (!fireReady()) return false;
  try {
    const resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
    const res = await mongoDb!.collection("fall_events").updateOne(
      { id },
      { $set: { status: "resolved", resolvedAt } }
    );
    return res.modifiedCount > 0;
  } catch {
    return false;
  }
}

async function resolveAllFallEventsBySource(source: string): Promise<number> {
  if (!fireReady()) return 0;
  try {
    const resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
    const res = await mongoDb!.collection("fall_events").updateMany(
      { source, status: "active" },
      { $set: { status: "resolved", resolvedAt } }
    );
    return res.modifiedCount;
  } catch {
    return 0;
  }
}

async function getActiveFallCount(): Promise<number> {
  if (!fireReady()) return 0;
  try {
    return await mongoDb!.collection("fall_events").countDocuments({ status: "active" });
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROXY helpers — forward requests to Flask backend
// ─────────────────────────────────────────────────────────────────────────────
async function flaskGet(endpoint: string) {
  const res = await fetch(`${FLASK_URL}${endpoint}`);
  if (!res.ok) throw new Error(`Flask ${endpoint} returned ${res.status}`);
  return res.json();
}

async function flaskPost(endpoint: string, body: object) {
  const res = await fetch(`${FLASK_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Flask ${endpoint} returned ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE — Real-time push stream
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/events-stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: connected\ndata: {"status":"ok"}\n\n`);
  sseClients.push(res);
  req.on("close", () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE VITALS — MAX30102 values from bpm-server; optional activity fields from Flask.
// ─────────────────────────────────────────────────────────────────────────────
let cachedFlaskState: any = {};
let lastFlaskFetchMs = 0;
let flaskFetchInFlight = false;

async function getFlaskStateAsync(): Promise<any> {
  const now = Date.now();
  if (now - lastFlaskFetchMs < 2000 && Object.keys(cachedFlaskState).length > 0) {
    return cachedFlaskState;
  }
  if (flaskFetchInFlight) {
    return cachedFlaskState;
  }
  flaskFetchInFlight = true;
  try {
    const res = await fetch(`${FLASK_URL}/api/state`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      cachedFlaskState = await res.json();
      lastFlaskFetchMs = Date.now();
    }
  } catch {
    // Keep cached state
  } finally {
    flaskFetchInFlight = false;
  }
  return cachedFlaskState;
}

app.get("/api/vitals", async (_req, res) => {
  try {
    const [statusResponse, historyResponse, state] = await Promise.all([
      fetch("http://localhost:3001/api/bpm/status", { signal: AbortSignal.timeout(1500) }),
      fetch("http://localhost:3001/api/bpm/history?n=60", { signal: AbortSignal.timeout(1000) }).catch(() => null),
      getFlaskStateAsync(),
    ]);
    if (!statusResponse.ok) throw new Error(`bpm-server returned ${statusResponse.status}`);

    const status = await statusResponse.json();
    const historyPayload = historyResponse?.ok ? await historyResponse.json() : { history: [] };
    const history = Array.isArray(historyPayload.history) ? historyPayload.history.slice(-60) : [];
    const lastPacketAt = Number(status.lastReceived);
    const packetAgeMs = Date.now() - lastPacketAt;
    const packetFresh = Boolean(
      status.espConnected && Number.isFinite(lastPacketAt) &&
      packetAgeMs >= -5000 && packetAgeMs <= 8000
    );
    const fingerPresent = packetFresh && Boolean(status.fingerDetected);
    const currentPacket = history.length ? history[history.length - 1] : null;

    return res.json({
      heartRate: fingerPresent && status.latestBpm > 0 ? status.latestBpm : "--",
      oxygenSpO2: fingerPresent && status.latestSpo2 > 0 ? status.latestSpo2 : 0,
      systolicBP: state.systolic || null,
      diastolicBP: state.diastolic || null,
      movementState: state.movement_state || "Unknown",
      bloodLevelSeconds: state.blood_level_seconds != null && Number.isFinite(Number(state.blood_level_seconds))
        ? Number(state.blood_level_seconds)
        : null,
      roomPresence: typeof state.room_presence === "boolean" ? state.room_presence : null,
      fingerPresent,
      signalQuality: packetFresh ? (status.signal || "unknown") : "unknown",
      sensorError: packetFresh && Boolean(currentPacket?.sensorError),
      heartRateHistory: history.map((entry: any) => ({
        time: entry.timestamp,
        value: entry.fingerDetected && entry.bpm > 0 ? entry.bpm : 0,
      })),
      spo2History: history
        .filter((entry: any) => entry.fingerDetected && entry.spo2 > 0)
        .map((entry: any) => ({ time: entry.timestamp, value: entry.spo2 })),
      lastPacketAt: packetFresh ? lastPacketAt : (status.lastReceived || null),
      lastUpdated: packetFresh ? new Date(lastPacketAt).toLocaleTimeString() : "--",
      espConnected: packetFresh,
      isFall: state.is_fall || false,
      fallCount: state.fall_count || 0,
      fallsToday: state.falls_today || 0,
      _liveESP32: packetFresh,
      _offline: false,
    });
  } catch {
    // The live vitals path never substitutes demo or cached BPM/SpO2 values.
    return res.json({
      heartRate: '--', oxygenSpO2: 0,
      systolicBP: null, diastolicBP: null,
      movementState: "Unknown", bloodLevelSeconds: null, roomPresence: null,
      fingerPresent: false, espConnected: false, lastPacketAt: null,
      heartRateHistory: [], spo2History: [], sensorError: false,
      lastUpdated: "--",
      signalQuality: "unknown",
      isFall: false, fallCount: 0, fallsToday: 0,
      _offline: true,
    });
  }
});

// GET /api/bpm/history — proxy to bpm-server (port 3001)
app.get("/api/bpm/history", async (req, res) => {
  try {
    const n = req.query.n || "60";
    const resp = await fetch(`http://localhost:3001/api/bpm/history?n=${n}`);
    if (resp.ok) {
      const data = await resp.json();
      return res.json(data);
    }
  } catch { }
  return res.json({ history: [], stats: { bpm: {}, spo2: {} } });
});

// GET /api/esp32/status — lightweight ESP32 connection + finger detection status
app.get("/api/esp32/status", async (_req, res) => {
  try {
    const r = await fetch("http://localhost:3001/api/bpm/status");
    if (r.ok) return res.json(await r.json());
  } catch { }
  return res.json({
    espConnected: false,
    fingerDetected: false,
    signal: "unknown",
    latestBpm: null,
    latestSpo2: null,
  });
});


// GET /api/heartrate/history — proxy to Flask to get historical BPM data from MongoDB
app.get("/api/heartrate/history", async (req, res) => {
  try {
    const limit = req.query.limit || "60";
    const data = await flaskGet(`/api/heartrate/history?limit=${limit}`);
    return res.json(data);
  } catch {
    return res.json({ history: [] });
  }
});

// Receive vitals from ESP32/bracelet hardware (legacy — kept for compatibility)
app.post("/api/vitals", async (req, res) => {
  try {
    const body = req.body;
    if (body.bpm !== undefined) {
      saveBpmLocally(body.bpm);
      await flaskPost("/api/heartrate", { bpm: body.bpm }).catch(() => { });
    }
    broadcastSSE("vitals_update", body);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BRACELET — Real-time ESP32 wrist sensor endpoints
// ─────────────────────────────────────────────────────────────────────────────

// In-memory bracelet status (online/offline tracking)
const braceletStatus = {
  online: false,
  lastSeen: "",
  bpm: 0,
  fallPhase: "IDLE",
  fingerPresent: false,
  uptime: 0,
  deviceId: "bracelet-01",
};

// ── Camera online tracker (updated whenever Pi sends a fall-event) ────────────
const cameraStatus = {
  online: false,
  lastSeen: "",   // ISO timestamp of last POST from Pi camera
};

// Mark camera offline if no event/heartbeat for 60 s
setInterval(() => {
  if (cameraStatus.lastSeen) {
    const age = Date.now() - new Date(cameraStatus.lastSeen).getTime();
    if (age > 60_000 && cameraStatus.online) {
      cameraStatus.online = false;
      console.log("[CAMERA] Went offline — no event received for 60s");
    }
  }
}, 30_000);

// Mark bracelet offline if no heartbeat for 30 s
setInterval(async () => {
  if (braceletStatus.lastSeen) {
    const age = Date.now() - new Date(braceletStatus.lastSeen).getTime();
    if (age > 30_000 && braceletStatus.online) {
      braceletStatus.online = false;
      broadcastSSE("bracelet_offline", { deviceId: braceletStatus.deviceId });
      console.log("[BRACELET] Went offline — no heartbeat for 30s");

      // Auto-resolve stale bracelet fall events in MongoDB
      const resolved = await resolveAllFallEventsBySource("bracelet");
      resolveAllFallEventsBySourceLocally("bracelet");
      if (resolved > 0) {
        console.log(`[BRACELET] Auto-resolved ${resolved} stale bracelet fall event(s) in MongoDB`);
        broadcastSSE("fall_resolved_batch", { source: "bracelet", count: resolved });
      }
    }
  }
}, 15_000);

// POST /api/bracelet/vitals — receives BPM from ESP32 every 2 s
app.post("/api/bracelet/vitals", async (req, res) => {
  const { bpm, fingerPresent, alert } = req.body as {
    bpm: number;
    fingerPresent?: boolean;
    alert?: "HIGH" | "LOW";
  };

  if (bpm === undefined) return res.status(400).json({ error: "bpm required" });

  // Update in-memory status
  braceletStatus.bpm = bpm;
  braceletStatus.fingerPresent = fingerPresent ?? false;
  braceletStatus.lastSeen = new Date().toISOString();
  braceletStatus.online = true;

  // Broadcast to dashboard via SSE
  broadcastSSE("vitals_update", { heartRate: bpm, bpm, alert, fingerPresent });

  // Save BPM locally
  saveBpmLocally(bpm);

  // Forward to Flask for DB persistence
  if (bpm > 0) {
    flaskPost("/api/heartrate", { bpm }).catch(() => { });
  }

  // Log abnormal BPM
  if (alert) {
    console.log(`[BRACELET] ⚠ ${alert} BPM: ${bpm}`);
  }

  return res.json({ received: true });
});

// POST /api/bracelet/heartbeat — bracelet sends this every 10 s
app.post("/api/bracelet/heartbeat", (req, res) => {
  const { deviceId, bpm, fallPhase, fingerPresent, uptime } = req.body as {
    deviceId?: string;
    bpm?: number;
    fallPhase?: string;
    fingerPresent?: boolean;
    uptime?: number;
  };

  braceletStatus.online = true;
  braceletStatus.lastSeen = new Date().toISOString();
  braceletStatus.bpm = bpm ?? braceletStatus.bpm;
  braceletStatus.fallPhase = fallPhase ?? "IDLE";
  braceletStatus.fingerPresent = fingerPresent ?? false;
  braceletStatus.uptime = uptime ?? 0;
  braceletStatus.deviceId = deviceId ?? "bracelet-01";

  // Persist bracelet status to MongoDB
  if (fireReady()) {
    mongoDb!.collection("device_status").replaceOne(
      { _id: "bracelet" as any },
      {
        ...braceletStatus,
        updatedAt: new Date().toISOString()
      },
      { upsert: true }
    ).catch(() => { });
  }

  broadcastSSE("bracelet_heartbeat", braceletStatus);
  return res.json({ status: "ok" });
});

// GET /api/bracelet/status — dashboard polling fallback
app.get("/api/bracelet/status", (_req, res) => {
  return res.json(braceletStatus);
});




// ─────────────────────────────────────────────────────────────────────────────
// FALL ALERTS — Gmail + SMS notifications
// ─────────────────────────────────────────────────────────────────────────────

// 5-minute cooldown per alert type so we don't spam on rapid events
const lastFallAlertAt = new Map<string, number>();
function isFallAlertCooling(key: string, cooldownMs = 5 * 60 * 1000): boolean {
  const last = lastFallAlertAt.get(key) ?? 0;
  return Date.now() - last < cooldownMs;
}
function markFallAlerted(key: string) {
  lastFallAlertAt.set(key, Date.now());
}

// Per-device rate limit: hard block repeated fall POSTs from same device
// This is the last line of defence — firmware cooldown + this = no spam
const deviceFallRateLimit = new Map<string, number>();
const DEVICE_FALL_RATE_MS = 2 * 60 * 1000; // 2 minutes per device
function isDeviceFallRateLimited(deviceId: string): boolean {
  const last = deviceFallRateLimit.get(deviceId) ?? 0;
  return Date.now() - last < DEVICE_FALL_RATE_MS;
}
function markDeviceFallFired(deviceId: string) {
  deviceFallRateLimit.set(deviceId, Date.now());
}

// ── Gmail alert for fall event ─────────────────────────────────────────────
async function sendFallEmailAlert(event: FallEventRecord) {
  // Removed
}

// ── SMS alert for fall event via Twilio ────────────────────────────────────
async function sendFallSmsAlert(event: FallEventRecord) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;   // e.g. "+12025551234"
  const toNumber = process.env.CAREGIVER_PHONE;      // e.g. "+919876543210"

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    console.warn("[SMS] Twilio credentials not fully set — skipping fall SMS");
    return;
  }

  const client = twilio(accountSid, authToken);

  const sourceLabel = event.source === "bracelet" ? "Bracelet"
    : event.source === "camera" ? "Camera"
      : event.source === "both" ? "Bracelet+Camera" : event.source;

  const body =
    `🚨 ELDERCARE ALERT\n` +
    `${event.type.toUpperCase()} detected!\n` +
    `Patient: Care recipient\n` +
    `Source: ${sourceLabel}\n` +
    `Location: ${event.location}\n` +
    `Confidence: ${event.confidence == null ? "unavailable" : `${Math.round(event.confidence * 100)}%`}\n` +
    `Time: ${event.timestamp}\n` +
    `Please respond immediately or call 112.`;

  await client.messages.create({ body, from: fromNumber, to: toNumber });
  console.log(`[SMS] Fall alert SMS sent to ${toNumber} — ${event.type}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FALL EVENTS — receive from camera/bracelet, store, alert caregiver
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/fall-event", async (req, res) => {
  try {
    const body = req.body;

    // ── Bracelet sends is_fall:false as a reset — ignore it silently ──────
    if (body.is_fall === false) {
      return res.json({ received: true, ignored: "fall reset" });
    }

    const source: string = body.source || "camera";

    // ── BUG FIX: Validate source device is actually online ────────────────
    // A device that is disconnected/offline cannot physically detect a fall.
    // Accepting reports from offline devices causes ghost alerts.
    if (source === "bracelet" && !braceletStatus.online) {
      console.warn(`[FALL] REJECTED — bracelet source but bracelet is OFFLINE (deviceId=${braceletStatus.deviceId})`);
      return res.status(409).json({
        received: false,
        rejected: "bracelet is offline — cannot report fall events while disconnected",
      });
    }
    if (source === "camera" && !cameraStatus.online) {
      // Camera gets a grace period: if it just came online it may not have
      // sent a heartbeat yet. Only reject if it has been seen before but is now offline.
      if (cameraStatus.lastSeen) {
        console.warn(`[FALL] REJECTED — camera source but camera is OFFLINE (last seen: ${cameraStatus.lastSeen})`);
        return res.status(409).json({
          received: false,
          rejected: "camera is offline — cannot report fall events while disconnected",
        });
      }
      // First-time camera event: mark it online and allow through
    }

    // ── Update camera online status on every valid camera event ───────────
    if (source === "camera") {
      cameraStatus.online = true;
      cameraStatus.lastSeen = new Date().toISOString();
    }

    // ── Per-device rate limit: hard-block same device firing within 2 min ─
    const deviceId: string = body.deviceId || source;
    if (isDeviceFallRateLimited(deviceId)) {
      console.warn(`[FALL] RATE-LIMITED — deviceId="${deviceId}" already fired within ${DEVICE_FALL_RATE_MS / 1000}s`);
      return res.status(429).json({
        received: false,
        rateLimited: true,
        retryAfter: `${DEVICE_FALL_RATE_MS / 1000}s`,
      });
    }
    markDeviceFallFired(deviceId);

    const now = new Date();
    const confidence = body.confidence != null && Number.isFinite(Number(body.confidence))
      ? Number(body.confidence)
      : null;
    let type = "Fall Detected";
    if (confidence != null && confidence >= 0.85) type = "Critical Fall";
    else if (confidence != null && confidence >= 0.65) type = "Rapid Descent";

    const event: FallEventRecord = {
      id: `fall-${Date.now()}`,
      isoTimestamp: now.toISOString(),
      timestamp:
        now.toLocaleTimeString("en-US", { hour12: false }) +
        " — " +
        now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      type,
      source,
      location: typeof body.location === "string" && body.location.trim() ? body.location : "Unknown location",
      confidence,
      status: "active",
    };

    // Persist to Firebase and Local files
    await saveFallEvent(event);
    saveFallEventLocally(event);
    logEventLocally("fall", `Fall detected: ${event.type} at ${event.location}`, "critical");

    // Forward to Flask backend
    try {
      await flaskPost("/api/fall", {
        is_fall: true,
        confidence: event.confidence,
        source: event.source,
      });
    } catch { /* Flask might be offline */ }

    // Broadcast to dashboard via SSE
    broadcastSSE("fall_event", event);
    console.log(`[FALL] ${type} at ${event.location} — source: ${event.source} — confidence: ${event.confidence}`);

    // ── Send Gmail + SMS alerts (5-minute cooldown to prevent spam) ────────
    const alertKey = `fall-${type}`;
    if (!isFallAlertCooling(alertKey)) {
      markFallAlerted(alertKey);

      // Fire both alerts in parallel — don't await so response is fast
      Promise.allSettled([
        sendFallEmailAlert(event),
        sendFallSmsAlert(event),
      ]).then(results => {
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            console.error(`[ALERT] ${i === 0 ? "Email" : "SMS"} failed:`, r.reason?.message);
          }
        });
      });
    } else {
      console.log(`[ALERT] Cooldown active — skipping Gmail/SMS for ${type}`);
    }

    return res.json({ success: true, eventId: event.id, alertSent: !isFallAlertCooling(alertKey) });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

app.get("/api/fall-events", async (_req, res) => {
  try {
    const [events, flaskEvents] = await Promise.allSettled([
      getFallEvents(50),
      flaskGet("/api/events").catch(() => []),
    ]);
    return res.json({
      events: events.status === "fulfilled" ? events.value : [],
      flaskEvents: flaskEvents.status === "fulfilled" ? flaskEvents.value : [],
    });
  } catch {
    return res.json({ events: [], flaskEvents: [] });
  }
});

app.patch("/api/fall-event/:id/resolve", async (req, res) => {
  const { id } = req.params;
  resolveFallEventLocally(id);
  const ok = await resolveFallEvent(id);
  if (!ok) return res.status(404).json({ error: "Event not found" });
  broadcastSSE("fall_resolved", { id });
  return res.json({ success: true });
});

// POST /api/camera/heartbeat — USB / Pi camera reports online every 5s
app.post("/api/camera/heartbeat", (req, res) => {
  cameraStatus.online = true;
  cameraStatus.lastSeen = new Date().toISOString();
  broadcastSSE("camera_heartbeat", cameraStatus);
  return res.json({ status: "ok", online: true });
});

// GET /api/camera/status — get current camera online state
app.get("/api/camera/status", (_req, res) => {
  return res.json(cameraStatus);
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDICINE BOX — proxied from Flask /api/medicine + /api/schedule
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/medicine-schedule", async (_req, res) => {
  try {
    const data = await flaskGet("/api/schedule");
    return res.json(data);
  } catch {
    return res.json({ schedule: [], slots: [] });
  }
});

app.post("/api/medicine-schedule", async (req, res) => {
  try {
    const { slots } = req.body;

    // Persist to MongoDB Atlas medbox_schedule collection
    if (Array.isArray(slots)) {
      const doses: DoseEntry[] = slots.map((s: any) => ({
        time: s.scheduledTime || "08:00",
        medicine: s.medicineName || "Unknown Medicine",
        dosage: s.dosage || "—",
        boxNumber: Number(s.slotNumber) || 1,
        taken: s.taken || false,
        takenAt: s.takenAt,
        missed: s.missed || false,
        timeoutMinutes: Math.min(10, Math.max(1, Number(s.timeoutMinutes) || 5)),
      }));
      await writeSchedule(doses);
      saveScheduleLocally(doses);
      console.log(`[MongoDB] Wrote ${doses.length} doses to medbox_schedule (timeouts: ${doses.map(d => `${d.boxNumber}:${d.timeoutMinutes}m`).join(", ")}).`);
    }

    const times = (slots || []).map((s: any) => s.scheduledTime).filter(Boolean);
    await flaskPost("/api/schedule", times).catch(() => { });

    broadcastSSE("medicine_schedule_updated", { slots });
    const updatedDoses = await readSchedule();
    broadcastSSE("schedule_updated", { doses: updatedDoses });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

app.post("/api/medicine-taken", async (req, res) => {
  try {
    const { slotId, lidOpen, touchVerified } = req.body;

    // Update medbox_schedule in MongoDB Atlas
    if (slotId && typeof slotId === 'string') {
      const parts = slotId.split('-');
      let boxNumber = 1;
      let matched = false;

      if (parts[0] === 'slot' && parts[1]) {
        boxNumber = parseInt(parts[1], 10) || 1;
        matched = true;
      }

      const schedule = await readSchedule();
      const takenAt = new Date().toLocaleTimeString("en-US", { hour12: false });
      const updatedSchedule = schedule.map((dose) => {
        if (matched && Number(dose.boxNumber) === boxNumber && !dose.taken) {
          dose.taken = true;
          dose.takenAt = takenAt;
        } else if (!matched && dose.medicine.toLowerCase() === slotId.toLowerCase() && !dose.taken) {
          dose.taken = true;
          dose.takenAt = takenAt;
        }
        return dose;
      });

      await writeSchedule(updatedSchedule);
      saveScheduleLocally(updatedSchedule);
      console.log(`[MongoDB] Marked box ${boxNumber} as TAKEN in medbox_schedule.`);
      broadcastSSE("schedule_updated", { doses: updatedSchedule });
    }

    await flaskPost("/api/medicine", {
      lid_open: lidOpen ?? true,
      reminder_triggered: false,
    }).catch(() => { });

    broadcastSSE("medicine_taken", { slotId });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

app.get("/api/medicine-state", async (_req, res) => {
  if (medboxStatus.online) {
    return res.json({
      lidOpen: medboxLidOpen,
      reminderTriggered: medboxStatus.state === "PENDING" || medboxStatus.state === "REMINDER",
      nextReminder: medboxStatus.nextDoseTime || null,
    });
  }

  try {
    const state = await flaskGet("/api/state");
    return res.json({
      lidOpen: state.lid_open || false,
      reminderTriggered: state.reminder_triggered || false,
      nextReminder: state.next_reminder || null,
    });
  } catch {
    return res.json({ lidOpen: false, reminderTriggered: false, nextReminder: null });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORT SCANNER — Local AI vision analysis + medicine extraction + MongoDB save
// ─────────────────────────────────────────────────────────────────────────────

// Voice Assistant buffer for checkPendingSpeak
let pendingSpeakText: string | null = null;

// Track which medicines have already triggered a reminder this minute
const reminderFiredAt = new Map<string, string>(); // key: "MedName@HH:MM" → fired ISO time

// Medicine Reminder Cron — runs every 60 seconds
setInterval(async () => {
  try {
    const { due } = await flaskGet("/api/medicines/due?window=2").catch(() => ({ due: [] }));
    if (!Array.isArray(due) || due.length === 0) return;

    const now = new Date();
    const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    for (const med of due as Array<{ name: string; dosage: string; scheduledTime: string; purpose?: string }>) {
      const key = `${med.name}@${med.scheduledTime}`;
      const lastFired = reminderFiredAt.get(key);

      // Only fire once per minute-window per medicine
      if (lastFired) {
        const age = Date.now() - new Date(lastFired).getTime();
        if (age < 3 * 60 * 1000) continue;  // skip if fired in last 3 min
      }

      reminderFiredAt.set(key, now.toISOString());

      const timeStr = (() => {
        const [h, m] = med.scheduledTime.split(":").map(Number);
        const period = h >= 12 ? "PM" : "AM";
        const h12 = h % 12 || 12;
        return `${h12}:${String(m).padStart(2, "0")} ${period}`;
      })();

      const speakText = `It is ${timeStr}. Time for your ${med.name}${med.dosage ? ", " + med.dosage : ""}. Please take your medicine now.`;

      // 1. Broadcast SSE alert to dashboard
      broadcastSSE("medicine_reminder", {
        medicine: med.name,
        dosage: med.dosage,
        time: med.scheduledTime,
        message: speakText,
      });

      // 2. Set pending speech for voice assistant polling
      pendingSpeakText = speakText;

      console.log(`[REMINDER] ${speakText}`);
    }
  } catch (err: any) {
    console.error("[REMINDER] Cron error:", err?.message);
  }
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// MEDICINE TIMEOUT & MISSED DOSE WATCHDOG
// ─────────────────────────────────────────────────────────────────────────────
// Checks active doses every 10 seconds against current time and slot timeout (1 to 10 min).
// When timeout is exceeded without intake, automatically marks dose as missed,
// updates medbox_schedule, appends dose_events & medbox_events in MongoDB, and broadcasts SSE.
setInterval(async () => {
  try {
    const schedule = await readSchedule();
    if (!schedule || schedule.length === 0) return;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let scheduleModified = false;

    for (const dose of schedule) {
      if (dose.taken || dose.missed) continue;
      if (!dose.time || !dose.time.includes(":")) continue;

      const [h, m] = dose.time.split(":").map(Number);
      if (isNaN(h) || isNaN(m)) continue;

      const doseMinutes = h * 60 + m;
      const timeout = Math.min(10, Math.max(1, Number(dose.timeoutMinutes) || 5));
      const expiryMinutes = doseMinutes + timeout;
      const minutesSinceDose = currentMinutes - doseMinutes;

      // When the current time exceeds dose scheduled time + timeout (within active 12-hour window)
      if (currentMinutes >= expiryMinutes && minutesSinceDose >= timeout && minutesSinceDose < 720) {
        console.log(`[TIMEOUT WATCHDOG] ⚠️ Timeout expired for Box ${dose.boxNumber}: "${dose.medicine}" (scheduled ${dose.time}, limit ${timeout}m). Marking as MISSED.`);
        dose.missed = true;
        scheduleModified = true;

        const compIdx = (Number(dose.boxNumber) || 1) - 1;

        // 1. Log to dose_events (history/adherence)
        await appendDoseEvent({
          compartment: compIdx,
          boxNumber: Number(dose.boxNumber) || 1,
          label: dose.medicine,
          scheduledTime: dose.time,
          timeoutMinutes: timeout,
          takenAt: null,
          status: "missed",
          reason: `Timeout limit of ${timeout} minutes exceeded`,
        });

        // 2. Log to medbox_events
        await appendMedboxEvent({
          event: "DOSE_MISSED",
          boxNumber: Number(dose.boxNumber) || 1,
          medicine: dose.medicine,
          dosage: dose.dosage,
          timeoutMinutes: timeout,
          timestamp: now.toISOString(),
          deviceId: "medbox-01",
        });

        // 3. Broadcast SSE alerts to all connected clients
        broadcastSSE("medicine_missed", {
          box: Number(dose.boxNumber) || 1,
          medicine: dose.medicine,
          time: dose.time,
          timeoutMinutes: timeout,
          timestamp: now.toLocaleTimeString("en-US", { hour12: false }),
        });

        broadcastSSE("dose_event", {
          compartment: compIdx,
          label: dose.medicine,
          status: "missed",
          takenAt: null,
        });

        // 4. Send caregiver alert
        sendMissedDoseAlert(dose.medicine, dose.time, dose.dosage).catch(() => { });
      }
    }

    if (scheduleModified) {
      await writeSchedule(schedule);
      saveScheduleLocally(schedule);
      broadcastSSE("schedule_updated", { doses: schedule });
      broadcastSSE("medicine_schedule_updated", {
        slots: schedule.map(d => ({
          slotNumber: d.boxNumber,
          medicineName: d.medicine,
          dosage: d.dosage,
          scheduledTime: d.time,
          taken: d.taken,
          takenAt: d.takenAt,
          missed: d.missed,
          timeoutMinutes: d.timeoutMinutes || 5,
        }))
      });
      console.log(`[TIMEOUT WATCHDOG] ✅ Updated medbox_schedule after marking missed doses.`);
    }
  } catch (err: any) {
    console.error("[TIMEOUT WATCHDOG] Error checking dose timeouts:", err?.message);
  }
}, 10_000);





app.post("/api/scan-report", async (req, res) => {
  try {
    const { fileData, mimeType, fileName, promptText } = req.body;
    if (!fileData && !promptText) return res.status(400).json({ error: "Missing fileData (base64 string)" });

    if (!(await isOllamaReady())) {
      return res.status(503).json({ error: "Local AI vision service (Ollama) is not running. Please start Ollama." });
    }

    let raw = "";
    let parsed: any = null;
    let usedModel = "";

    // If preset promptText is provided and fileData is small/simulated:
    if (promptText && (!fileData || fileData.length < 200)) {
      console.log("[SCAN] Extracting medicines from preset clinical text...");
      const textPrompt = `You are a medical prescription parser.
Analyze this clinical text carefully:
"${promptText}"

Extract all prescribed medicines and drugs.
Respond ONLY with a valid JSON object matching this exact format:
{
  "medicines": [
    {
      "name": "Medicine Name",
      "dosage": "dosage string",
      "frequency": "frequency string",
      "suggestedTime": "08:00",
      "purpose": "instructions or indication if noted"
    }
  ],
  "overview": "Brief note on medicines extracted."
}
`;
      const resText = await generateWithText(textPrompt);
      raw = resText.text;
      try { parsed = JSON.parse(raw); } catch { }
      usedModel = resText.model;
    } else {
      // -- Step 1: Decode + PDF rasterise
      let cleanBase64 = fileData;
      if (cleanBase64.includes(",")) cleanBase64 = cleanBase64.split(",")[1];
      let imageBuffer = Buffer.from(cleanBase64, "base64");
      const isPdf = (mimeType || "").toLowerCase().includes("pdf") || (fileName || "").toLowerCase().endsWith(".pdf");
      if (isPdf) {
        console.log("[SCAN] PDF detected -- rasterising first page...");
        try {
          imageBuffer = await pdfFirstPageToPng(imageBuffer);
        } catch (pdfErr: any) {
          console.warn("[SCAN] PDF rasterisation failed:", pdfErr.message);
        }
      }

      // -- Step 2: Quality gate (advisory)
      try {
        const quality = await checkImageQuality(imageBuffer);
        if (!quality.pass) console.warn("[SCAN] Image quality warning:", quality.reason);
      } catch { }

      // -- Step 3: Sharp preprocessing (auto-orient + normalize contrast)
      let processedBase64 = cleanBase64;
      try {
        const prep = await preprocessImage(imageBuffer);
        if (prep?.base64) processedBase64 = prep.base64;
      } catch { }

      // -- Step 4: Vision extraction (Dedicated to medicines)
      console.log("[SCAN] Extracting medicines from document using Ollama Vision...");
      const resScan = await extractWithVision(processedBase64, SCAN_EXTRACTION_PROMPT);
      raw = resScan.raw;
      parsed = resScan.parsed;
      usedModel = resScan.model;
    }

    if (!parsed && !raw) return res.status(500).json({ error: "Vision model returned empty response." });

    // -- Step 5: Sanitise into Schema-B focusing strictly on medicines
    const schemaData = sanitizeScanReport(parsed ?? raw);
    console.log(`[SCAN] Extracted via ${usedModel}: ${schemaData.medicines.length} medicines`);

    // -- Step 6: Build markdown clinical summary
    let summaryText = `## AI Clinical Summary\n${schemaData.overview || "Document scan complete."}\n`;
    
    if (schemaData.metrics && schemaData.metrics.length > 0) {
      summaryText += `\n## Full OCR Test Report\n`;
      schemaData.metrics.forEach((m: any) => {
        summaryText += `* **${m.name}**: ${m.value} (${m.status}) — *${m.interpretation}*\n`;
      });
    }
    if (schemaData.actions && schemaData.actions.length > 0) {
      summaryText += `\n## Action Items\n`;
      schemaData.actions.forEach((a: string) => { summaryText += `* ${a}\n`; });
    }
    summaryText += `\n## Medical Disclaimer\n${schemaData.disclaimer}\n`;

    // -- Step 7: Persist to MongoDB + SSE
    try {
      const scanDate = new Date().toLocaleTimeString("en-US", { hour12: false }) + " -- " + new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      saveReportLocally({ fileName: fileName || "unnamed document", summary: summaryText, scanDate, medicines: schemaData.medicines, overview: schemaData.overview });
      if (schemaData.medicines && schemaData.medicines.length > 0) saveMedicinesLocally(schemaData.medicines);
      logEventLocally("scan", `Prescription report scanned: ${schemaData.medicines.length} medicines extracted`, "info");
      await flaskPost("/api/reports/save", { fileName: fileName || "unnamed document", summary: summaryText, scanDate, medicines: schemaData.medicines || [] });
      if (mongoDb) {
        await mongoDb.collection("scanned_reports").insertOne({
          fileName: fileName || "unnamed document",
          scanDate: new Date(),
          summaryText,
          schemaData,
          usedModel
        });
      }
      console.log(`[DB] Scanned report saved to MongoDB.`);
      if (schemaData.medicines && schemaData.medicines.length > 0) broadcastSSE("medicines_extracted", { medicines: schemaData.medicines, source: "scan" });
    } catch (dbErr: any) { console.error("[WARN] Failed to save scanned report:", dbErr?.message); }

    // -- Step 6b: Extract structured Rx fields from raw parsed (new schema)
    const rawParsedScan = (parsed && typeof parsed === "object") ? parsed as Record<string, any> : {};
    const hwQuality: string = rawParsedScan.handwriting_quality || "unknown";
    const langDetected: string = rawParsedScan.language_detected || "unknown";
    const uncertainItemsList: string[] = Array.isArray(rawParsedScan.uncertain_items) ? rawParsedScan.uncertain_items : [];

    // Enrich medicines with structured fields from the new schema
    const enrichedMeds = schemaData.medicines.map((m: any, i: number) => {
      const rawMed = Array.isArray(rawParsedScan.medicines) ? rawParsedScan.medicines[i] : null;
      return {
        ...m,
        name_as_written: rawMed?.name_as_written || m.name,
        normalized_name: rawMed?.normalized_name || m.name,
        form: rawMed?.form || "unknown",
        strength: rawMed?.strength || m.dosage || null,
        dosage: rawMed?.dosage || null,
        frequency_raw: rawMed?.frequency_raw || m.frequency || m.purpose || "",
        timings: rawMed?.timings || {
          morning: null, afternoon: null, night: null,
          before_food: null, after_food: null, duration_days: null,
        },
        source_line: typeof rawMed?.source_line === "number" ? rawMed.source_line : null,
        confidence: typeof rawMed?.confidence === "number" ? rawMed.confidence : null,
        confidence_reason: rawMed?.confidence_reason || "",
        illegible_fields: Array.isArray(rawMed?.illegible_fields) ? rawMed.illegible_fields : [],
        suggestedTime: m.times?.[0] || rawMed?.suggestedTime || null,
        frequency: rawMed?.frequency_raw || m.frequency || "",
      };
    });

    return res.json({
      success: true,
      summary: summaryText,
      medicines: enrichedMeds,
      handwriting_quality: hwQuality,
      language_detected: langDetected,
      uncertain_items: uncertainItemsList,
      overview: schemaData.overview,
      actions: schemaData.actions,
      disclaimer: schemaData.disclaimer,
    });
  } catch (error: any) {
    console.error("[SCAN] Local AI Scan Error:", error);
    return res.status(500).json({ error: error?.message || "Internal server error with local AI." });
  }
});

// GET /api/saved-reports — fetch all saved reports from MongoDB
app.get("/api/saved-reports", async (_req, res) => {
  try {
    const data = await flaskGet("/api/reports");
    return res.json(data);
  } catch {
    return res.json({ reports: [] });
  }
});

// GET /api/medicines/schedule — all medicines with times from MongoDB
app.get("/api/medicines/schedule", async (_req, res) => {
  try {
    const data = await flaskGet("/api/medicines");
    return res.json(data);
  } catch {
    return res.json({ medicines: [] });
  }
});

// POST /api/medicines/add — manually add a medicine
app.post("/api/medicines/add", async (req, res) => {
  try {
    const { name, dosage, purpose, times } = req.body as {
      name: string; dosage?: string; purpose?: string; times?: string[];
    };
    if (!name) return res.status(400).json({ error: "name required" });
    saveMedicinesLocally([{ name, dosage: dosage || "", purpose: purpose || "", times: times || ["08:00"] }]);
    logEventLocally("medicine", `Medicine '${name}' added manually`, "info");
    await flaskPost("/api/medicines/save", {
      medicines: [{ name, dosage: dosage || "", purpose: purpose || "", times: times || ["08:00"] }],
      source: "manual",
    });
    broadcastSSE("medicines_extracted", { medicines: [{ name, dosage, purpose, times }], source: "manual" });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// DELETE /api/medicines/:name — remove a medicine
app.delete("/api/medicines/:name", async (req, res) => {
  const { name } = req.params;
  try {
    deleteMedicineLocally(name);
    logEventLocally("medicine", `Medicine '${name}' deleted`, "info");
    const result = await fetch(`${FLASK_URL}/api/medicines/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await result.json();
    broadcastSSE("medicine_deleted", { name });
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// MEDICINE BOX — ESP32 Hardware Integration
// ─────────────────────────────────────────────────────────────────────────────

// ── Medbox device status ──────────────────────────────────────────────────────
interface MedboxStatusRecord {
  online: boolean;
  state: string;
  presenceDetected: boolean;
  lastSeen: string;
  nextDoseTime: string;
  uptime: number;
  deviceId: string;
}

const medboxStatus: MedboxStatusRecord = {
  online: false,
  state: "UNKNOWN",
  presenceDetected: false,
  lastSeen: "",
  nextDoseTime: "",
  uptime: 0,
  deviceId: "medbox-01",
};

let remoteOpenFlag = false;
let medboxLidOpen = false;
let pendingCompartmentAssign: { compartment: number; label: string; time: string; timestamp: number } | null = null;

// Mark offline if no heartbeat for 30 s
setInterval(() => {
  if (medboxStatus.lastSeen) {
    const age = Date.now() - new Date(medboxStatus.lastSeen).getTime();
    if (age > 30_000 && medboxStatus.online) {
      medboxStatus.online = false;
      broadcastSSE("medbox_offline", { deviceId: medboxStatus.deviceId });
      console.log("[MEDBOX] Device went offline — no heartbeat for 30s");
    }
  }
}, 15_000);

// ── Helper: next dose time (async — reads from MongoDB) ─────────────────────
async function getNextDoseTime(): Promise<string> {
  const schedule = await readSchedule();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const upcoming = schedule
    .filter((d) => !d.taken && !d.missed)
    .map((d) => {
      const [h, m] = d.time.split(":").map(Number);
      return { time: d.time, min: h * 60 + m };
    })
    .filter((d) => d.min >= nowMin)
    .sort((a, b) => a.min - b.min);
  return upcoming[0]?.time ?? "";
}

// ── Gmail / Nodemailer ────────────────────────────────────────────────────────
async function sendMissedDoseAlert(medicine: string, time: string, dosage: string) {
  // Removed
}

// ── GET /api/medication/schedule ──────────────────────────────────────────────
app.get("/api/medication/schedule", async (_req, res) => {
  try {
    const doses = await readSchedule();
    if (doses && doses.length > 0) {
      return res.json({ deviceId: "medbox-01", doses });
    }

    // Fallback: check Flask medicines collection if medbox_schedule is empty
    const data = await flaskGet("/api/medicines").catch(() => ({ medicines: [] }));
    if (data && Array.isArray(data.medicines) && data.medicines.length > 0) {
      const dbMeds = data.medicines;
      const sortedMeds = [...dbMeds].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 4);
      const fallbackDoses: DoseEntry[] = [];
      sortedMeds.forEach((med, index) => {
        const boxNumber = index + 1;
        const times = Array.isArray(med.times) && med.times.length > 0 ? med.times : ["08:00"];
        times.forEach((t: string) => {
          fallbackDoses.push({
            time: t,
            medicine: med.name,
            dosage: med.dosage || "—",
            boxNumber: boxNumber,
            taken: false,
            missed: false,
            timeoutMinutes: 5,
          });
        });
      });
      return res.json({ deviceId: "medbox-01", doses: fallbackDoses });
    }

    return res.json({ deviceId: "medbox-01", doses: [] });
  } catch (err: any) {
    console.warn(`[MongoDB] Schedule fetch error (${err.message}). Returning cached schedule.`);
    const doses = await readSchedule();
    return res.json({ deviceId: "medbox-01", doses });
  }
});

// ── POST /api/medication/schedule (caregiver sets/updates schedule) ──────────
app.post(["/api/medication/schedule", "/api/medication/schedule-esp"], async (req, res) => {
  try {
    const { doses } = req.body as { doses: DoseEntry[] };
    if (!Array.isArray(doses)) return res.status(400).json({ error: "doses array required" });
    await writeSchedule(doses);
    broadcastSSE("schedule_updated", { doses });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ── POST /api/hardware/heartbeat (ESP32 heartbeat telemetry) ──────────────────
app.post("/api/hardware/heartbeat", (req, res) => {
  const { deviceId, state, presenceDetected, nextDoseTime, uptime, lidOpen } = req.body as {
    deviceId: string;
    state: string;
    presenceDetected: boolean;
    nextDoseTime: string;
    uptime: number;
    lidOpen?: boolean;
  };

  medboxStatus.online = true;
  medboxStatus.lastSeen = new Date().toISOString();
  medboxStatus.state = state || "UNKNOWN";
  medboxStatus.presenceDetected = presenceDetected ?? false;
  medboxStatus.nextDoseTime = nextDoseTime || "";
  medboxStatus.uptime = uptime ?? 0;
  medboxStatus.deviceId = deviceId || "medbox-01";

  // Dynamically record physical lid-open state
  if (lidOpen !== undefined) {
    medboxLidOpen = lidOpen;
  }

  // Persist medbox status to MongoDB
  if (fireReady()) {
    mongoDb!.collection("device_status").replaceOne(
      { _id: "medbox-01" as any },
      {
        ...medboxStatus,
        updatedAt: new Date().toISOString()
      },
      { upsert: true }
    ).catch(() => { });
  }

  // Broadcast telemetry updates to the React UI via SSE
  broadcastSSE("medbox_heartbeat", medboxStatus);

  // Send remote lid-open request active status & assignedSlot if pending, plus real-time clock sync
  const now = new Date();
  const response: any = {
    remoteOpen: remoteOpenFlag,
    epoch: Math.floor(now.getTime() / 1000),
    time: now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }),
    gmtOffset: 19800,
  };
  if (remoteOpenFlag) {
    console.log(`[HEARTBEAT] Served remote lid-open request to medbox. Resetting flag.`);
    remoteOpenFlag = false;
  }
  if (pendingCompartmentAssign && (Date.now() - pendingCompartmentAssign.timestamp < 30_000)) {
    response.remoteOpen = true;
    response.assignedSlot = {
      compartment: pendingCompartmentAssign.compartment,
      label: pendingCompartmentAssign.label,
      time: pendingCompartmentAssign.time,
    };
    console.log(`[HEARTBEAT] Served assignedSlot trigger to medbox for compartment ${pendingCompartmentAssign.compartment}`);
    pendingCompartmentAssign = null;
  }

  return res.json(response);
});

// ── GET /api/hardware/time (Instant RTC Clock Sync Endpoint for ESP32) ────────
app.get("/api/hardware/time", (req, res) => {
  const now = new Date();
  return res.json({
    epoch: Math.floor(now.getTime() / 1000),
    time: now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }),
    iso: now.toISOString(),
    gmtOffset: 19800
  });
});

// ── POST /api/hardware/medbox-event (ESP32 pill intake confirmation) ──────────
app.post("/api/hardware/medbox-event", async (req, res) => {
  const { event, box, medicine, dosage, timestamp, deviceId } = req.body as {
    event: string;
    box: number;
    medicine: string;
    dosage: string;
    timestamp: string;
    deviceId: string;
  };

  if (event === "DOSE_TAKEN") {
    console.log(`[EVENT] Box ${box}: ${medicine} (${dosage}) taken at ${timestamp} on ${deviceId}`);

    // Log to MongoDB medbox_events collection
    await appendMedboxEvent({ event, boxNumber: box, medicine, dosage, timestamp, deviceId });

    // Auto-update taken state in MongoDB medbox_schedule
    const schedule = await readSchedule();
    let updated = false;
    const payloadTimeHHMM = timestamp && timestamp.length >= 5 ? timestamp.substring(0, 5) : "";

    const updatedSchedule = schedule.map((dose) => {
      const medicineMatches = dose.medicine.toLowerCase().trim() === medicine.toLowerCase().trim();
      const timeMatches = dose.time === payloadTimeHHMM || (timestamp && timestamp.includes(dose.time));
      const boxMatches = Number(dose.boxNumber) === Number(box);

      if (medicineMatches && timeMatches && boxMatches) {
        dose.taken = true;
        dose.takenAt = timestamp;
        updated = true;
      }
      return dose;
    });

    if (updated) {
      await writeSchedule(updatedSchedule);
      broadcastSSE("schedule_updated", { doses: updatedSchedule });
      broadcastSSE("medicine_taken", { box: Number(box), timestamp });
    }

    return res.json({ success: true, matched: updated });
  }

  return res.status(400).json({ error: "Unknown event type" });
});

// ── POST /api/hardware/remote-open (Caregiver triggers remote open lid) ────────
app.post(["/api/hardware/remote-open", "/api/medicine-remote-open"], (req, res) => {
  remoteOpenFlag = true;
  medboxLidOpen = true; // immediately update lid state in server memory
  console.log("[MEDBOX] Remote lid-open request registered.");
  return res.json({ success: true, message: "Remote open lid request queued." });
});

// ── AI COMPANION (OLLAMA RASPBERRY PI) INTEGRATION ───────────────────────────
let assistantIp: string | null = null;

// POST /api/assistant/heartbeat - Raspberry Pi registers its IP address dynamically
app.post("/api/assistant/heartbeat", (req, res) => {
  const { ip, port } = req.body as { ip: string; port?: number };
  if (ip) {
    assistantIp = `http://${ip}:${port || 8080}`;
    console.log(`[ASSISTANT] Dynamic AI Companion registered at: ${assistantIp}`);
    return res.json({ status: "ok" });
  }
  return res.status(400).json({ error: "ip required" });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI DICTATOR — Local AI clinical summary (Ollama text model)
// ─────────────────────────────────────────────────────────────────────────────

// ── Local File Persistence Helpers for Robust Fallback ─────────────────────────
function saveBpmLocally(bpm: number) {
  const filePath = path.join(process.cwd(), "data", "bpm.json");
  let list: Array<{ bpm: number; timestamp: number }> = [];
  try {
    if (fs.existsSync(filePath)) {
      list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { }
  list.push({ bpm, timestamp: Math.floor(Date.now() / 1000) });
  if (list.length > 200) list.shift();
  try {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local bpm file:", err.message);
  }

  // Also permanently save to MongoDB vitals_log schema folder
  if (fireReady() && mongoDb) {
    mongoDb.collection("vitals_log").insertOne({
      type: "heart_rate",
      bpm,
      timestamp: new Date().toISOString(),
      date: new Date().toLocaleDateString("en-US")
    }).catch(err => console.error("[MongoDB] Failed to log vital:", err.message));
  }
}

function saveFallEventLocally(event: FallEventRecord) {
  const filePath = path.join(process.cwd(), "data", "fall_events.json");
  let list: FallEventRecord[] = [];
  try {
    if (fs.existsSync(filePath)) {
      list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { }
  list.unshift(event);
  if (list.length > 100) list.pop();
  try {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local fall_events file:", err.message);
  }
}

function resolveFallEventLocally(id: string) {
  const filePath = path.join(process.cwd(), "data", "fall_events.json");
  try {
    if (fs.existsSync(filePath)) {
      let list: FallEventRecord[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
      list = list.map((f) => (f.id === id ? { ...f, status: "resolved" as const, resolvedAt } : f));
      fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
    }
  } catch (err: any) {
    console.error("Failed to update local fall_events file:", err.message);
  }
}

function resolveAllFallEventsBySourceLocally(source: string) {
  const filePath = path.join(process.cwd(), "data", "fall_events.json");
  try {
    if (fs.existsSync(filePath)) {
      let list: FallEventRecord[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
      list = list.map((f) => (f.source === source && f.status === "active" ? { ...f, status: "resolved" as const, resolvedAt } : f));
      fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
    }
  } catch (err: any) {
    console.error("Failed to update local fall_events file:", err.message);
  }
}

function saveScheduleLocally(doses: DoseEntry[]) {
  const filePath = path.join(process.cwd(), "data", "schedule.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(doses, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local schedule file:", err.message);
  }
}

function saveMedicinesLocally(medicines: any[]) {
  const filePath = path.join(process.cwd(), "data", "medicines.json");
  let existing: any[] = [];
  try {
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { }
  for (const med of medicines) {
    const idx = existing.findIndex((m) => m.name.toLowerCase() === med.name.toLowerCase());
    if (idx >= 0) {
      existing[idx] = { ...existing[idx], ...med, addedAt: Date.now() };
    } else {
      existing.push({ ...med, addedAt: Date.now() });
    }
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local medicines file:", err.message);
  }
}

function deleteMedicineLocally(name: string) {
  const filePath = path.join(process.cwd(), "data", "medicines.json");
  try {
    if (fs.existsSync(filePath)) {
      let list: any[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      list = list.filter((m) => m.name.toLowerCase() !== name.toLowerCase());
      fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
    }
  } catch (err: any) {
    console.error("Failed to delete local medicine:", err.message);
  }
}

function logEventLocally(type: string, message: string, severity: string) {
  const filePath = path.join(process.cwd(), "data", "events.json");
  let list: any[] = [];
  try {
    if (fs.existsSync(filePath)) {
      list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { }
  list.unshift({ type, message, severity, timestamp: Math.floor(Date.now() / 1000) });
  if (list.length > 100) list.pop();
  try {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local events file:", err.message);
  }
}

function saveReportLocally(report: { fileName: string; summary: string; scanDate: string;[key: string]: any }) {
  const filePath = path.join(process.cwd(), "data", "reports.json");
  let list: any[] = [];
  try {
    if (fs.existsSync(filePath)) {
      list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { }
  list.unshift({ ...report, createdAt: Math.floor(Date.now() / 1000) });
  if (list.length > 50) list.pop();
  try {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local reports file:", err.message);
  }
}

/** Helper: build a rich patient data snapshot from all sources (Flask / Firebase / Local files) */
async function buildPatientSnapshot() {
  const [heartRes, medRes, eventsRes, reportsRes] = await Promise.allSettled([
    flaskGet("/api/heartrate/history?limit=120"),
    flaskGet("/api/medicines"),
    flaskGet("/api/events"),
    flaskGet("/api/reports"),
  ]);

  // Read local file fallbacks
  let localBpm: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "bpm.json");
    if (fs.existsSync(p)) localBpm = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { }

  let localMeds: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "medicines.json");
    if (fs.existsSync(p)) localMeds = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { }

  let localEvents: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "events.json");
    if (fs.existsSync(p)) localEvents = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { }

  let localReports: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "reports.json");
    if (fs.existsSync(p)) localReports = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { }

  let localFallEvents: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "fall_events.json");
    if (fs.existsSync(p)) localFallEvents = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { }

  const bpmHistory: Array<{ bpm: number; timestamp: number }> =
    heartRes.status === "fulfilled" && heartRes.value.history?.length
      ? heartRes.value.history
      : localBpm;
  const medicines: any[] =
    medRes.status === "fulfilled" && medRes.value.medicines?.length
      ? medRes.value.medicines
      : localMeds;
  const events: any[] =
    eventsRes.status === "fulfilled" && Array.isArray(eventsRes.value) && eventsRes.value.length
      ? eventsRes.value
      : localEvents;
  const reports: any[] =
    reportsRes.status === "fulfilled" && reportsRes.value.reports?.length
      ? reportsRes.value.reports
      : localReports;

  // — BPM analytics —
  const bpmVals = bpmHistory.map((b) => b.bpm || (b as any).value).filter((v) => typeof v === "number" && v > 0);
  const avgBpm = bpmVals.length ? Math.round(bpmVals.reduce((a, b) => a + b, 0) / bpmVals.length) : null;
  const maxBpm = bpmVals.length ? Math.max(...bpmVals) : null;
  const minBpm = bpmVals.length ? Math.min(...bpmVals) : null;
  const abnormalBpm = bpmVals.filter((v) => v > 100 || v < 50);

  // — Fall analytics (from Firebase and Local files) —
  let dbFalls: any[] = [];
  try {
    dbFalls = await getFallEvents(200);
  } catch {
    dbFalls = localFallEvents;
  }

  const allFalls = [
    ...(dbFalls.length ? dbFalls : localFallEvents),
    ...events.filter((e) => e.type === "fall"),
  ];

  const activeFallCount = allFalls.filter((f) => f.status === "active").length;
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const recentFalls = allFalls.filter((f) => {
    const ts = f.isoTimestamp
      ? new Date(f.isoTimestamp).getTime()
      : f.timestamp * 1000;
    return ts >= thirtyDaysAgo;
  });

  return {
    bpmHistory,
    medicines,
    events,
    reports,
    analytics: {
      avgBpm,
      maxBpm,
      minBpm,
      abnormalBpmCount: abnormalBpm.length,
      totalFalls: allFalls.length,
      activeFalls: activeFallCount,
      recentFalls30Days: recentFalls.length,
    },
  };
}

/** Helper: build the clinical summary prompt */
function buildDictatorPrompt(snap: Awaited<ReturnType<typeof buildPatientSnapshot>>): string {
  const { analytics, medicines, reports, events } = snap;

  const medLines = medicines.length
    ? medicines
      .map((m) => `${m.name}${m.dosage ? " " + m.dosage : ""}${m.times?.length ? " at " + m.times.join(", ") : ""}${m.purpose ? " (" + m.purpose + ")" : ""}`)
      .join("; ")
    : "No prescriptions found in patient records.";

  const reportLines = reports.slice(0, 3).length
    ? reports
      .slice(0, 3)
      .map((r: any) => `[${r.scanDate || "Unknown date"}] ${r.fileName}: ${(r.overview || r.summary || "").slice(0, 200)}`)
      .join("\n")
    : "No scanned reports available.";

  const recentEvents = events.slice(0, 5).map((e: any) => e.message || "").filter(Boolean).join("; ") || "No recent events.";

  const bpmSummary = analytics.avgBpm !== null
    ? `Average ${analytics.avgBpm} BPM (Max ${analytics.maxBpm}, Min ${analytics.minBpm}). ${analytics.abnormalBpmCount} abnormal readings detected.`
    : "No heart rate data available in records.";

  return `You are Mitra, a senior clinical AI assistant briefing a physician. Generate a professional, structured, doctor-oriented verbal summary of the following patient data. Be factual, concise, and use natural spoken English. Maximum 8 sentences. Do NOT use markdown, bullet points, or headers. Do NOT hallucinate — if data is missing, say so clearly.

PATIENT: Use only identity and history explicitly present in the stored records. Do not assume an age, diagnosis, or identity.

HEART RATE (last 120 readings): ${bpmSummary}

FALL EVENTS: ${analytics.recentFalls30Days} fall(s) in the last 30 days. ${analytics.activeFalls} currently active/unresolved. ${analytics.totalFalls} total recorded falls.

CURRENT MEDICATIONS: ${medLines}

RECENT LAB REPORTS:
${reportLines}

RECENT SYSTEM EVENTS: ${recentEvents}

Provide the verbal clinical briefing now. Begin with "Doctor," and end with a recommendation for the physician's attention.`;
}

// POST /api/ai-dictator/trigger — Local AI clinical summary (Ollama text model)
app.post("/api/ai-dictator/trigger", async (_req, res) => {
  try {
    if (!(await isOllamaReady())) return res.status(503).json({ error: "Local AI (Ollama) not running." });
    console.log("[DICTATOR] Compiling patient data from MongoDB...");
    const snap = await buildPatientSnapshot();
    const prompt = buildDictatorPrompt(snap);
    console.log("[DICTATOR] Sending to Ollama text model...");
    const { text: summary, model: usedModel } = await generateWithText(prompt);
    if (!summary) throw new Error("Ollama returned an empty summary.");
    console.log(`[DICTATOR] Summary via ${usedModel}: ${summary.slice(0, 120)}...`);
    return res.json({ success: true, summary, patientName: null, analytics: snap.analytics });
  } catch (err: any) {
    console.error("[DICTATOR] Summary generation failed:", err.message);
    return res.status(500).json({ error: `AI Dictator failed: ${err.message}` });
  }
});

// POST /api/ai-dictator/ask — Doctor Q&A grounded in MongoDB patient data only
app.post("/api/ai-dictator/ask", async (req, res) => {
  try {
    const { question } = req.body as { question: string };
    if (!question?.trim()) return res.status(400).json({ error: "question is required" });
    if (!(await isOllamaReady())) return res.status(503).json({ error: "Local AI (Ollama) not running." });

    const snap = await buildPatientSnapshot();
    const { analytics, medicines, reports, events } = snap;
    const medLines = medicines.length
      ? medicines.map((m: any) => `${m.name} ${m.dosage || ""} -- ${m.purpose || "purpose unknown"}`).join("; ")
      : "None on record.";
    const recentReportSummaries = reports.slice(0, 5).map((r: any) => `${r.fileName} (${r.scanDate || "?"}): ${(r.overview || r.summary || "").slice(0, 300)}`).join("\n");
    const recentEvents = events.slice(0, 10).map((e: any) => `[${e.type}] ${e.message}`).join("; ");

    const qaPrompt = `You are Mitra, a clinical AI for ElderCare. A physician is asking about the patient represented by the records below. Do not assume identity or age.
Answer ONLY from the patient data below. If unavailable, say: "Information not available in patient records." 2-4 sentences, factual, professional.

PATIENT DATA:
Heart Rate: Avg ${analytics.avgBpm ?? "N/A"} BPM, Max ${analytics.maxBpm ?? "N/A"}, Min ${analytics.minBpm ?? "N/A"}. Abnormal: ${analytics.abnormalBpmCount}.
Falls (last 30d): ${analytics.recentFalls30Days}. Total: ${analytics.totalFalls}. Active: ${analytics.activeFalls}.
Medications: ${medLines}
Recent Reports:\n${recentReportSummaries || "No reports."}
Recent Events: ${recentEvents || "None."}

QUESTION: ${question.trim()}

Answer:`;

    const { text: answer, model: usedModel } = await generateWithText(qaPrompt);
    console.log(`[DICTATOR/ASK] Answered via ${usedModel}`);
    return res.json({ success: true, answer: answer || "Information not available in patient records." });
  } catch (err: any) {
    console.error("[DICTATOR/ASK] Q&A failed:", err.message);
    return res.status(500).json({ error: `Q&A failed: ${err.message}` });
  }
});

app.post("/api/hardware/medbox-event", async (req, res) => {
  const { event, box, medicine, timestamp, deviceId, dosage } = req.body as {
    event: "DOSE_TAKEN" | "DOSE_MISSED";
    box: number;
    medicine: string;
    dosage?: string;
    timestamp: string;
    deviceId?: string;
  };

  if (!event || !box) return res.status(400).json({ error: "event and box are required" });

  // 1. Save to MongoDB medbox_events collection
  await appendMedboxEvent({ event, box, medicine, dosage, timestamp, deviceId: deviceId || "medbox-01" });

  // 2. Update matching slot in MongoDB medbox_schedule
  const schedule = await readSchedule();
  const slot = schedule.find((d) => d.boxNumber === box);
  if (slot) {
    if (event === "DOSE_TAKEN") {
      slot.taken = true;
      slot.takenAt = timestamp || new Date().toLocaleTimeString("en-US", { hour12: false });
      slot.missed = false;
    } else {
      slot.missed = true;
    }
    await writeSchedule(schedule);
  }

  // 3. If DOSE_MISSED, trigger Gmail alert
  if (event === "DOSE_MISSED") {
    sendMissedDoseAlert(
      medicine || slot?.medicine || "Unknown",
      slot?.time || timestamp,
      dosage || slot?.dosage || ""
    ).catch((e) => console.error("[MAIL] Failed to send alert:", e?.message));
  }

  // 4. Broadcast to React dashboard via SSE
  const ssePayload = {
    event,
    box,
    medicine: medicine || slot?.medicine,
    dosage: dosage || slot?.dosage,
    timestamp: timestamp || new Date().toISOString(),
    deviceId: deviceId || "medbox-01",
  };
  broadcastSSE(event === "DOSE_TAKEN" ? "medicine_taken" : "medicine_missed", ssePayload);

  // 5. Also log to Flask events collection in Atlas
  try {
    const severity = event === "DOSE_TAKEN" ? "info" : "warning";
    const msg = event === "DOSE_TAKEN"
      ? `Medication taken: ${medicine || slot?.medicine || "Unknown"} (Box ${box})`
      : `Medication missed: ${medicine || slot?.medicine || "Unknown"} (Box ${box})`;
    await flaskPost("/api/events/log", { type: "medicine", message: msg, severity });
    console.log(`[MongoDB] Medbox event logged to Atlas: ${msg}`);
  } catch (dbErr: any) {
    console.error("[WARN] Failed to log medbox event via Flask:", dbErr?.message);
  }

  console.log(`[MEDBOX] ${event} — Box ${box} (${medicine}) @ ${timestamp}`);
  return res.json({ received: true });
});

// ── POST /api/hardware/heartbeat ──────────────────────────────────────────────
app.post("/api/hardware/heartbeat", async (req, res) => {
  const { deviceId, state, presenceDetected, nextDoseTime, uptime } = req.body as {
    deviceId?: string;
    state?: string;
    presenceDetected?: boolean;
    nextDoseTime?: string;
    uptime?: number;
  };

  medboxStatus.lastSeen = new Date().toISOString();
  medboxStatus.state = state || "IDLE";
  medboxStatus.presenceDetected = presenceDetected ?? false;
  medboxStatus.nextDoseTime = nextDoseTime || await getNextDoseTime();
  medboxStatus.uptime = uptime ?? 0;
  medboxStatus.deviceId = deviceId || "medbox-01";
  medboxStatus.online = true;

  // Persist to MongoDB device_status
  if (fireReady()) {
    mongoDb!.collection("device_status").replaceOne(
      { _id: "medbox-01" as any },
      {
        ...medboxStatus,
        updatedAt: new Date().toISOString()
      },
      { upsert: true }
    ).catch(() => { });
  }

  broadcastSSE("medbox_heartbeat", medboxStatus);
  return res.json({ status: "ok", nextDose: medboxStatus.nextDoseTime });
});

// ── GET /api/medbox-status  (dashboard polling fallback) ─────────────────────
app.get("/api/medbox-status", (_req, res) => {
  return res.json(medboxStatus);
});

// ── Hardware Simulation Mode (MongoDB-backed) ─────────────────────────────────
if (process.env.VITE_HARDWARE_MODE === "simulated") {
  console.log("[SIM] Hardware simulation mode active — firing fake medbox events");

  const simStates: MedboxStatusRecord["state"][] = ["IDLE", "REMINDER", "DISPENSING", "CONFIRMED"];
  let simStateIdx = 0;

  // Simulated heartbeat every 10 s
  setInterval(async () => {
    medboxStatus.lastSeen = new Date().toISOString();
    medboxStatus.state = simStates[simStateIdx % simStates.length];
    medboxStatus.online = true;
    medboxStatus.presenceDetected = Math.random() > 0.5;
    medboxStatus.nextDoseTime = await getNextDoseTime();
    medboxStatus.uptime = (medboxStatus.uptime || 0) + 10;
    simStateIdx++;
    if (fireReady()) {
      mongoDb!.collection("device_status").replaceOne(
        { _id: "medbox-01-sim" as any },
        { ...medboxStatus, updatedAt: new Date().toISOString() },
        { upsert: true }
      ).catch(() => { });
    }
    broadcastSSE("medbox_heartbeat", medboxStatus);
  }, 10_000);

  // Simulated DOSE_TAKEN / DOSE_MISSED every 3–8 minutes
  const fireRandomEvent = async () => {
    const schedule = await readSchedule();
    const pending = schedule.filter((d) => !d.taken && !d.missed);
    if (pending.length > 0) {
      const dose = pending[Math.floor(Math.random() * pending.length)];
      const eventType = Math.random() > 0.2 ? "DOSE_TAKEN" : "DOSE_MISSED";
      const payload = {
        event: eventType,
        box: dose.boxNumber,
        medicine: dose.medicine,
        dosage: dose.dosage,
        timestamp: new Date().toLocaleTimeString("en-US", { hour12: false }),
        deviceId: "medbox-01-sim",
      };

      // Persist to Firestore
      await appendMedboxEvent(payload);
      if (eventType === "DOSE_TAKEN") {
        dose.taken = true;
        dose.takenAt = payload.timestamp;
      } else {
        dose.missed = true;
      }
      await writeSchedule(schedule);
      broadcastSSE(eventType === "DOSE_TAKEN" ? "medicine_taken" : "medicine_missed", payload);
      console.log(`[SIM] ${eventType} — Box ${dose.boxNumber} (${dose.medicine})`);
    }

    const nextMs = (Math.random() * 5 + 3) * 60_000;
    setTimeout(fireRandomEvent, nextMs);
  };

  // First sim event after 30 seconds
  setTimeout(fireRandomEvent, 30_000);
}

// ═════════════════════════════════════════════════════════════════════════════
// RX PIPELINE — Prescription OCR + Extraction + Human-Gated ESP32 Confirm
// ═════════════════════════════════════════════════════════════════════════════

// ── ESP32 config ──────────────────────────────────────────────────────────────
const ESP32_BASE_URL = (process.env.ESP32_BASE_URL || "").replace(/\/$/, "");

// ─── Resilient in-memory fallback store for offline/local development ─────────
const inMemoryPrescriptions: any[] = [];
let inMemoryPendingChanges: any[] = [];
const inMemoryScheduleCache: any[] = [];

// prescriptions — raw OCR + parsed result per upload
async function savePrescription(doc: object): Promise<string> {
  const item = {
    ...doc,
    uploadedAt: new Date().toISOString()
  };
  if (fireReady()) {
    try {
      const res = await mongoDb!.collection("prescriptions").insertOne(item);
      const id = res.insertedId.toString();
      inMemoryPrescriptions.unshift({ id, ...item });
      return id;
    } catch (err: any) {
      console.warn("[RX] Mongo savePrescription failed, storing in memory:", err.message);
    }
  }
  const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  inMemoryPrescriptions.unshift({ id, ...item });
  return id;
}

async function getPrescriptions(limit = 20): Promise<any[]> {
  let list: any[] = [];
  if (fireReady()) {
    try {
      const docs = await mongoDb!.collection("prescriptions").find({}).sort({ uploadedAt: -1 }).limit(limit * 3).toArray();
      list = docs.map((d: any) => {
        const { _id, ...rest } = d;
        return { id: _id.toString(), ...rest, _rawId: _id };
      });
    } catch { }
  }
  if (list.length === 0) {
    list = inMemoryPrescriptions.map(p => ({ ...p }));
  }

  // Deduplication: ensure only 1 history record per prescription unless changed
  const seen = new Map<string, any>();
  const duplicateIdsToDelete: any[] = [];

  for (const item of list) {
    const rxNo = item.prescriptionNumber ? item.prescriptionNumber.toLowerCase().trim() : null;
    const medFp = getMedsFingerprint(item.extractedMeds || []);
    const key = rxNo ? `rx:${rxNo}` : `${(item.fileName || "unnamed").toLowerCase()}:${medFp}`;

    if (!seen.has(key)) {
      seen.set(key, item);
    } else {
      const existing = seen.get(key);
      if (existing.status !== "applied" && item.status === "applied") {
        if (existing._rawId) duplicateIdsToDelete.push(existing._rawId);
        seen.set(key, item);
      } else {
        if (item._rawId) duplicateIdsToDelete.push(item._rawId);
      }
    }
  }

  if (fireReady() && duplicateIdsToDelete.length > 0) {
    mongoDb!.collection("prescriptions").deleteMany({ _id: { $in: duplicateIdsToDelete } }).catch(() => { });
  }

  if (duplicateIdsToDelete.length > 0) {
    const idSet = new Set(duplicateIdsToDelete.map(x => x.toString()));
    for (let i = inMemoryPrescriptions.length - 1; i >= 0; i--) {
      if (idSet.has(inMemoryPrescriptions[i].id)) {
        inMemoryPrescriptions.splice(i, 1);
      }
    }
  }

  return Array.from(seen.values()).slice(0, limit).map(({ _rawId, ...rest }) => rest);
}

async function updatePrescription(id: string, fields: object): Promise<void> {
  const p = inMemoryPrescriptions.find(x => x.id === id);
  if (p) Object.assign(p, fields);
  if (!fireReady()) return;
  try {
    const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id as any };
    await mongoDb!.collection("prescriptions").updateOne(filter, { $set: fields });
  } catch (err: any) {
    console.warn("[RX] updatePrescription failed:", err.message);
  }
}

async function updatePrescriptionStatus(id: string, status: string): Promise<void> {
  const p = inMemoryPrescriptions.find(x => x.id === id);
  if (p) p.status = status;
  if (!fireReady() || !id) return;
  try {
    const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id as any };
    await mongoDb!.collection("prescriptions").updateOne(
      filter,
      { $set: { status } }
    );
  } catch { }
}

// pending_changes — one row per proposed compartment change
async function savePendingChange(doc: object): Promise<string> {
  const item = {
    ...doc,
    createdAt: new Date().toISOString(),
    status: "pending"
  };
  if (fireReady()) {
    try {
      const res = await mongoDb!.collection("pending_changes").insertOne(item);
      const id = res.insertedId.toString();
      inMemoryPendingChanges.unshift({ id, ...item });
      return id;
    } catch (err: any) {
      console.warn("[RX] Mongo savePendingChange failed, storing in memory:", err.message);
    }
  }
  const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  inMemoryPendingChanges.unshift({ id, ...item });
  return id;
}

async function getPendingChanges(statusFilter?: string): Promise<any[]> {
  if (fireReady()) {
    try {
      const query: any = {};
      if (statusFilter) query.status = statusFilter;
      const docs = await mongoDb!.collection("pending_changes").find(query).sort({ createdAt: -1 }).toArray();
      return docs.map((d: any) => {
        const { _id, ...rest } = d;
        return { id: _id.toString(), ...rest };
      });
    } catch { }
  }
  return statusFilter ? inMemoryPendingChanges.filter(x => x.status === statusFilter) : [...inMemoryPendingChanges];
}

async function updatePendingChange(id: string, fields: object): Promise<void> {
  const pc = inMemoryPendingChanges.find(x => x.id === id);
  if (pc) Object.assign(pc, fields);
  if (!fireReady() || !id) return;
  try {
    const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id as any };
    await mongoDb!.collection("pending_changes").updateOne(
      filter,
      { $set: fields }
    );
  } catch { }
}

async function getPendingChangeById(id: string): Promise<any | null> {
  if (fireReady() && id) {
    try {
      const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id as any };
      const doc = await mongoDb!.collection("pending_changes").findOne(filter);
      if (doc) {
        const { _id, ...rest } = doc;
        return { id: _id.toString(), ...rest };
      }
    } catch { }
  }
  return inMemoryPendingChanges.find(x => x.id === id) || null;
}

// dose_events — history/adherence log, built from polling givenToday
async function appendDoseEvent(doc: object): Promise<void> {
  if (!fireReady()) return;
  try {
    await mongoDb!.collection("dose_events").insertOne({
      ...doc,
      loggedAt: new Date().toISOString()
    });
  } catch { }
}

async function getDoseEvents(limit = 100): Promise<any[]> {
  if (!fireReady()) return [];
  try {
    const docs = await mongoDb!.collection("dose_events").find({}).sort({ loggedAt: -1 }).limit(limit).toArray();
    return docs.map((d: any) => {
      const { _id, ...rest } = d;
      return { id: _id.toString(), ...rest };
    });
  } catch { return []; }
}

// schedule_cache — last known ESP32 schedule state (refreshed each poll)
async function readScheduleCache(): Promise<any[]> {
  if (fireReady()) {
    try {
      const docs = await mongoDb!.collection("schedule_cache").find({}).sort({ compartment: 1 }).toArray();
      return docs.map((d: any) => {
        const { _id, ...rest } = d;
        return { id: _id.toString(), ...rest };
      });
    } catch { }
  }
  return [...inMemoryScheduleCache];
}

async function writeScheduleCache(entries: any[]): Promise<void> {
  inMemoryScheduleCache.length = 0;
  inMemoryScheduleCache.push(...entries);
  if (!fireReady()) return;
  try {
    const col = mongoDb!.collection("schedule_cache");
    await col.deleteMany({});
    if (entries.length > 0) {
      const docs = entries.map(e => ({ ...e, updatedAt: new Date().toISOString() }));
      await col.insertMany(docs);
    }
  } catch (err: any) {
    console.error("[RX] writeScheduleCache failed:", err.message);
  }
}

// ─── ESP32 schedule polling ───────────────────────────────────────────────────
// Polls GET {ESP32_BASE_URL}/api/schedule every 15 seconds.
// Diffs givenToday flags against schedule_cache.
// Writes dose_events for "taken" (true→true for first time) or "missed" (time window passed, still false).

interface Esp32DoseEntry {
  hour: number;
  minute: number;
  compartment: number;
  label: string;
  givenToday: boolean;
}

// In-memory cache of last known ESP32 state (keyed by compartment)
const esp32LastKnown = new Map<number, Esp32DoseEntry>();

// Track ESP32 connectivity to avoid log spam
let esp32OfflineSince: number | null = null;
const ESP32_LOG_COOLDOWN_MS = 60_000; // only log once per minute when offline

async function pollEsp32Schedule(): Promise<void> {
  if (!ESP32_BASE_URL) return; // not configured


  try {
    const res = await fetch(`${ESP32_BASE_URL}/api/schedule`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = await res.json() as { schedule: Esp32DoseEntry[] };
    const schedule: Esp32DoseEntry[] = Array.isArray(data.schedule) ? data.schedule : [];
    if (schedule.length === 0) return;

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    for (const dose of schedule) {
      const key = dose.compartment;
      const prev = esp32LastKnown.get(key);

      // givenToday flipped false → true: dose was taken
      if (prev && !prev.givenToday && dose.givenToday) {
        console.log(`[RX POLL] Dose TAKEN — compartment ${key} (${dose.label})`);
        await appendDoseEvent({
          compartment: key,
          label: dose.label,
          scheduledTime: `${String(dose.hour).padStart(2, "0")}:${String(dose.minute).padStart(2, "0")}`,
          takenAt: now.toISOString(),
          status: "taken",
        });
        broadcastSSE("dose_event", { compartment: key, label: dose.label, status: "taken", takenAt: now.toISOString() });
      }

      // Time window 30 min past + still not given: mark missed (only once)
      if (!dose.givenToday && prev && !prev.givenToday) {
        const doseMin = dose.hour * 60 + dose.minute;
        const minutesLate = nowMin - doseMin;
        if (minutesLate > 30 && minutesLate < 31) {
          // Only fire in the 30th-31st minute window so we don't repeat
          console.log(`[RX POLL] Dose MISSED — compartment ${key} (${dose.label})`);
          await appendDoseEvent({
            compartment: key,
            label: dose.label,
            scheduledTime: `${String(dose.hour).padStart(2, "0")}:${String(dose.minute).padStart(2, "0")}`,
            takenAt: null,
            status: "missed",
          });
          broadcastSSE("dose_event", { compartment: key, label: dose.label, status: "missed", takenAt: null });
          // Also send missed-dose Gmail alert
          sendMissedDoseAlert(dose.label, `${dose.hour}:${String(dose.minute).padStart(2, "0")}`, "").catch(() => { });
        }
      }

      // Update in-memory + Firestore cache
      esp32LastKnown.set(key, { ...dose });
    }

    // Persist cache to Firestore
    await writeScheduleCache(schedule.map(d => ({
      compartment: d.compartment,
      label: d.label,
      hour: d.hour,
      minute: d.minute,
      givenToday: d.givenToday,
    })));

  } catch (err: any) {
    // ESP32 offline / unreachable
    const now = Date.now();
    if (esp32OfflineSince === null) {
      // First failure — log it once
      esp32OfflineSince = now;
      console.warn("[RX POLL] ESP32 went offline:", err.message);
    } else if (now - esp32OfflineSince >= ESP32_LOG_COOLDOWN_MS) {
      // Still offline — log once per minute only
      console.warn("[RX POLL] ESP32 still unreachable (retrying silently)");
      esp32OfflineSince = now; // reset cooldown
    }
    // else: silent — suppress repeated messages
  }
}

// Start polling after 5s (give MongoDB time to connect)
if (ESP32_BASE_URL) {
  setTimeout(() => {
    pollEsp32Schedule();
    setInterval(pollEsp32Schedule, 30_000); // 30s — less noise on unstable WiFi
    console.log(`[RX] ESP32 polling started -> ${ESP32_BASE_URL}/api/schedule every 30s`);
  }, 5_000);
} else {
  console.warn("[RX] ESP32_BASE_URL not set - dose polling disabled. Set it in .env to enable.");
}

// ─── GET /api/esp32/schedule — proxy the live ESP32 schedule ─────────────────
app.get("/api/esp32/schedule", async (_req, res) => {
  if (!ESP32_BASE_URL) {
    // Return cached state from Firestore if available
    const cached = await readScheduleCache();
    return res.json({ schedule: cached, source: "cache" });
  }
  try {
    const r = await fetch(`${ESP32_BASE_URL}/api/schedule`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`ESP32 returned ${r.status}`);
    const data = await r.json();
    return res.json({ ...data, source: "live" });
  } catch {
    const cached = await readScheduleCache();
    return res.json({ schedule: cached, source: "cache" });
  }
});

// ─── GET /api/dose-events — adherence history ─────────────────────────────────
app.get("/api/dose-events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const events = await getDoseEvents(limit);
  return res.json({ events });
});

// ─── GET /api/bpm/history — proxy BPM/SpO2 history from bpm-server (port 3001) ──
app.get("/api/bpm/history", async (req, res) => {
  try {
    const n = req.query.n || 60;
    const r = await fetch(`http://localhost:3001/api/bpm/history?n=${n}`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const data = await r.json();
      return res.json(data);
    }
  } catch { }
  return res.json({ history: [], stats: {} });
});

// ═════════════════════════════════════════════════════════════════════════════
// RX UPLOAD — Prescription OCR + Local AI Vision Extraction
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/rx/upload — upload prescription image or text, extract medicines, generate pending_changes
app.post("/api/rx/upload", async (req, res) => {
  try {
    const { fileData, mimeType, fileName, promptText } = req.body as {
      fileData?: string;
      mimeType?: string;
      fileName?: string;
      promptText?: string;
    };

    if (!fileData && !promptText) return res.status(400).json({ error: "fileData (base64) or promptText is required" });

    console.log(`[RX] Processing prescription upload: ${fileName || "unnamed"}`);

    if (!(await isOllamaReady())) {
      return res.status(503).json({
        error: "Local AI vision service (Ollama) is not running. Please start Ollama.",
      });
    }

    let extractedMeds: any[] = [];
    let ocrText = "";
    let usedModel = "";
    let parsedResult: any = null;

    if (promptText && (!fileData || fileData.length < 500)) {
      console.log("[RX] Extracting medicines from text prompt via Ollama LLM...");
      const textPrompt = `You are an expert clinical prescription digitizer.
Analyze this medical prescription text carefully:
"${promptText}"

EXTRACT ONLY PRESCRIBED MEDICINES AND DRUGS.
Return ONLY a valid JSON object matching this exact schema:
{
  "medicines": [
    {
      "name": "Medicine Name",
      "dosage": "500mg",
      "frequency": "twice daily",
      "suggestedTime": null,
      "confidence": "high",
      "purpose": "instructions or indication"
    }
  ]
}

Rules:
- name: Exact medicine name (required)
- dosage: Strength and unit if present, or null
- frequency: Schedule if present, or null
- suggestedTime: extract the exact time of dose ONLY if explicitly written in the text (e.g. "08:00", "8:30 AM", "14:00", "9:00 PM"). If NO specific clock time is mentioned, return null. DO NOT guess, invent, or default any time.
- confidence: "high"
- purpose: Directions or indications
`;
      const resText = await generateWithText(textPrompt);
      ocrText = resText.text;
      usedModel = resText.model;
      try {
        parsedResult = JSON.parse(ocrText);
        extractedMeds = sanitizeRxMeds(parsedResult);
      } catch {
        extractedMeds = sanitizeRxMeds(ocrText);
      }
    } else if (fileData) {
      // -- Step 1a: Decode + quality gate + TF.js preprocess
      let cleanBase64 = fileData;
      if (cleanBase64.includes(",")) cleanBase64 = cleanBase64.split(",")[1];
      let imageBuffer = Buffer.from(cleanBase64, "base64");
      const isPdf = (mimeType || "").toLowerCase().includes("pdf") || (fileName || "").toLowerCase().endsWith(".pdf");
      if (isPdf) {
        console.log("[RX] PDF detected -- rasterising first page...");
        try {
          imageBuffer = await pdfFirstPageToPng(imageBuffer);
        } catch (pdfErr: any) {
          console.warn("[RX] PDF rasterisation failed:", pdfErr.message);
        }
      }

      try {
        const quality = await checkImageQuality(imageBuffer);
        if (!quality.pass) {
          console.warn("[RX] Image quality warning:", quality.reason);
        }
      } catch (qErr: any) {
        console.warn("[RX] Quality check skipped:", qErr.message);
      }

      let processedBase64 = cleanBase64;
      try {
        const prep = await preprocessImage(imageBuffer);
        if (prep?.base64) {
          processedBase64 = prep.base64;
        }
      } catch (prepErr: any) {
        console.warn("[RX] Preprocessing fallback to raw base64:", prepErr.message);
      }

      try {
        console.log("[RX] Using local Ollama vision extraction...");
        const { raw, parsed, model: mdl } = await extractWithVision(processedBase64, RX_EXTRACTION_PROMPT);
        ocrText = raw;
        usedModel = mdl;
        parsedResult = parsed;
        extractedMeds = sanitizeRxMeds(parsed);
        if (extractedMeds.length === 0 && raw) {
          try {
            parsedResult = JSON.parse(raw);
            extractedMeds = sanitizeRxMeds(parsedResult);
          } catch { }
        }
      } catch (ollamaErr: any) {
        console.error("[RX] Ollama extraction error:", ollamaErr.message);
        return res.status(422).json({
          error: `Extraction failed: ${ollamaErr.message}. Please try again with a clearer image.`,
          ocrText,
        });
      }
    }

    console.log(`[RX] Extracted ${extractedMeds.length} medicines via ${usedModel}`);

    const rxNumber = extractRxNumber(parsedResult, ocrText);
    if (rxNumber) {
      console.log(`[RX] Detected prescription number: ${rxNumber}`);
    }

    const newFingerprint = getMedsFingerprint(extractedMeds);

    // -- Step 2: Check for existing prescription to avoid duplicate history records
    const existingList = await getPrescriptions(100);
    const existingMatch = existingList.find(p => {
      if (rxNumber && p.prescriptionNumber && p.prescriptionNumber.toLowerCase().trim() === rxNumber.toLowerCase().trim()) {
        return true;
      }
      const pFingerprint = getMedsFingerprint(p.extractedMeds || []);
      const sameMeds = pFingerprint.length > 0 && pFingerprint === newFingerprint;
      const sameFile = fileName && p.fileName && p.fileName.toLowerCase().trim() === fileName.toLowerCase().trim();
      return sameMeds || (sameFile && sameMeds);
    });

    let prescriptionId: string;
    let isDuplicateUnchanged = false;

    if (existingMatch) {
      const existingFingerprint = getMedsFingerprint(existingMatch.extractedMeds || []);
      const isSpecificChange = existingFingerprint !== newFingerprint;

      if (!isSpecificChange) {
        // Prescription is UNCHANGED — avoid creating duplicate history record!
        prescriptionId = existingMatch.id;
        isDuplicateUnchanged = true;
        console.log(`[RX] Prescription "${existingMatch.fileName}" (Rx #${rxNumber || existingMatch.prescriptionNumber || 'N/A'}) already exists and is unchanged. Preserving single history record.`);
      } else {
        // A specific change is seen — update existing prescription record
        prescriptionId = existingMatch.id;
        await updatePrescription(existingMatch.id, {
          fileName: fileName || existingMatch.fileName,
          ocrText,
          extractedMeds,
          prescriptionNumber: rxNumber || existingMatch.prescriptionNumber || null,
          status: "pending_review",
          uploadedAt: new Date().toISOString()
        });
        console.log(`[RX] Specific change detected in prescription "${existingMatch.fileName}". Updated record ${prescriptionId}.`);
      }
    } else {
      // New prescription — save to MongoDB
      prescriptionId = await savePrescription({
        fileName: fileName || "unnamed",
        ocrText,
        extractedMeds,
        prescriptionNumber: rxNumber,
        llmModel: usedModel || "ollama-vision",
        status: "pending_review",
      });
      console.log(`[RX] Saved new prescription record: ${prescriptionId} (Rx #${rxNumber || 'none'})`);
    }

    // -- Step 3: Diff vs. ESP32 schedule cache & create reviewable slot changes
    const cacheEntries = await readScheduleCache();
    const pendingChanges: any[] = [];
    for (let i = 0; i < Math.min(extractedMeds.length, 4); i++) {
      const med = extractedMeds[i];
      const cacheEntry = cacheEntries.find(c => c.compartment === i) || null;
      const currentLabel = cacheEntry ? cacheEntry.label : "(empty)";
      let propH: number | null = null;
      let propM: number | null = null;
      if (med.suggestedTime && med.suggestedTime.includes(":")) {
        const timeParts = med.suggestedTime.split(":");
        propH = parseInt(timeParts[0], 10);
        propM = parseInt(timeParts[1], 10);
        if (isNaN(propH)) propH = null;
        if (isNaN(propM)) propM = null;
      }
      const proposedLabel = med.dosage ? `${med.name} - ${med.dosage}` : med.name;

      const changeDoc = {
        prescriptionId,
        compartment: i,
        currentLabel,
        proposedLabel,
        proposedHour: propH,
        proposedMinute: propM,
        extractedMed: med,
        reloadConfirmed: false,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };
      const changeId = await savePendingChange(changeDoc);
      pendingChanges.push({ id: changeId, ...changeDoc, confidence: med.confidence });
    }

    broadcastSSE("rx_upload_done", { prescriptionId, extractedMeds, pendingChanges, isDuplicateUnchanged: false, prescriptionNumber: rxNumber });
    logEventLocally("rx", `Prescription uploaded -- ${extractedMeds.length} medicines extracted, ${pendingChanges.length} changes pending`, "info");
    return res.json({
      success: true,
      prescriptionId,
      prescriptionNumber: rxNumber || existingMatch?.prescriptionNumber || null,
      extractedMeds,
      pendingChanges,
      isDuplicateUnchanged: false,
      ocrText
    });

  } catch (err: any) {
    console.error("[RX] Upload error:", err.message);
    return res.status(500).json({ error: err.message || "Internal error during prescription processing" });
  }
});

// ─── GET /api/rx/prescriptions ──────────────────────────────────────────────────────────────
app.get("/api/rx/prescriptions", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const prescriptions = await getPrescriptions(limit);
  return res.json({ prescriptions });
});

// ─── GET /api/rx/pending ─────────────────────────────────────────────────────
app.get("/api/rx/pending", async (_req, res) => {
  const pending = await getPendingChanges("pending");
  return res.json({ pending, count: pending.length });
});

// ─── POST /api/rx/reassign-override ──────────────────────────────────────────
// Caregiver explicitly requests slot assignment/reassignment when schedule was unchanged
app.post("/api/rx/reassign-override", async (req, res) => {
  try {
    const { prescriptionId, meds } = req.body as { prescriptionId?: string; meds: any[] };
    if (!Array.isArray(meds) || meds.length === 0) {
      return res.status(400).json({ error: "No medicines provided for override" });
    }

    const cacheEntries = await readScheduleCache();
    const createdChanges: any[] = [];

    for (let i = 0; i < Math.min(meds.length, 3); i++) {
      const med = meds[i];
      const cacheEntry = cacheEntries.find(c => c.compartment === i) || null;
      const currentLabel = cacheEntry ? cacheEntry.label : "(empty)";
      let propH: number | null = null;
      let propM: number | null = null;
      if (med.suggestedTime && med.suggestedTime.includes(":")) {
        const timeParts = med.suggestedTime.split(":");
        propH = parseInt(timeParts[0], 10);
        propM = parseInt(timeParts[1], 10);
        if (isNaN(propH)) propH = null;
        if (isNaN(propM)) propM = null;
      }
      const proposedLabel = med.dosage ? `${med.name} - ${med.dosage}` : med.name;

      const changeDoc = {
        prescriptionId: prescriptionId || `rx-override-${Date.now()}`,
        compartment: i,
        currentLabel,
        proposedLabel,
        proposedHour: propH,
        proposedMinute: propM,
        extractedMed: med,
        reloadConfirmed: false,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };

      const changeId = await savePendingChange(changeDoc);
      createdChanges.push({ id: changeId, ...changeDoc, confidence: med.confidence || "high" });
    }

    broadcastSSE("rx_pending_changes", { pendingChanges: createdChanges });
    return res.json({ success: true, pendingChanges: createdChanges });
  } catch (err: any) {
    console.error("[RX OVERRIDE] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rx/confirm/:changeId ──────────────────────────────────────────
// THIS IS THE ONLY ENDPOINT IN THE ENTIRE CODEBASE THAT WRITES TO THE ESP32 SCHEDULE.
// Requires reloadConfirmed=true in body (server-side validated — not just UI gating).
app.post("/api/rx/confirm/:changeId", async (req, res) => {
  const { changeId } = req.params;
  const {
    reloadConfirmed,
    confirmedBy,
    compartment,
    customHour,
    customMinute,
    customTime,
    timeoutMinutes,
    proposedLabel,
    extractedMed,
    prescriptionId,
    currentLabel
  } = req.body as {
    reloadConfirmed: boolean;
    confirmedBy?: string;
    compartment?: number;
    customHour?: number;
    customMinute?: number;
    customTime?: string; // e.g. "01:35"
    timeoutMinutes?: number;
    proposedLabel?: string;
    extractedMed?: any;
    prescriptionId?: string;
    currentLabel?: string;
  };

  // ── Hard guard: server-side reload confirmation check ─────────────────────
  if (!reloadConfirmed) {
    return res.status(400).json({
      error: "reloadConfirmed must be true. Confirm you have physically reloaded the compartment before proceeding.",
    });
  }

  let change = await getPendingChangeById(changeId);

  // If change not found in MongoDB / memory, check if this is an override or client-supplied change
  if (!change) {
    if (proposedLabel || (extractedMed && extractedMed.name) || (req.body as any).label) {
      const label = proposedLabel || (req.body as any).label || (extractedMed?.dosage ? `${extractedMed.name} - ${extractedMed.dosage}` : extractedMed?.name);
      const timeParts = (customTime || (extractedMed && extractedMed.suggestedTime) || "08:00").split(":");
      const pHour = customHour !== undefined ? Number(customHour) : (parseInt(timeParts[0], 10) || 8);
      const pMin = customMinute !== undefined ? Number(customMinute) : (parseInt(timeParts[1], 10) || 0);
      const comp = compartment !== undefined ? Number(compartment) : 0;

      change = {
        id: changeId,
        prescriptionId: prescriptionId || "override-reassign",
        compartment: comp,
        currentLabel: currentLabel || "(empty)",
        proposedLabel: label,
        proposedHour: pHour,
        proposedMinute: pMin,
        extractedMed: extractedMed || { name: label, dosage: "", frequency: "1x a day", confidence: "high" },
        status: "pending",
        reloadConfirmed: true,
        createdAt: new Date().toISOString()
      };
      try {
        await savePendingChange(change);
      } catch (err: any) {
        console.warn("[RX CONFIRM] Failed saving override pending change:", err.message);
      }
    } else {
      return res.status(404).json({ error: "Pending change not found" });
    }
  }

  if (change.status === "confirmed") {
    return res.json({ success: true, message: "Change is already confirmed" });
  }

  // Parse custom time if provided
  let targetHour = Number(change.proposedHour);
  let targetMinute = Number(change.proposedMinute);

  if (customTime && typeof customTime === "string" && customTime.includes(":")) {
    const [h, m] = customTime.split(":").map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      targetHour = h;
      targetMinute = m;
    }
  } else {
    if (customHour !== undefined && !isNaN(Number(customHour))) targetHour = Number(customHour);
    if (customMinute !== undefined && !isNaN(Number(customMinute))) targetMinute = Number(customMinute);
  }

  // ── Step 1: Fetch the current live ESP32 schedule (with cache fallback if offline) ──
  let esp32Schedule: Esp32DoseEntry[] = [];

  if (ESP32_BASE_URL) {
    try {
      const r = await fetch(`${ESP32_BASE_URL}/api/schedule`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const data = await r.json();
        esp32Schedule = Array.isArray(data.schedule) ? data.schedule : [];
      } else {
        throw new Error(`ESP32 returned status ${r.status}`);
      }
    } catch (err: any) {
      console.warn("[RX CONFIRM] ESP32 unreachable for read, falling back to database cache:", err.message);
      const cached = await readScheduleCache();
      esp32Schedule = cached.map(c => {
        let comp = c.compartment !== undefined ? Number(c.compartment) : (c.boxNumber ? Number(c.boxNumber) - 1 : 0);
        let h = c.hour !== undefined ? Number(c.hour) : 8;
        let m = c.minute !== undefined ? Number(c.minute) : 0;
        if (c.time && typeof c.time === "string" && c.time.includes(":")) {
          const [th, tm] = c.time.split(":").map(Number);
          if (!isNaN(th)) h = th;
          if (!isNaN(tm)) m = tm;
        }
        return {
          compartment: comp,
          hour: h,
          minute: m,
          label: c.label || c.medicine || `Medicine ${comp + 1}`,
          givenToday: Boolean(c.givenToday || c.taken),
        };
      });
    }
  } else {
    // No ESP32 configured — build from cache
    const cached = await readScheduleCache();
    esp32Schedule = cached.map(c => {
      let comp = c.compartment !== undefined ? Number(c.compartment) : (c.boxNumber ? Number(c.boxNumber) - 1 : 0);
      let h = c.hour !== undefined ? Number(c.hour) : 8;
      let m = c.minute !== undefined ? Number(c.minute) : 0;
      if (c.time && typeof c.time === "string" && c.time.includes(":")) {
        const [th, tm] = c.time.split(":").map(Number);
        if (!isNaN(th)) h = th;
        if (!isNaN(tm)) m = tm;
      }
      return {
        compartment: comp,
        hour: h,
        minute: m,
        label: c.label || c.medicine || `Medicine ${comp + 1}`,
        givenToday: Boolean(c.givenToday || c.taken),
      };
    });
  }

  // ── Step 2: Merge the confirmed change into the schedule ──────────────────
  // Only the target compartment changes; all others are preserved and strictly deduplicated.
  const comp = compartment !== undefined ? Number(compartment) : Number(change.compartment);
  const scheduleMap = new Map<number, Esp32DoseEntry>();
  for (const item of esp32Schedule) {
    const cIdx = Number(item.compartment);
    if (!isNaN(cIdx)) {
      scheduleMap.set(cIdx, { ...item, compartment: cIdx });
    }
  }
  scheduleMap.set(comp, {
    compartment: comp,
    label: change.proposedLabel,
    hour: targetHour,
    minute: targetMinute,
    givenToday: false,
  });

  const merged: Esp32DoseEntry[] = Array.from(scheduleMap.values()).sort((a, b) => a.compartment - b.compartment);

  // ── Step 3: POST to ESP32 (single write point, warning on offline) ────────
  if (ESP32_BASE_URL) {
    try {
      const postRes = await fetch(`${ESP32_BASE_URL}/api/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule: merged }),
        signal: AbortSignal.timeout(6000),
      });
      if (postRes.ok) {
        console.log(`[RX CONFIRM] ✅ Schedule pushed to ESP32 — compartment ${comp}: "${change.proposedLabel}" at ${String(targetHour).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")}`);
      } else {
        console.warn(`[RX CONFIRM] ESP32 rejected schedule update (${postRes.status}), saved to database cache only.`);
      }
    } catch (err: any) {
      console.warn("[RX CONFIRM] Could not reach ESP32 to push schedule, saved to database cache only:", err.message);
    }
  } else {
    console.warn("[RX CONFIRM] ESP32_BASE_URL not set — skipping physical push, updating cache only");
  }

  // ── Step 3b: Open assigned lid and glow assigned compartment light on ESP32 ──
  const formattedTime = `${String(targetHour).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")}`;

  pendingCompartmentAssign = {
    compartment: comp,
    label: change.proposedLabel,
    time: formattedTime,
    timestamp: Date.now()
  };

  if (ESP32_BASE_URL) {
    try {
      console.log(`[RX CONFIRM] 🔓 Triggering assigned lid open & LED glow for compartment ${comp}...`);
      const assignRes = await fetch(`${ESP32_BASE_URL}/api/compartment/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compartment: comp,
          label: change.proposedLabel,
          time: formattedTime
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (assignRes.ok) {
        console.log(`[RX CONFIRM] ✅ Compartment ${comp} opened and LED glowing on ESP32 for reload.`);
      }
    } catch (assignErr: any) {
      console.warn(`[RX CONFIRM] Direct ESP32 assign trigger failed (${assignErr.message}); queued for next heartbeat.`);
    }
  }

  broadcastSSE("slot_assigned", { compartment: comp, label: change.proposedLabel, time: formattedTime });

  // ── Step 4: Update Firestore records ─────────────────────────────────────
  const confirmedAt = new Date().toISOString();
  await updatePendingChange(changeId, {
    status: "confirmed",
    confirmedAt,
    confirmedBy: confirmedBy || "caregiver",
    reloadConfirmed: true,
  });

  // Mark parent prescription "applied" if all its changes are confirmed/rejected
  const sibling = await getPendingChanges();
  const sameRx = sibling.filter(c => c.prescriptionId === change.prescriptionId);
  const allDone = sameRx.every(c => c.id === changeId || c.status === "confirmed" || c.status === "rejected");
  if (allDone) await updatePrescriptionStatus(change.prescriptionId, "applied");

  // Update cache with the new confirmed state
  await writeScheduleCache(merged.map(d => ({
    compartment: d.compartment,
    label: d.label,
    hour: d.hour,
    minute: d.minute,
    givenToday: d.givenToday,
  })));

  // ── Step 5: Save/Upsert confirmed schedule to medbox_schedule & medicines MongoDB collections ──
  try {
    // 1. Update medbox_schedule
    const currentSchedule = await readSchedule();
    const formattedTime = `${String(targetHour).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")}`;
    const parsedTimeout = Math.min(10, Math.max(1, Number(timeoutMinutes) || Number(change.timeoutMinutes) || 5));
    const newDose: DoseEntry = {
      boxNumber: comp + 1, // 1-based index (0 -> 1, 1 -> 2, etc.)
      medicine: change.extractedMed?.name || change.proposedLabel.split(" - ")[0],
      dosage: change.extractedMed?.dosage || "",
      time: formattedTime,
      taken: false,
      missed: false,
      timeoutMinutes: parsedTimeout,
    };
    const updatedSchedule = currentSchedule.filter(d => d.boxNumber !== newDose.boxNumber);
    if (change.proposedLabel && change.proposedLabel !== "(empty)") {
      updatedSchedule.push(newDose);
    }
    await writeSchedule(updatedSchedule);
    saveScheduleLocally(updatedSchedule);
    broadcastSSE("schedule_updated", { doses: updatedSchedule });
    broadcastSSE("medicine_schedule_updated", {
      slots: updatedSchedule.map(d => ({
        slotNumber: d.boxNumber,
        medicineName: d.medicine,
        dosage: d.dosage,
        scheduledTime: d.time,
        taken: d.taken,
        takenAt: d.takenAt,
        missed: d.missed,
        timeoutMinutes: d.timeoutMinutes || 5,
      }))
    });

    // 2. Update medicines collection for scheduler reminders
    if (change.extractedMed) {
      const medCol = mongoDb!.collection("medicines");
      const docId = change.extractedMed.name.toLowerCase().trim().replace(/\s+/g, "_");

      await medCol.updateOne(
        { _id: docId },
        {
          $set: {
            name: change.extractedMed.name,
            dosage: change.extractedMed.dosage || "",
            purpose: change.extractedMed.purpose || "",
            times: [formattedTime],
            source: "scan",
            addedAt: Date.now() / 1000
          }
        },
        { upsert: true }
      );
      console.log(`[RX CONFIRM] Upserted medicine into database: ${change.extractedMed.name} at ${formattedTime}`);
    }
  } catch (dbErr: any) {
    console.error("[RX CONFIRM] Failed to write confirmed schedule to MongoDB collections:", dbErr.message);
  }

  broadcastSSE("rx_confirmed", { changeId, compartment: comp, label: change.proposedLabel });
  logEventLocally("rx", `Schedule confirmed — compartment ${comp}: "${change.proposedLabel}"`, "info");

  return res.json({ success: true, confirmedAt, mergedSchedule: merged });
});

// ─── POST /api/rx/reject/:changeId ───────────────────────────────────────────
app.post("/api/rx/reject/:changeId", async (req, res) => {
  const { changeId } = req.params;

  const change = await getPendingChangeById(changeId);
  if (!change) return res.status(404).json({ error: "Pending change not found" });
  if (change.status !== "pending") return res.status(409).json({ error: `Change is already ${change.status}` });

  await updatePendingChange(changeId, { status: "rejected", rejectedAt: new Date().toISOString() });

  // Mark parent prescription "rejected" if all sibling changes are done
  const sibling = await getPendingChanges();
  const sameRx = sibling.filter(c => c.prescriptionId === change.prescriptionId);
  const allDone = sameRx.every(c => c.id === changeId || c.status === "confirmed" || c.status === "rejected");
  if (allDone && !sameRx.some(c => c.status === "confirmed")) {
    await updatePrescriptionStatus(change.prescriptionId, "rejected");
  } else if (allDone) {
    await updatePrescriptionStatus(change.prescriptionId, "applied");
  }

  broadcastSSE("rx_rejected", { changeId, compartment: change.compartment });
  return res.json({ success: true });
});

// ─── DELETE /api/rx/pending/:changeId (Dismiss single card) ───────────────────
app.delete("/api/rx/pending/:changeId", async (req, res) => {
  const { changeId } = req.params;
  inMemoryPendingChanges = inMemoryPendingChanges.filter(x => x.id !== changeId);
  if (fireReady() && changeId) {
    try {
      const filter = ObjectId.isValid(changeId) ? { _id: new ObjectId(changeId) } : { _id: changeId as any };
      await mongoDb!.collection("pending_changes").deleteOne(filter);
    } catch {}
  }
  return res.json({ success: true });
});

// ─── POST /api/rx/pending/clear-completed (Clear all rejected/confirmed) ──────
app.post("/api/rx/pending/clear-completed", async (_req, res) => {
  inMemoryPendingChanges = inMemoryPendingChanges.filter(x => x.status === "pending");
  if (fireReady()) {
    try {
      await mongoDb!.collection("pending_changes").deleteMany({ status: { $in: ["confirmed", "rejected"] } });
    } catch {}
  }
  return res.json({ success: true });
});

// ─── DELETE /api/rx/pending (Clear all pending changes) ────────────────────────
app.delete("/api/rx/pending", async (_req, res) => {
  inMemoryPendingChanges = [];
  if (fireReady()) {
    try {
      await mongoDb!.collection("pending_changes").deleteMany({});
    } catch {}
  }
  return res.json({ success: true, message: "All pending changes cleared" });
});

// ─────────────────────────────────────────────────────────────────────────────
// VOICE ASSISTANT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/voice-assistant/heartbeat", (req, res) => {
  broadcastSSE("voice_assistant_heartbeat", req.body);
  res.sendStatus(200);
});

app.post("/api/voice-assistant/event", (req, res) => {
  broadcastSSE("voice_assistant_event", req.body);
  res.sendStatus(200);
});

app.get("/api/voice-assistant/pending-speak", (_req, res) => {
  if (pendingSpeakText) {
    res.json({ hasPending: true, text: pendingSpeakText });
    pendingSpeakText = null;
  } else {
    res.json({ hasPending: false });
  }
});

app.get("/api/voice-assistant/tts-pcm", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    if (!text) return res.status(400).send("Text is required");

    const flaskTtsUrl = `${FLASK_URL}/api/voice-assistant/tts-pcm?text=${encodeURIComponent(text)}`;
    const response = await fetch(flaskTtsUrl);
    if (!response.ok) {
      throw new Error(`Flask TTS returned status ${response.status}`);
    }

    res.setHeader("Content-Type", "audio/pcm");
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return res.send(buffer);
  } catch (err: any) {
    console.error("[VOICE] TTS proxy error:", err.message);
    return res.status(500).send("TTS generation failed");
  }
});

app.post("/api/voice-assistant/audio", async (req, res) => {
  const chunks: any[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const audioBuffer = Buffer.concat(chunks);
      if (audioBuffer.length === 0) return res.status(400).json({ error: "Empty audio payload" });

      if (!(await isOllamaReady())) {
        return res.status(503).json({ error: "Local AI (Ollama) not running." });
      }

      // -- Step 1: faster-whisper STT
      console.log("[VOICE] Transcribing audio with faster-whisper sidecar...");
      const transcript = await transcribeAudio(audioBuffer);
      console.log(`[VOICE] Transcript: "${transcript.slice(0, 80)}"`);

      // -- Step 2: Build patient-grounded prompt
      let patientContext = "";
      try {
        const snapshot = await buildPatientSnapshot();
        patientContext = `Current Patient Context:
${JSON.stringify(snapshot, null, 2)}
`;
      } catch (ctxErr: any) {
        console.warn("[VOICE] Failed to load patient snapshot:", ctxErr.message);
      }

      const voicePrompt = `You are Mitra, a kind and reassuring care voice assistant speaking with the care recipient. Do not assume identity, age, or diagnoses unless present in the supplied records.
Answer concisely in 1-2 sentences. Use simple, friendly language suitable for speech synthesis.

${patientContext}

Patient said: "${transcript}"

Your reply:`;

      // -- Step 3: Ollama text reply
      console.log("[VOICE] Generating reply with Ollama text model...");
      const { text: reply, model: usedModel } = await generateWithText(voicePrompt);
      console.log(`[VOICE] Reply via ${usedModel}: "${reply}"`);

      broadcastSSE("voice_assistant_query", {
        query: transcript,
        reply,
        timestamp: new Date().toISOString()
      });

      return res.json({ reply });
    } catch (err: any) {
      console.error("[VOICE] Audio handler error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });
});

async function setupViteIntegration() {
  if (process.env.NODE_ENV !== "production") {
    console.log("[INFO] Dev mode — Vite middleware active");
    const vite = await createViteServer({
      server: { middlewareMode: true, fs: { strict: false } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  ElderCare Dashboard v2 — Running on port ${PORT}  ║`);
    console.log(`║  Flask backend expected at: ${FLASK_URL}      ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
  });
}

// Connect to Firebase Firestore FIRST, then start Express + Vite
connectFirebase().then(() => {
  setupViteIntegration().catch((e) => {
    console.error("Fatal startup error:", e);
    process.exit(1);
  });
});

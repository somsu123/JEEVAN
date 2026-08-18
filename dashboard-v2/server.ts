import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import nodemailer from "nodemailer";
import twilio from "twilio";
import { createServer as createViteServer } from "vite";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

dotenv.config();

// ─── Firebase Admin SDK Connection ───────────────────────────────────────────
const FIREBASE_PROJECT = "rfidcamera-8681b";

let fireDb: Firestore;

function findServiceAccount(): string | null {
  // Look in backend folder (sibling of dashboard-v2)
  const searchDirs = [
    path.join(process.cwd(), "..", "backend"),
    path.join(process.cwd()),
  ];
  const priorityNames = [
    "firebase-service-account.json",
    "serviceAccountKey.json",
    "service-account.json",
  ];
  for (const dir of searchDirs) {
    for (const name of priorityNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    // Scan any JSON with type=service_account
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const p = path.join(dir, f);
        try {
          const content = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (content?.type === "service_account") return p;
        } catch { /* skip unreadable files */ }
      }
    } catch { /* skip unreadable dirs */ }
  }
  return null;
}

async function connectFirebase() {
  try {
    const saPath = findServiceAccount();
    if (saPath) {
      const serviceAccount = JSON.parse(fs.readFileSync(saPath, "utf-8"));
      initializeApp({
        credential: cert(serviceAccount),
        projectId: FIREBASE_PROJECT,
      });
      console.log(`[Firebase] ✅ Connected with service account: ${path.basename(saPath)}`);
    } else {
      console.error("[Firebase] ❌ Service account key not found!");
      console.error("[Firebase] Place your downloaded JSON key in: d:\\Elder--Care\\backend\\");
      console.error("[Firebase] Get it from: Firebase Console -> Project Settings -> Service Accounts");
      return;
    }
    fireDb = getFirestore();
    console.log(`[Firebase] Firestore ready -> ${FIREBASE_PROJECT}`);
  } catch (err: any) {
    console.error("[Firebase] ❌ Failed to initialize:", err.message);
  }
}

// ── Firebase ready guard ──────────────────────────────────────────────────────
function fireReady(): boolean {
  return !!fireDb;
}

// ── Medbox schedule helpers (Firestore-backed) ────────────────────────────────
async function readSchedule(): Promise<DoseEntry[]> {
  if (!fireReady()) return [];
  try {
    const snap = await fireDb.collection("medbox_schedule").get();
    return snap.docs.map((d) => d.data() as DoseEntry);
  } catch {
    return [];
  }
}

async function writeSchedule(doses: DoseEntry[]): Promise<void> {
  if (!fireReady()) return;
  try {
    const col = fireDb.collection("medbox_schedule");
    // Delete all existing, then batch-write new ones
    const existing = await col.get();
    const batch = fireDb.batch();
    existing.docs.forEach((d) => batch.delete(d.ref));
    for (const dose of doses) {
      batch.set(col.doc(), dose);
    }
    await batch.commit();
  } catch (err: any) {
    console.error("[Firebase] writeSchedule failed:", err.message);
  }
}

async function appendMedboxEvent(entry: object): Promise<void> {
  if (!fireReady()) return;
  try {
    await fireDb.collection("medbox_events").add({
      ...entry,
      loggedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Firebase] appendMedboxEvent failed:", err.message);
  }
}


const app = express();
const PORT = parseInt(process.env.PORT || "5050", 10);
const FLASK_URL = process.env.FLASK_BACKEND_URL || "http://localhost:5000";

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));



// CORS for development
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ─── Helper to load and clean API Key ─────────────────────────────────────────
function getCleanApiKey(): string | undefined {
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      const match = envContent.match(/^GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
      if (match && match[1]) {
        const fileKey = match[1].trim();
        if (fileKey && fileKey !== "your_gemini_api_key_here") {
          return fileKey;
        }
      }
    }
  } catch (e) {
    console.error("[WARN] Failed to read .env file directly for key:", e);
  }

  const envKey = process.env.GEMINI_API_KEY;
  if (!envKey || envKey === "your_gemini_api_key_here") return undefined;
  return envKey.replace(/^["']|["']$/g, "").trim();
}

// ─── Gemini SDK ───────────────────────────────────────────────────────────────
const apiKey = getCleanApiKey();
let ai: GoogleGenAI | null = null;

if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { "User-Agent": "eldercare-dashboard-v2" } },
  });
  console.log("[INFO] Gemini AI successfully initialized with API key from .env");
} else {
  console.warn("[WARN] GEMINI_API_KEY not set — AI features will be disabled.");
}

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
  confidence: number;
  status: "active" | "resolved";
  resolvedAt?: string;
}

// ── Firebase-backed fall event helpers ─────────────────────────────────────────
async function saveFallEvent(event: FallEventRecord): Promise<void> {
  if (!fireReady()) return;
  try {
    await fireDb.collection("fall_events").doc(event.id).set({ ...event });
  } catch (err: any) {
    console.error("[Firebase] saveFallEvent failed:", err.message);
  }
}

async function getFallEvents(limit = 50): Promise<FallEventRecord[]> {
  if (!fireReady()) return [];
  try {
    const snap = await fireDb.collection("fall_events")
      .orderBy("isoTimestamp", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as FallEventRecord);
  } catch (err: any) {
    console.error("[Firebase] getFallEvents failed:", err.message);
    return [];
  }
}

async function resolveFallEvent(id: string): Promise<boolean> {
  if (!fireReady()) return false;
  try {
    const resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
    await fireDb.collection("fall_events").doc(id).update({
      status: "resolved",
      resolvedAt
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveAllFallEventsBySource(source: string): Promise<number> {
  if (!fireReady()) return 0;
  try {
    const resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
    const snap = await fireDb.collection("fall_events")
      .where("source", "==", source)
      .where("status", "==", "active")
      .get();
    if (snap.empty) return 0;
    const batch = fireDb.batch();
    snap.docs.forEach((doc) => {
      batch.update(doc.ref, { status: "resolved", resolvedAt });
    });
    await batch.commit();
    return snap.size;
  } catch {
    return 0;
  }
}

async function getActiveFallCount(): Promise<number> {
  if (!fireReady()) return 0;
  try {
    const snap = await fireDb.collection("fall_events")
      .where("status", "==", "active")
      .get();
    return snap.size;
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
// LIVE VITALS — proxied from Flask /api/state (existing Elder--Care backend)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/vitals", async (_req, res) => {
  try {
    // Check bpm-server (port 3001) first for real-time ESP32 MAX30102 vitals
    let bpmData: any = null;
    try {
      const bpmRes = await fetch("http://localhost:3001/api/bpm/history?n=1");
      if (bpmRes.ok) {
        const json = await bpmRes.json();
        if (json.history && json.history.length > 0) {
          bpmData = json.history[json.history.length - 1];
        }
      }
    } catch {}

    const state = await flaskGet("/api/state").catch(() => ({}));
    const isLive = bpmData && (Date.now() - (bpmData.timestamp || 0) < 10000);

    return res.json({
      heartRate: (bpmData && bpmData.fingerDetected && bpmData.bpm > 0) ? bpmData.bpm : (state.bpm || '--'),
      oxygenSpO2: (bpmData && bpmData.fingerDetected && bpmData.spo2 > 0) ? bpmData.spo2 : (state.spo2 || 98),
      systolicBP: state.systolic || 120,
      diastolicBP: state.diastolic || 76,
      movementState: state.movement_state || "Resting",
      roomPresence: state.room_presence ?? true,
      fingerPresent: bpmData ? bpmData.fingerDetected : (state.fingerPresent ?? false),
      signalQuality: bpmData ? bpmData.signal : "unknown",
      isFall: state.is_fall || false,
      fallCount: state.fall_count || 0,
      fallsToday: state.falls_today || 0,
      _liveESP32: !!isLive,
    });
  } catch {
    // Return defaults if offline
    return res.json({
      heartRate: '--', oxygenSpO2: 98,
      systolicBP: 120, diastolicBP: 76,
      movementState: "Resting", roomPresence: true,
      fingerPresent: false,
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
  } catch {}
  return res.json({ history: [], stats: { bpm: {}, spo2: {} } });
});

// GET /api/esp32/status — lightweight ESP32 connection + finger detection status
app.get("/api/esp32/status", async (_req, res) => {
  try {
    const r = await fetch("http://localhost:3001/api/bpm/status");
    if (r.ok) return res.json(await r.json());
  } catch {}
  return res.json({
    espConnected:   false,
    fingerDetected: false,
    signal:         "unknown",
    latestBpm:      null,
    latestSpo2:     null,
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
      await flaskPost("/api/heartrate", { bpm: body.bpm }).catch(() => {});
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
  braceletStatus.bpm           = bpm;
  braceletStatus.fingerPresent = fingerPresent ?? false;
  braceletStatus.lastSeen      = new Date().toISOString();
  braceletStatus.online        = true;

  // Broadcast to dashboard via SSE
  broadcastSSE("vitals_update", { heartRate: bpm, bpm, alert, fingerPresent });

  // Save BPM locally
  saveBpmLocally(bpm);

  // Forward to Flask for DB persistence
  if (bpm > 0) {
    flaskPost("/api/heartrate", { bpm }).catch(() => {});
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

  braceletStatus.online        = true;
  braceletStatus.lastSeen      = new Date().toISOString();
  braceletStatus.bpm           = bpm ?? braceletStatus.bpm;
  braceletStatus.fallPhase     = fallPhase ?? "IDLE";
  braceletStatus.fingerPresent = fingerPresent ?? false;
  braceletStatus.uptime        = uptime ?? 0;
  braceletStatus.deviceId      = deviceId ?? "bracelet-01";

  // Persist bracelet status to Firebase
  if (fireReady()) {
    fireDb.collection("device_status").doc("bracelet").set({
      ...braceletStatus,
      updatedAt: new Date().toISOString()
    }, { merge: true }).catch(() => {});
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
  const gmailUser  = process.env.GMAIL_USER;
  const gmailPass  = process.env.GMAIL_APP_PASSWORD;
  const careEmail  = process.env.CAREGIVER_EMAIL || gmailUser;

  if (!gmailUser || !gmailPass) {
    console.warn("[MAIL] Gmail credentials not set — skipping fall email");
    return;
  }

  const severityColor = event.type === "Critical Fall" ? "#dc2626"
    : event.type === "Rapid Descent" ? "#f97316" : "#eab308";

  const sourceLabel = event.source === "bracelet" ? "🔵 Wrist Bracelet"
    : event.source === "camera" ? "📷 AI Camera"
    : event.source === "both" ? "🔵 Bracelet + 📷 Camera" : event.source;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  await transporter.sendMail({
    from: `"ElderCare Dashboard" <${gmailUser}>`,
    to: careEmail,
    subject: `🚨 ${event.type} Detected — Arthur Pendelton`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <div style="background:${severityColor};padding:20px 24px">
          <h2 style="color:#fff;margin:0;font-size:20px">🚨 ${event.type} Detected</h2>
          <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px">ElderCare AI Monitoring System</p>
        </div>
        <div style="padding:24px">
          <p style="color:#1e293b;font-size:15px;margin:0 0 16px">
            A fall event has been detected for <strong>Arthur Pendelton</strong>.
            Please check on them immediately.
          </p>
          <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden">
            <tr style="background:#f8fafc">
              <td style="padding:10px 14px;color:#64748b;font-size:13px;width:40%">Event Type</td>
              <td style="padding:10px 14px;font-weight:bold;color:${severityColor};font-size:14px">${event.type}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;color:#64748b;font-size:13px">Detected By</td>
              <td style="padding:10px 14px;font-weight:600;color:#0f172a;font-size:13px">${sourceLabel}</td>
            </tr>
            <tr style="background:#f8fafc">
              <td style="padding:10px 14px;color:#64748b;font-size:13px">Location</td>
              <td style="padding:10px 14px;font-weight:600;color:#0f172a;font-size:13px">${event.location}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;color:#64748b;font-size:13px">Confidence</td>
              <td style="padding:10px 14px;font-weight:600;color:#0f172a;font-size:13px">${Math.round(event.confidence * 100)}%</td>
            </tr>
            <tr style="background:#f8fafc">
              <td style="padding:10px 14px;color:#64748b;font-size:13px">Time</td>
              <td style="padding:10px 14px;font-weight:600;color:#0f172a;font-size:13px">${event.timestamp}</td>
            </tr>
          </table>
          <div style="margin-top:20px;padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">
            <p style="margin:0;color:#991b1b;font-size:13px;font-weight:600">
              ⚠️ Immediate Action Required
            </p>
            <p style="margin:6px 0 0;color:#b91c1c;font-size:12px">
              Call Arthur or dispatch a caregiver immediately.
              If no response in 2 minutes, contact emergency services (112).
            </p>
          </div>
          <p style="color:#94a3b8;font-size:11px;margin-top:20px">Sent automatically by ElderCare Dashboard v2 · Do not reply</p>
        </div>
      </div>
    `,
  });

  console.log(`[MAIL] Fall alert sent to ${careEmail} — ${event.type} @ ${event.timestamp}`);
}

// ── SMS alert for fall event via Twilio ────────────────────────────────────
async function sendFallSmsAlert(event: FallEventRecord) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;   // e.g. "+12025551234"
  const toNumber   = process.env.CAREGIVER_PHONE;      // e.g. "+919876543210"

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
    `Patient: Arthur Pendelton\n` +
    `Source: ${sourceLabel}\n` +
    `Location: ${event.location}\n` +
    `Confidence: ${Math.round(event.confidence * 100)}%\n` +
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
      cameraStatus.online   = true;
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
    let type = "Stumble Warning";
    if ((body.confidence || 0) >= 0.85) type = "Critical Fall";
    else if ((body.confidence || 0) >= 0.65) type = "Rapid Descent";

    const event: FallEventRecord = {
      id: `fall-${Date.now()}`,
      isoTimestamp: now.toISOString(),
      timestamp:
        now.toLocaleTimeString("en-US", { hour12: false }) +
        " — " +
        now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      type,
      source,
      location: body.location || "Living Room",
      confidence: parseFloat(body.confidence) || 0.5,
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
      }));
      await writeSchedule(doses);
      saveScheduleLocally(doses);
      console.log(`[MongoDB] Wrote ${doses.length} doses to medbox_schedule.`);
    }

    const times = (slots || []).map((s: any) => s.scheduledTime).filter(Boolean);
    await flaskPost("/api/schedule", times).catch(() => {});
    
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
    }).catch(() => {});
    
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
// REPORT SCANNER — Gemini vision analysis + medicine extraction + MongoDB save
// ─────────────────────────────────────────────────────────────────────────────

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
        dosage:   med.dosage,
        time:     med.scheduledTime,
        message:  speakText,
      });



      console.log(`[REMINDER] ${speakText}`);
    }
  } catch (err: any) {
    console.error("[REMINDER] Cron error:", err?.message);
  }
}, 60_000);

app.post("/api/scan-report", async (req, res) => {
  try {
    const { fileData, mimeType, fileName } = req.body;

    if (!fileData) {
      return res.status(400).json({ error: "Missing fileData (base64 string)" });
    }

    // Dynamically load the API key from .env directly to pick up updates without restarting
    dotenv.config({ override: true });
    const currentApiKey = getCleanApiKey();
    const activeAi = currentApiKey
      ? new GoogleGenAI({ apiKey: currentApiKey, httpOptions: { headers: { "User-Agent": "eldercare-dashboard-v2" } } })
      : null;

    if (!activeAi) {
      return res.status(500).json({
        error: "Gemini AI is not initialized. Please verify your GEMINI_API_KEY is configured in the Secrets manager.",
      });
    }

    // Prepare multi-part content matching @google/genai SDK guidelines
    const filePart = {
      inlineData: {
        mimeType: mimeType || "image/jpeg",
        data: fileData,
      },
    };

    const textPart = {
      text: `You are an expert senior geriatric healthcare consultant and medical analyst named AI_CARE. 
      Analyze this clinical report or medical document carefully. 
      Extract structured data matching the schema perfectly. Keep explanations patient-friendly and geriatric care-focused.`,
    };

    const response = await activeAi.models.generateContent({
      model: "gemini-2.5-flash",
      contents: { parts: [filePart, textPart] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            overview: { type: "STRING", description: "Brief patient-friendly overview of the clinical report and what was analyzed." },
            metrics: {
              type: "ARRAY",
              description: "Extracted key readings or laboratory values with patient-focused status and explanation.",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING", description: "Name of the metric or test, e.g. BP, Hemoglobin, Heart Rate, GFR." },
                  value: { type: "STRING", description: "The reading value, e.g. 138/84 mmHg, 11.2 g/dL." },
                  status: { type: "STRING", description: "Geriatric clinical status, e.g. NORMAL, ELEVATED, CONCERNING." },
                  interpretation: { type: "STRING", description: "Simple, highly reassuring explanation of what this reading means for the patient." }
                },
                required: ["name", "value", "status", "interpretation"]
              }
            },
            actions: {
              type: "ARRAY",
              description: "List of reassuring action steps and lifestyle tips for the elderly individual.",
              items: { type: "STRING" }
            },
            doctorQuestions: {
              type: "ARRAY",
              description: "Practical questions for the patient to bring up with their doctor during their next visit.",
              items: { type: "STRING" }
            },
            disclaimer: { type: "STRING", description: "Empathetic medical disclaimer advising consulting their physician." },
            medicines: {
              type: "ARRAY",
              description: "Extracted daily medications listed in the prescription or note. Extract all of them carefully.",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING", description: "Exact name of the medicine, e.g. Lisinopril, Metformin." },
                  dosage: { type: "STRING", description: "Dosage detail, e.g. 10mg, 500mg, or leave blank if unspecified." },
                  times: {
                    type: "ARRAY",
                    description: "Specific scheduled times in 24h format HH:MM (e.g. ['08:00', '20:00']). If times are not explicitly specified, map or extrapolate logical daily timings based on instructions (e.g., 'morning' -> ['08:00'], 'twice daily' -> ['08:00', '20:00']). Default to morning ['08:00'] if unspecified.",
                    items: { type: "STRING" }
                  },
                  purpose: { type: "STRING", description: "Brief patient-friendly description of the clinical purpose." }
                },
                required: ["name", "times"]
              }
            }
          },
          required: ["overview", "metrics", "actions", "doctorQuestions", "disclaimer", "medicines"]
        }
      }
    });

    const responseText = response.text;
    if (!responseText) {
      return res.status(500).json({ error: "Failed to generate structured scanner output from Gemini." });
    }

    // Parse the structured schema from Gemini
    let schemaData;
    try {
      schemaData = JSON.parse(responseText);
    } catch (parseErr) {
      console.warn("[WARN] Gemini did not return valid JSON. Falling back to plain text parsing.", parseErr);
      schemaData = {
        overview: responseText,
        metrics: [],
        actions: [],
        doctorQuestions: [],
        disclaimer: "Disclaimer: Always consult with a doctor.",
        medicines: []
      };
    }

    // Construct a beautiful markdown summary out of the structured schema fields for backward-compatible rendering
    const overviewSection = `## Document Overview\n${schemaData.overview || "No overview available."}\n\n`;
    
    let metricsSection = `## Key Metrics & Readings\n`;
    if (Array.isArray(schemaData.metrics) && schemaData.metrics.length > 0) {
      schemaData.metrics.forEach((m: any) => {
        metricsSection += `* **${m.name}**: ${m.value} (${m.status}) — *${m.interpretation}*\n`;
      });
    } else {
      metricsSection += `* No critical metrics recorded.\n`;
    }
    metricsSection += `\n`;

    let medicinesSection = `## Prescribed Medications\n`;
    if (Array.isArray(schemaData.medicines) && schemaData.medicines.length > 0) {
      schemaData.medicines.forEach((m: any) => {
        const timeList = Array.isArray(m.times) ? m.times.join(", ") : "";
        const timeStr = timeList ? ` at ${timeList}` : "";
        const purposeStr = m.purpose ? ` — *${m.purpose}*` : "";
        medicinesSection += `* **${m.name}**${m.dosage ? ` (${m.dosage})` : ""}${timeStr}${purposeStr}\n`;
      });
    } else {
      medicinesSection += `* No medications extracted from prescription.\n`;
    }
    medicinesSection += `\n`;

    let actionsSection = `## Action Items & Lifestyle Recommendations\n`;
    if (Array.isArray(schemaData.actions) && schemaData.actions.length > 0) {
      schemaData.actions.forEach((a: string) => {
        actionsSection += `* ${a}\n`;
      });
    } else {
      actionsSection += `* Continue current daily routine as advised.\n`;
    }
    actionsSection += `\n`;

    let questionsSection = `## Questions to Ask your Doctor\n`;
    if (Array.isArray(schemaData.doctorQuestions) && schemaData.doctorQuestions.length > 0) {
      schemaData.doctorQuestions.forEach((q: string) => {
        questionsSection += `* ${q}\n`;
      });
    } else {
      questionsSection += `* Ask if any medications require routine lab tests.\n`;
    }
    questionsSection += `\n`;

    const disclaimerSection = `## Medical Disclaimer\n${schemaData.disclaimer || "Consult your physician for personalized medical advice."}`;

    const summaryText = overviewSection + metricsSection + medicinesSection + actionsSection + questionsSection + disclaimerSection;

    // Automatically save the scanned report AND the raw extracted schema fields to MongoDB Atlas via Flask
    try {
      const scanDate = new Date().toLocaleTimeString("en-US", { hour12: false }) + " — " + new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      saveReportLocally({
        fileName: fileName || "unnamed document",
        summary: summaryText,
        scanDate,
        overview: schemaData.overview,
        metrics: schemaData.metrics,
        actions: schemaData.actions,
        doctorQuestions: schemaData.doctorQuestions,
        disclaimer: schemaData.disclaimer
      });
      if (schemaData.medicines && schemaData.medicines.length > 0) {
        saveMedicinesLocally(schemaData.medicines);
      }
      logEventLocally("scan", `Prescription report '${fileName}' scanned successfully`, "info");

      await flaskPost("/api/reports/save", {
        fileName: fileName || "unnamed document",
        summary: summaryText,
        scanDate,
        medicines: schemaData.medicines || [],
        overview: schemaData.overview,
        metrics: schemaData.metrics,
        actions: schemaData.actions,
        doctorQuestions: schemaData.doctorQuestions,
        disclaimer: schemaData.disclaimer
      });
      console.log(`[DB] Scanned report '${fileName}' saved to database successfully with full structured schema.`);
      
      // Broadcast extracted medicines to dashboard UI via SSE
      if (schemaData.medicines && schemaData.medicines.length > 0) {
        broadcastSSE("medicines_extracted", { medicines: schemaData.medicines, source: "scan" });
      }
    } catch (dbErr: any) {
      console.error("[WARN] Failed to automatically save scanned report schema to database:", dbErr?.message);
    }

    return res.json({ success: true, summary: summaryText });
  } catch (error: any) {
    console.error("Gemini Scan Error:", error);
    return res.status(500).json({
      error: error?.message || "Internal server error occurred while scanning with Gemini.",
    });
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

// DoseEntry schema (all persistence is in MongoDB medbox_schedule collection)
interface DoseEntry {
  time: string;
  medicine: string;
  dosage: string;
  boxNumber: number;
  taken: boolean;
  takenAt?: string;
  missed?: boolean;
}

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
  const gmailUser    = process.env.GMAIL_USER;
  const gmailPass    = process.env.GMAIL_APP_PASSWORD;
  const careEmail    = process.env.CAREGIVER_EMAIL || gmailUser;

  if (!gmailUser || !gmailPass) {
    console.warn("[MAIL] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email alert");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  await transporter.sendMail({
    from: `"ElderCare Dashboard" <${gmailUser}>`,
    to: careEmail,
    subject: `⚠️ Missed Dose Alert — Arthur Pendelton`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <div style="background:#ef4444;padding:20px 24px">
          <h2 style="color:#fff;margin:0">⚠️ Missed Dose Alert</h2>
        </div>
        <div style="padding:24px">
          <p style="color:#1e293b;font-size:16px">
            <strong>Arthur Pendelton</strong> missed their scheduled dose.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr style="background:#f8fafc">
              <td style="padding:8px 12px;color:#64748b;font-size:13px">Medicine</td>
              <td style="padding:8px 12px;font-weight:bold;color:#0f172a">${medicine}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#64748b;font-size:13px">Dosage</td>
              <td style="padding:8px 12px;font-weight:bold;color:#0f172a">${dosage}</td>
            </tr>
            <tr style="background:#f8fafc">
              <td style="padding:8px 12px;color:#64748b;font-size:13px">Scheduled at</td>
              <td style="padding:8px 12px;font-weight:bold;color:#0f172a">${time}</td>
            </tr>
          </table>
          <p style="color:#475569;font-size:14px">Please check in with Arthur or contact the attending caregiver immediately.</p>
          <p style="color:#94a3b8;font-size:11px;margin-top:24px">Sent automatically by ElderCare Dashboard v2.</p>
        </div>
      </div>
    `,
  });

  console.log(`[MAIL] Missed-dose alert sent to ${careEmail} — ${medicine} @ ${time}`);
}

// ── GET /api/medication/schedule ──────────────────────────────────────────────
app.get("/api/medication/schedule", async (_req, res) => {
  try {
    // 1. Fetch active medicines from MongoDB Atlas (via Flask API)
    const data = await flaskGet("/api/medicines");
    
    if (data && Array.isArray(data.medicines) && data.medicines.length > 0) {
      const dbMeds = data.medicines;
      const sortedMeds = [...dbMeds].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      const mappedMeds = sortedMeds.slice(0, 2);
      
      // 2. Read today's intake completion from MongoDB medbox_schedule
      const mongoSchedule = await readSchedule();
      
      const doses: DoseEntry[] = [];
      
      mappedMeds.forEach((med, index) => {
        const boxNumber = (index + 1) as 1 | 2;
        const times = Array.isArray(med.times) && med.times.length > 0 ? med.times : ["08:00"];
        
        times.forEach((t: string) => {
          const match = mongoSchedule.find(
            (d) =>
              d.boxNumber === boxNumber &&
              d.time === t &&
              d.medicine.toLowerCase() === med.name.toLowerCase()
          );
          
          doses.push({
            time: t,
            medicine: med.name,
            dosage: med.dosage || "—",
            boxNumber: boxNumber,
            taken: match ? match.taken : false,
            takenAt: match ? match.takenAt : undefined,
            missed: match ? match.missed : false,
          });
        });
      });
      
      console.log(`[MongoDB] Dynamic schedule: ${doses.length} doses for ${mappedMeds.length} medicines.`);
      return res.json({ deviceId: "medbox-01", doses });
    }
    
    throw new Error("No medicines found in database");
  } catch (err: any) {
    console.warn(`[MongoDB] Schedule fetch failed (${err.message}). Falling back to medbox_schedule collection.`);
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

  // Persist medbox status to Firebase
  if (fireReady()) {
    fireDb.collection("device_status").doc("medbox-01").set({
      ...medboxStatus,
      updatedAt: new Date().toISOString()
    }, { merge: true }).catch(() => {});
  }

  // Broadcast telemetry updates to the React UI via SSE
  broadcastSSE("medbox_heartbeat", medboxStatus);

  // Send remote lid-open request active status
  const response = { remoteOpen: remoteOpenFlag };
  if (remoteOpenFlag) {
    console.log(`[HEARTBEAT] Served remote lid-open request to medbox. Resetting flag.`);
    remoteOpenFlag = false;
  }

  return res.json(response);
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
// AI DICTATOR — Gemini-powered clinical summary (PC-native, no Pi/Ollama needed)
// ─────────────────────────────────────────────────────────────────────────────

// ── Local File Persistence Helpers for Robust Fallback ─────────────────────────
function saveBpmLocally(bpm: number) {
  const filePath = path.join(process.cwd(), "data", "bpm.json");
  let list: Array<{ bpm: number; timestamp: number }> = [];
  try {
    if (fs.existsSync(filePath)) {
      list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
  list.push({ bpm, timestamp: Math.floor(Date.now() / 1000) });
  if (list.length > 200) list.shift();
  try {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local bpm file:", err.message);
  }
}

function saveFallEventLocally(event: FallEventRecord) {
  const filePath = path.join(process.cwd(), "data", "fall_events.json");
  let list: FallEventRecord[] = [];
  try {
    if (fs.existsSync(filePath)) {
      list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
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
  } catch {}
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
  } catch {}
  list.unshift({ type, message, severity, timestamp: Math.floor(Date.now() / 1000) });
  if (list.length > 100) list.pop();
  try {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to write local events file:", err.message);
  }
}

function saveReportLocally(report: { fileName: string; summary: string; scanDate: string; [key: string]: any }) {
  const filePath = path.join(process.cwd(), "data", "reports.json");
  let list: any[] = [];
  try {
    if (fs.existsSync(filePath)) {
      list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
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
  } catch {}

  let localMeds: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "medicines.json");
    if (fs.existsSync(p)) localMeds = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}

  let localEvents: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "events.json");
    if (fs.existsSync(p)) localEvents = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}

  let localReports: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "reports.json");
    if (fs.existsSync(p)) localReports = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}

  let localFallEvents: any[] = [];
  try {
    const p = path.join(process.cwd(), "data", "fall_events.json");
    if (fs.existsSync(p)) localFallEvents = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}

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

/** Helper: build the Gemini clinical summary prompt */
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

PATIENT: Arthur Pendelton, Age 82. Cardiology & IoT Monitoring Program.

HEART RATE (last 120 readings): ${bpmSummary}

FALL EVENTS: ${analytics.recentFalls30Days} fall(s) in the last 30 days. ${analytics.activeFalls} currently active/unresolved. ${analytics.totalFalls} total recorded falls.

CURRENT MEDICATIONS: ${medLines}

RECENT LAB REPORTS:
${reportLines}

RECENT SYSTEM EVENTS: ${recentEvents}

Provide the verbal clinical briefing now. Begin with "Doctor," and end with a recommendation for the physician's attention.`;
}

// POST /api/ai-dictator/trigger — Gemini-powered clinical summary (PC-native)
app.post("/api/ai-dictator/trigger", async (_req, res) => {
  try {
    // Reload API key dynamically to pick up .env changes without restart
    dotenv.config({ override: true });
    const currentApiKey = getCleanApiKey();
    const activeAi = currentApiKey
      ? new GoogleGenAI({ apiKey: currentApiKey, httpOptions: { headers: { "User-Agent": "eldercare-dashboard-v2" } } })
      : null;

    if (!activeAi) {
      return res.status(500).json({
        error: "Gemini AI is not initialized. Please set GEMINI_API_KEY in the .env file.",
      });
    }

    console.log("[DICTATOR] Compiling clinical patient data from MongoDB...");

    // 1. Gather all patient data
    const snap = await buildPatientSnapshot();

    // 2. Build prompt and call Gemini
    const prompt = buildDictatorPrompt(snap);
    console.log("[DICTATOR] Sending data to Gemini for clinical summary generation...");

    const response = await activeAi.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { temperature: 0.3 },
    });

    const summary = (response.text || "").trim();
    if (!summary) {
      throw new Error("Gemini returned an empty summary.");
    }

    console.log("[DICTATOR] Clinical summary generated successfully.");
    console.log("[DICTATOR] Summary preview:", summary.slice(0, 120) + "...");

    return res.json({
      success: true,
      summary,
      patientName: "Arthur Pendelton",
      analytics: snap.analytics,
    });
  } catch (err: any) {
    console.error("[DICTATOR] Summary generation failed:", err.message);
    return res.status(500).json({ error: `AI Dictator failed: ${err.message}` });
  }
});

// POST /api/ai-dictator/ask — Doctor Q&A grounded in MongoDB patient data only
app.post("/api/ai-dictator/ask", async (req, res) => {
  try {
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return res.status(400).json({ error: "question is required" });
    }

    dotenv.config({ override: true });
    const currentApiKey = getCleanApiKey();
    const activeAi = currentApiKey
      ? new GoogleGenAI({ apiKey: currentApiKey, httpOptions: { headers: { "User-Agent": "eldercare-dashboard-v2" } } })
      : null;

    if (!activeAi) {
      return res.status(500).json({ error: "Gemini AI not initialized." });
    }

    // Fetch fresh patient data to ground the answer
    const snap = await buildPatientSnapshot();
    const { analytics, medicines, reports, events } = snap;

    const medLines = medicines.length
      ? medicines.map((m: any) => `${m.name} ${m.dosage || ""} — ${m.purpose || "purpose unknown"}`).join("; ")
      : "None on record.";

    const recentReportSummaries = reports
      .slice(0, 5)
      .map((r: any) => `${r.fileName} (${r.scanDate || "?"}): ${(r.overview || r.summary || "").slice(0, 300)}`)
      .join("\n");

    const recentEvents = events
      .slice(0, 10)
      .map((e: any) => `[${e.type}] ${e.message}`)
      .join("; ");

    const qaPrompt = `You are Mitra, a clinical AI assistant for the ElderCare monitoring system. A physician is asking you a question about patient Arthur Pendelton (Age 82). Answer ONLY using the patient data provided below. If the answer is not found in the data, say exactly: "Information not available in patient records." Keep your answer concise (2–4 sentences), factual, and professional.

PATIENT DATA:
Heart Rate: Average ${analytics.avgBpm ?? "N/A"} BPM, Max ${analytics.maxBpm ?? "N/A"}, Min ${analytics.minBpm ?? "N/A"}. Abnormal readings: ${analytics.abnormalBpmCount}.
Falls (last 30 days): ${analytics.recentFalls30Days}. Total recorded: ${analytics.totalFalls}. Active unresolved: ${analytics.activeFalls}.
Medications: ${medLines}
Recent Lab Reports:
${recentReportSummaries || "No reports available."}
Recent System Events: ${recentEvents || "None."}

DOCTOR'S QUESTION: ${question.trim()}

Answer:`;

    const response = await activeAi.models.generateContent({
      model: "gemini-2.5-flash",
      contents: qaPrompt,
      config: { temperature: 0.2 },
    });

    const answer = (response.text || "").trim() || "Information not available in patient records.";
    return res.json({ success: true, answer });
  } catch (err: any) {
    console.error("[DICTATOR/ASK] Q&A failed:", err.message);
    return res.status(500).json({ error: `Q&A failed: ${err.message}` });
  }
});

// ── POST /api/hardware/medbox-event (duplicate route — fully MongoDB-backed) ──
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
    dosage:   dosage   || slot?.dosage,
    timestamp: timestamp || new Date().toISOString(),
    deviceId:  deviceId || "medbox-01",
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

  medboxStatus.lastSeen        = new Date().toISOString();
  medboxStatus.state           = state || "IDLE";
  medboxStatus.presenceDetected = presenceDetected ?? false;
  medboxStatus.nextDoseTime    = nextDoseTime || await getNextDoseTime();
  medboxStatus.uptime          = uptime ?? 0;
  medboxStatus.deviceId        = deviceId || "medbox-01";
  medboxStatus.online          = true;

  // Persist to Firebase device_status
  if (fireReady()) {
    fireDb.collection("device_status").doc("medbox-01").set({
      ...medboxStatus,
      updatedAt: new Date().toISOString()
    }, { merge: true }).catch(() => {});
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
    medboxStatus.lastSeen         = new Date().toISOString();
    medboxStatus.state            = simStates[simStateIdx % simStates.length];
    medboxStatus.online           = true;
    medboxStatus.presenceDetected = Math.random() > 0.5;
    medboxStatus.nextDoseTime     = await getNextDoseTime();
    medboxStatus.uptime           = (medboxStatus.uptime || 0) + 10;
    simStateIdx++;
    if (fireReady()) {
      fireDb.collection("device_status").doc("medbox-01-sim").set(
        { ...medboxStatus, updatedAt: new Date().toISOString() },
        { merge: true }
      ).catch(() => {});
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
        dose.taken  = true;
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

// ─── Firestore helpers: new collections ──────────────────────────────────────

// prescriptions — raw OCR + parsed result per upload
async function savePrescription(doc: object): Promise<string> {
  if (!fireReady()) return `local-${Date.now()}`;
  const ref = await fireDb.collection("prescriptions").add({ ...doc, uploadedAt: new Date().toISOString() });
  return ref.id;
}

async function getPrescriptions(limit = 20): Promise<any[]> {
  if (!fireReady()) return [];
  try {
    const snap = await fireDb.collection("prescriptions").orderBy("uploadedAt", "desc").limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function updatePrescriptionStatus(id: string, status: string): Promise<void> {
  if (!fireReady()) return;
  try { await fireDb.collection("prescriptions").doc(id).update({ status }); } catch {}
}

// pending_changes — one row per proposed compartment change
async function savePendingChange(doc: object): Promise<string> {
  if (!fireReady()) return `local-${Date.now()}`;
  const ref = await fireDb.collection("pending_changes").add({ ...doc, createdAt: new Date().toISOString(), status: "pending" });
  return ref.id;
}

async function getPendingChanges(statusFilter?: string): Promise<any[]> {
  if (!fireReady()) return [];
  try {
    let q: FirebaseFirestore.Query = fireDb.collection("pending_changes");
    if (statusFilter) q = q.where("status", "==", statusFilter);
    const snap = await (q as FirebaseFirestore.Query).orderBy("createdAt", "desc").get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function updatePendingChange(id: string, fields: object): Promise<void> {
  if (!fireReady()) return;
  try { await fireDb.collection("pending_changes").doc(id).update(fields); } catch {}
}

async function getPendingChangeById(id: string): Promise<any | null> {
  if (!fireReady()) return null;
  try {
    const doc = await fireDb.collection("pending_changes").doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  } catch { return null; }
}

// dose_events — history/adherence log, built from polling givenToday
async function appendDoseEvent(doc: object): Promise<void> {
  if (!fireReady()) return;
  try { await fireDb.collection("dose_events").add({ ...doc, loggedAt: new Date().toISOString() }); } catch {}
}

async function getDoseEvents(limit = 100): Promise<any[]> {
  if (!fireReady()) return [];
  try {
    const snap = await fireDb.collection("dose_events").orderBy("loggedAt", "desc").limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

// schedule_cache — last known ESP32 schedule state (refreshed each poll)
async function readScheduleCache(): Promise<any[]> {
  if (!fireReady()) return [];
  try {
    const snap = await fireDb.collection("schedule_cache").orderBy("compartment").get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function writeScheduleCache(entries: any[]): Promise<void> {
  if (!fireReady()) return;
  try {
    const col = fireDb.collection("schedule_cache");
    const existing = await col.get();
    const batch = fireDb.batch();
    existing.docs.forEach(d => batch.delete(d.ref));
    for (const e of entries) {
      batch.set(col.doc(`comp-${e.compartment}`), { ...e, updatedAt: new Date().toISOString() });
    }
    await batch.commit();
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
          scheduledTime: `${String(dose.hour).padStart(2,"0")}:${String(dose.minute).padStart(2,"0")}`,
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
            scheduledTime: `${String(dose.hour).padStart(2,"0")}:${String(dose.minute).padStart(2,"0")}`,
            takenAt: null,
            status: "missed",
          });
          broadcastSSE("dose_event", { compartment: key, label: dose.label, status: "missed", takenAt: null });
          // Also send missed-dose Gmail alert
          sendMissedDoseAlert(dose.label, `${dose.hour}:${String(dose.minute).padStart(2,"0")}`, "").catch(() => {});
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
    // ESP32 offline / unreachable — silent fail
    if (process.env.NODE_ENV !== "production") {
      console.debug("[RX POLL] ESP32 unreachable:", err.message);
    }
  }
}

// Start polling after 5s (give Firebase time to connect)
if (ESP32_BASE_URL) {
  setTimeout(() => {
    pollEsp32Schedule();
    setInterval(pollEsp32Schedule, 15_000);
    console.log(`[RX] ESP32 polling started → ${ESP32_BASE_URL}/api/schedule every 15s`);
  }, 5_000);
} else {
  console.warn("[RX] ESP32_BASE_URL not set — dose polling disabled. Set it in .env to enable.");
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

// ═════════════════════════════════════════════════════════════════════════════
// RX UPLOAD — Prescription OCR + Gemini Extraction
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/rx/upload — upload prescription image, extract medicines, generate pending_changes
app.post("/api/rx/upload", async (req, res) => {
  try {
    const { fileData, mimeType, fileName } = req.body as {
      fileData: string;
      mimeType?: string;
      fileName?: string;
    };

    if (!fileData) return res.status(400).json({ error: "fileData (base64) is required" });

    dotenv.config({ override: true });
    const currentApiKey = getCleanApiKey();
    const activeAi = currentApiKey
      ? new GoogleGenAI({ apiKey: currentApiKey, httpOptions: { headers: { "User-Agent": "eldercare-dashboard-v2" } } })
      : null;

    if (!activeAi) {
      return res.status(500).json({ error: "Gemini AI not initialized — set GEMINI_API_KEY in .env" });
    }

    console.log(`[RX] Processing prescription upload: ${fileName || "unnamed"}`);

    // ── Step 1: Gemini Vision — OCR + strict JSON extraction in one pass ─────
    const extractionPrompt = `You are a prescription digitizer for a medical device system.
Examine this prescription image carefully. Extract ONLY the medicines/drugs listed.

Return ONLY a valid JSON array — no markdown, no extra text, no explanation.
Each item must follow this exact schema:
{"name": string, "dosage": string|null, "frequency": string|null, "suggestedTime": "HH:MM", "confidence": "high"|"low"}

Rules:
- name: exact medicine name as written (required)
- dosage: strength and unit if readable (e.g. "10mg", "500mg twice"), null if unclear
- frequency: dosing instructions if readable (e.g. "once daily", "twice a day"), null if unclear
- suggestedTime: best-guess 24h time based on frequency (morning=08:00, noon=13:00, evening=18:00, night=21:00). If frequency implies multiple times, use the first.
- confidence: "high" if you can read the text clearly, "low" if the handwriting/print is ambiguous
- If a field is unclear, mark confidence "low" and set that field to null — do NOT guess
- Return [] if no medicines can be read`;

    let extractedMeds: any[] = [];
    let ocrText = "";

    try {
      const response = await activeAi.models.generateContent({
        model: "gemini-2.5-flash",
        contents: {
          parts: [
            { inlineData: { mimeType: mimeType || "image/jpeg", data: fileData } },
            { text: extractionPrompt },
          ],
        },
        config: { temperature: 0.1 },
      });

      const rawText = (response.text || "").trim();
      ocrText = rawText;

      // Strip markdown code fences if model wrapped the JSON
      const jsonStr = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

      // Validate: must be an array
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error("Gemini returned a non-array response");

      // Schema-validate each item
      extractedMeds = parsed.map((m: any) => ({
        name: String(m.name || "").trim(),
        dosage: m.dosage ? String(m.dosage).trim() : null,
        frequency: m.frequency ? String(m.frequency).trim() : null,
        suggestedTime: /^\d{2}:\d{2}$/.test(m.suggestedTime) ? m.suggestedTime : "08:00",
        confidence: m.confidence === "low" ? "low" : "high",
      })).filter((m: any) => m.name.length > 0);

    } catch (parseErr: any) {
      console.error("[RX] Gemini extraction parse error:", parseErr.message);
      return res.status(422).json({
        error: "Extraction failed — Gemini did not return valid JSON. Raw output saved. Please try a clearer image.",
        ocrText,
      });
    }

    console.log(`[RX] Extracted ${extractedMeds.length} medicines from prescription`);

    // ── Step 2: Store prescription to Firestore ───────────────────────────────
    const prescriptionId = await savePrescription({
      fileName: fileName || "unnamed",
      ocrText,
      extractedMeds,
      llmModel: "gemini-2.5-flash",
      status: "pending_review",
    });

    // ── Step 3: Diff extracted vs. current ESP32 schedule cache ──────────────
    const cacheEntries = await readScheduleCache();

    // Build a pending_change for each extracted medicine that differs from current box state
    const pendingChanges: any[] = [];
    for (let i = 0; i < Math.min(extractedMeds.length, 4); i++) {
      const med = extractedMeds[i];
      const cacheEntry = cacheEntries.find(c => c.compartment === i) || null;
      const currentLabel = cacheEntry ? cacheEntry.label : "(empty)";
      const [propH, propM] = med.suggestedTime.split(":").map(Number);

      const proposedLabel = med.dosage ? `${med.name} - ${med.dosage}` : med.name;
      const isDifferent = !cacheEntry || cacheEntry.label !== proposedLabel;

      if (isDifferent) {
        const changeId = await savePendingChange({
          prescriptionId,
          compartment: i,
          currentLabel,
          proposedLabel,
          proposedHour: propH,
          proposedMinute: propM,
          extractedMed: med,
          reloadConfirmed: false,
        });
        pendingChanges.push({ id: changeId, compartment: i, currentLabel, proposedLabel, confidence: med.confidence });
      }
    }

    broadcastSSE("rx_upload_done", { prescriptionId, extractedMeds, pendingChanges });
    logEventLocally("rx", `Prescription '${fileName}' uploaded — ${extractedMeds.length} medicines extracted, ${pendingChanges.length} changes pending`, "info");

    return res.json({
      success: true,
      prescriptionId,
      extractedMeds,
      pendingChanges,
    });

  } catch (err: any) {
    console.error("[RX] Upload error:", err.message);
    return res.status(500).json({ error: err.message || "Internal error during prescription processing" });
  }
});

// ─── GET /api/rx/prescriptions ────────────────────────────────────────────────
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

// ─── POST /api/rx/confirm/:changeId ──────────────────────────────────────────
// THIS IS THE ONLY ENDPOINT IN THE ENTIRE CODEBASE THAT WRITES TO THE ESP32 SCHEDULE.
// Requires reloadConfirmed=true in body (server-side validated — not just UI gating).
app.post("/api/rx/confirm/:changeId", async (req, res) => {
  const { changeId } = req.params;
  const { reloadConfirmed, confirmedBy } = req.body as {
    reloadConfirmed: boolean;
    confirmedBy?: string;
  };

  // ── Hard guard: server-side reload confirmation check ─────────────────────
  if (!reloadConfirmed) {
    return res.status(400).json({
      error: "reloadConfirmed must be true. Confirm you have physically reloaded the compartment before proceeding.",
    });
  }

  const change = await getPendingChangeById(changeId);
  if (!change) return res.status(404).json({ error: "Pending change not found" });
  if (change.status !== "pending") {
    return res.status(409).json({ error: `Change is already ${change.status}` });
  }

  // ── Step 1: Fetch the current live ESP32 schedule ─────────────────────────
  let esp32Schedule: Esp32DoseEntry[] = [];

  if (ESP32_BASE_URL) {
    try {
      const r = await fetch(`${ESP32_BASE_URL}/api/schedule`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const data = await r.json();
        esp32Schedule = Array.isArray(data.schedule) ? data.schedule : [];
      }
    } catch (err: any) {
      console.error("[RX CONFIRM] Could not fetch current ESP32 schedule:", err.message);
      return res.status(503).json({ error: "Could not reach ESP32 to read current schedule. Check ESP32_BASE_URL." });
    }
  } else {
    // No ESP32 configured — build from cache
    const cached = await readScheduleCache();
    esp32Schedule = cached.map(c => ({
      hour: c.hour ?? 8,
      minute: c.minute ?? 0,
      compartment: c.compartment,
      label: c.label || "",
      givenToday: c.givenToday ?? false,
    }));
  }

  // ── Step 2: Merge the confirmed change into the schedule ──────────────────
  // Only the target compartment changes; all others are preserved exactly.
  const comp = Number(change.compartment);
  const merged: Esp32DoseEntry[] = esp32Schedule.map(d => {
    if (d.compartment === comp) {
      return {
        ...d,
        label: change.proposedLabel,
        hour: Number(change.proposedHour),
        minute: Number(change.proposedMinute),
        givenToday: false, // reset since compartment is being reloaded
      };
    }
    return d;
  });

  // If this compartment wasn't in the existing schedule, add it
  if (!merged.some(d => d.compartment === comp)) {
    merged.push({
      compartment: comp,
      label: change.proposedLabel,
      hour: Number(change.proposedHour),
      minute: Number(change.proposedMinute),
      givenToday: false,
    });
  }

  // ── Step 3: POST to ESP32 (the single write point) ────────────────────────
  if (ESP32_BASE_URL) {
    try {
      const postRes = await fetch(`${ESP32_BASE_URL}/api/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule: merged }),
        signal: AbortSignal.timeout(8000),
      });
      if (!postRes.ok) {
        const errText = await postRes.text().catch(() => "");
        return res.status(502).json({ error: `ESP32 rejected schedule update (${postRes.status}): ${errText}` });
      }
      console.log(`[RX CONFIRM] ✅ Schedule pushed to ESP32 — compartment ${comp}: "${change.proposedLabel}"`);
    } catch (err: any) {
      return res.status(503).json({ error: `Could not reach ESP32 to push schedule: ${err.message}` });
    }
  } else {
    console.warn("[RX CONFIRM] ESP32_BASE_URL not set — skipping physical push, updating cache only");
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// Startup — Firebase first, then Vite/Express
// ─────────────────────────────────────────────────────────────────────────────
async function setupViteIntegration() {
  if (process.env.NODE_ENV !== "production") {
    console.log("[INFO] Dev mode — Vite middleware active");
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

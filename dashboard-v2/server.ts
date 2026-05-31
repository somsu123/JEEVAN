import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import nodemailer from "nodemailer";
import twilio from "twilio";
import { createServer as createViteServer } from "vite";

dotenv.config();

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

// ─── In-memory state (fall events ring buffer) ───────────────────────────────
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

const fallEventBuffer: FallEventRecord[] = [];

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
    const state = await flaskGet("/api/state");
    return res.json({
      heartRate: state.bpm || 72,
      oxygenSpO2: state.spo2 || 98,
      systolicBP: state.systolic || 120,
      diastolicBP: state.diastolic || 76,
      movementState: state.movement_state || "Resting",
      roomPresence: state.room_presence ?? true,
      isFall: state.is_fall || false,
      fallCount: state.fall_count || 0,
      fallsToday: state.falls_today || 0,
    });
  } catch {
    // Flask might not be running — return sensible defaults
    return res.json({
      heartRate: 72, oxygenSpO2: 98,
      systolicBP: 120, diastolicBP: 76,
      movementState: "Resting", roomPresence: true,
      isFall: false, fallCount: 0, fallsToday: 0,
      _offline: true,
    });
  }
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
setInterval(() => {
  if (braceletStatus.lastSeen) {
    const age = Date.now() - new Date(braceletStatus.lastSeen).getTime();
    if (age > 30_000 && braceletStatus.online) {
      braceletStatus.online = false;
      broadcastSSE("bracelet_offline", { deviceId: braceletStatus.deviceId });
      console.log("[BRACELET] Went offline — no heartbeat for 30s");

      // ── BUG FIX: auto-resolve any active bracelet fall events ─────────────
      // A disconnected bracelet cannot sense falls. Stale "active" events from
      // it should not remain open or re-trigger alerts after a server restart.
      let resolved = 0;
      for (const ev of fallEventBuffer) {
        if (ev.source === "bracelet" && ev.status === "active") {
          ev.status = "resolved";
          ev.resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
          resolved++;
        }
      }
      if (resolved > 0) {
        console.log(`[BRACELET] Auto-resolved ${resolved} stale bracelet fall event(s)`);
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

    fallEventBuffer.unshift(event);
    if (fallEventBuffer.length > 50) fallEventBuffer.pop();

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
    // Merge our buffer with Flask's events if available
    const flaskEvents = await flaskGet("/api/events").catch(() => []);
    return res.json({ events: fallEventBuffer, flaskEvents });
  } catch {
    return res.json({ events: fallEventBuffer, flaskEvents: [] });
  }
});

app.patch("/api/fall-event/:id/resolve", (req, res) => {
  const { id } = req.params;
  const event = fallEventBuffer.find((e) => e.id === id);
  if (!event) return res.status(404).json({ error: "Event not found" });
  event.status = "resolved";
  event.resolvedAt = new Date().toLocaleTimeString("en-US", { hour12: false });
  broadcastSSE("fall_resolved", { id });
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDICINE BOX — proxied from Flask /api/medicine + /api/schedule
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/medicine-schedule", async (_req, res) => {
  try {
    const data = await flaskGet("/api/schedule");
    return res.json(data);
  } catch {
    // Default slots if Flask is offline - empty
    return res.json({
      schedule: [],
      slots: []
    });
  }
});

app.post("/api/medicine-schedule", async (req, res) => {
  try {
    const { slots } = req.body;
    
    // Dynamically persist to local schedule.json database for medbox hardware sync
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
      writeSchedule(doses);
      console.log(`[SYNC] Wrote ${doses.length} doses to schedule.json from medicine-schedule.`);
    }

    const times = (slots || []).map((s: any) => s.scheduledTime).filter(Boolean);
    await flaskPost("/api/schedule", times).catch(() => {});
    
    broadcastSSE("medicine_schedule_updated", { slots });
    // Also broadcast to hardware listeners
    broadcastSSE("schedule_updated", { doses: readSchedule() });
    
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

app.post("/api/medicine-taken", async (req, res) => {
  try {
    const { slotId, lidOpen, touchVerified } = req.body;
    
    // Update local schedule.json taken status
    if (slotId && typeof slotId === 'string') {
      const parts = slotId.split('-');
      // ID format is slot-boxNumber-time or scanned-index-timestamp
      let boxNumber = 1;
      let matched = false;
      
      if (parts[0] === 'slot' && parts[1]) {
        boxNumber = parseInt(parts[1], 10) || 1;
        matched = true;
      }
      
      const schedule = readSchedule();
      const updatedSchedule = schedule.map((dose) => {
        // If matched by boxNumber and not already taken
        if (matched && Number(dose.boxNumber) === boxNumber && !dose.taken) {
          dose.taken = true;
          dose.takenAt = new Date().toLocaleTimeString("en-US", { hour12: false });
        } else if (!matched && dose.medicine.toLowerCase() === slotId.toLowerCase() && !dose.taken) {
          // Fallback matching by name
          dose.taken = true;
          dose.takenAt = new Date().toLocaleTimeString("en-US", { hour12: false });
        }
        return dose;
      });
      
      writeSchedule(updatedSchedule);
      console.log(`[SYNC] Marked box ${boxNumber} as TAKEN in schedule.json via medicine-taken.`);
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

    const summaryText = overviewSection + metricsSection + actionsSection + questionsSection + disclaimerSection;

    // Automatically save the scanned report AND the raw extracted schema fields to MongoDB Atlas via Flask
    try {
      await flaskPost("/api/reports/save", {
        fileName: fileName || "unnamed document",
        summary: summaryText,
        scanDate: new Date().toLocaleTimeString("en-US", { hour12: false }) + " — " + new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
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

// ── File paths for JSON persistence ──────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const EVENTS_FILE   = path.join(DATA_DIR, "events.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

interface DoseEntry {
  time: string;
  medicine: string;
  dosage: string;
  boxNumber: number;
  taken: boolean;
  takenAt?: string;
  missed?: boolean;
}

function readSchedule(): DoseEntry[] {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8")) as DoseEntry[];
    }
  } catch { /* ignore corrupt file */ }
  // Default schedule - empty
  return [];
}

function writeSchedule(doses: DoseEntry[]) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(doses, null, 2));
}

function appendEvent(entry: object) {
  let events: object[] = [];
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      events = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  events.unshift({ ...entry, loggedAt: new Date().toISOString() });
  if (events.length > 200) events = events.slice(0, 200); // keep last 200
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
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

// ── Helper: next dose time ────────────────────────────────────────────────────
function getNextDoseTime(): string {
  const schedule = readSchedule();
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
    // 1. Fetch active medicines from MongoDB (via Flask API)
    const data = await flaskGet("/api/medicines");
    
    if (data && Array.isArray(data.medicines) && data.medicines.length > 0) {
      const dbMeds = data.medicines;
      
      // 2. Sort by addedAt descending to get the most recent ones first
      const sortedMeds = [...dbMeds].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      
      // 3. Take up to 2 most recent medicines to map to Box 1 and Box 2
      const mappedMeds = sortedMeds.slice(0, 2);
      
      // 4. Read today's intake completion records from schedule.json to merge taken/missed statuses
      const localSchedule = readSchedule();
      
      const doses: DoseEntry[] = [];
      
      mappedMeds.forEach((med, index) => {
        const boxNumber = (index + 1) as 1 | 2;
        const times = Array.isArray(med.times) && med.times.length > 0 ? med.times : ["08:00"];
        
        times.forEach((t: string) => {
          // Check if this specific dose (medicine name + time + box) is already recorded today
          const match = localSchedule.find(
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
      
      // 5. Dynamic schedule successfully mapped from database
      console.log(`[SYNC] Dynamic schedule compiled from MongoDB: ${doses.length} doses mapped for ${mappedMeds.length} medicines.`);
      return res.json({ deviceId: "medbox-01", doses });
    }
    
    throw new Error("No medicines found in database");
  } catch (err: any) {
    console.warn(`[SYNC] MongoDB schedule fetch failed (${err.message}). Falling back to local schedule.json`);
    const doses = readSchedule();
    return res.json({ deviceId: "medbox-01", doses });
  }
});

// ── POST /api/medication/schedule (caregiver sets/updates schedule) ──────────
app.post(["/api/medication/schedule", "/api/medication/schedule-esp"], (req, res) => {
  try {
    const { doses } = req.body as { doses: DoseEntry[] };
    if (!Array.isArray(doses)) return res.status(400).json({ error: "doses array required" });
    writeSchedule(doses);
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
app.post("/api/hardware/medbox-event", (req, res) => {
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
    
    // Log to events database/JSON
    appendEvent({
      event,
      boxNumber: box,
      medicine,
      dosage,
      timestamp,
      deviceId
    });

    // Auto-update taken state in schedule.json
    const schedule = readSchedule();
    let updated = false;

    // Standardize comparison by extracting HH:MM from timestamp
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
      writeSchedule(updatedSchedule);
      // Broadcast schedule change to React UI via SSE
      broadcastSSE("schedule_updated", { doses: updatedSchedule });
      // Also broadcast specific taken status to animate slots in dashboard
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

/** Helper: build a rich patient data snapshot from all MongoDB sources via Flask */
async function buildPatientSnapshot() {
  const [heartRes, medRes, eventsRes, reportsRes] = await Promise.allSettled([
    flaskGet("/api/heartrate/history?limit=120"),
    flaskGet("/api/medicines"),
    flaskGet("/api/events"),
    flaskGet("/api/reports"),
  ]);

  const bpmHistory: Array<{ bpm: number; timestamp: number }> =
    heartRes.status === "fulfilled" ? (heartRes.value.history || []) : [];
  const medicines: any[] =
    medRes.status === "fulfilled" ? (medRes.value.medicines || []) : [];
  const events: any[] =
    eventsRes.status === "fulfilled" ? (Array.isArray(eventsRes.value) ? eventsRes.value : []) : [];
  const reports: any[] =
    reportsRes.status === "fulfilled" ? (reportsRes.value.reports || []) : [];

  // — BPM analytics —
  const bpmVals = bpmHistory.map((b) => b.bpm).filter((v) => v > 0);
  const avgBpm = bpmVals.length ? Math.round(bpmVals.reduce((a, b) => a + b, 0) / bpmVals.length) : null;
  const maxBpm = bpmVals.length ? Math.max(...bpmVals) : null;
  const minBpm = bpmVals.length ? Math.min(...bpmVals) : null;
  const abnormalBpm = bpmVals.filter((v) => v > 100 || v < 50);

  // — Fall analytics (in-memory buffer + DB events) —
  const allFalls = [
    ...fallEventBuffer,
    ...events.filter((e) => e.type === "fall"),
  ];
  const activeFalls = fallEventBuffer.filter((f) => f.status === "active");
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
      activeFalls: activeFalls.length,
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

// ── POST /api/hardware/medbox-event ──────────────────────────────────────────
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

  // 1. Save to events.json log file
  appendEvent({ event, box, medicine, dosage, timestamp, deviceId: deviceId || "medbox-01" });

  // 2. Update matching slot in schedule.json
  const schedule = readSchedule();
  const slot = schedule.find((d) => d.boxNumber === box);
  if (slot) {
    if (event === "DOSE_TAKEN") {
      slot.taken = true;
      slot.takenAt = timestamp || new Date().toLocaleTimeString("en-US", { hour12: false });
      slot.missed = false;
    } else {
      slot.missed = true;
    }
    writeSchedule(schedule);
  }

  // 3. If event === "DOSE_MISSED", trigger Gmail alert
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

  // Automatically save medbox event to MongoDB Atlas Database
  try {
    const severity = event === "DOSE_TAKEN" ? "info" : "warning";
    const msg = event === "DOSE_TAKEN"
      ? `Medication taken: ${medicine || slot?.medicine || "Unknown"} (Box ${box})`
      : `Medication missed: ${medicine || slot?.medicine || "Unknown"} (Box ${box})`;
    
    await flaskPost("/api/events/log", {
      type: "medicine",
      message: msg,
      severity: severity
    });
    console.log(`[DB] Medbox event successfully logged to database: ${msg}`);
  } catch (dbErr: any) {
    console.error("[WARN] Failed to log medbox event to database:", dbErr?.message);
  }

  console.log(`[MEDBOX] ${event} — Box ${box} (${medicine}) @ ${timestamp}`);
  return res.json({ received: true });
});

// ── POST /api/hardware/heartbeat ──────────────────────────────────────────────
app.post("/api/hardware/heartbeat", (req, res) => {
  const { deviceId, state, presenceDetected, nextDoseTime, uptime } = req.body as {
    deviceId?: string;
    state?: string;
    presenceDetected?: boolean;
    nextDoseTime?: string;
    uptime?: number;
  };

  // Update last-seen timestamp for this device
  medboxStatus.lastSeen        = new Date().toISOString();
  medboxStatus.state           = state || "IDLE";
  medboxStatus.presenceDetected = presenceDetected ?? false;
  medboxStatus.nextDoseTime    = nextDoseTime || getNextDoseTime();
  medboxStatus.uptime          = uptime ?? 0;
  medboxStatus.deviceId        = deviceId || "medbox-01";
  medboxStatus.online          = true; // marked offline if no heartbeat in 30s

  broadcastSSE("medbox_heartbeat", medboxStatus);
  return res.json({ status: "ok", nextDose: medboxStatus.nextDoseTime });
});

// ── GET /api/medbox-status  (dashboard polling fallback) ─────────────────────
app.get("/api/medbox-status", (_req, res) => {
  return res.json(medboxStatus);
});

// ── Hardware Simulation Mode ──────────────────────────────────────────────────
if (process.env.VITE_HARDWARE_MODE === "simulated") {
  console.log("[SIM] Hardware simulation mode active — firing fake medbox events");

  const simStates: MedboxStatusRecord["state"][] = ["IDLE", "REMINDER", "DISPENSING", "CONFIRMED"];
  let simStateIdx = 0;

  // Simulated heartbeat every 10 s
  setInterval(() => {
    medboxStatus.lastSeen         = new Date().toISOString();
    medboxStatus.state            = simStates[simStateIdx % simStates.length];
    medboxStatus.online           = true;
    medboxStatus.presenceDetected = Math.random() > 0.5;
    medboxStatus.nextDoseTime     = getNextDoseTime();
    medboxStatus.uptime           = (medboxStatus.uptime || 0) + 10;
    simStateIdx++;
    broadcastSSE("medbox_heartbeat", medboxStatus);
  }, 10_000);

  // Simulated DOSE_TAKEN / DOSE_MISSED every 3–8 minutes
  const fireRandomEvent = () => {
    const schedule = readSchedule();
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

      // Run through the same real handler logic
      appendEvent(payload);
      if (eventType === "DOSE_TAKEN") {
        dose.taken  = true;
        dose.takenAt = payload.timestamp;
      } else {
        dose.missed = true;
      }
      writeSchedule(schedule);
      broadcastSSE(eventType === "DOSE_TAKEN" ? "medicine_taken" : "medicine_missed", payload);
      console.log(`[SIM] ${eventType} — Box ${dose.boxNumber} (${dose.medicine})`);
    }

    // Schedule next event in 3–8 minutes
    const nextMs = (Math.random() * 5 + 3) * 60_000;
    setTimeout(fireRandomEvent, nextMs);
  };

  // First sim event after 30 seconds
  setTimeout(fireRandomEvent, 30_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite Integration
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

setupViteIntegration().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});

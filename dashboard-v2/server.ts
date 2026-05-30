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
// Raw body parser for WAV audio uploads from ESP32-S3
app.use("/api/voice-assistant/audio", express.raw({ type: "audio/wav", limit: "2mb" }));


// CORS for development
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ─── Gemini SDK ───────────────────────────────────────────────────────────────
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;

if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { "User-Agent": "eldercare-dashboard-v2" } },
  });
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

// Mark bracelet offline if no heartbeat for 30 s
setInterval(() => {
  if (braceletStatus.lastSeen) {
    const age = Date.now() - new Date(braceletStatus.lastSeen).getTime();
    if (age > 30_000 && braceletStatus.online) {
      braceletStatus.online = false;
      broadcastSSE("bracelet_offline", { deviceId: braceletStatus.deviceId });
      console.log("[BRACELET] Went offline — no heartbeat for 30s");
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
// VOICE ASSISTANT — ESP32-S3 Hardware Integration
// ─────────────────────────────────────────────────────────────────────────────

// In-memory voice assistant status
const vaStatus = {
  online:     false,
  lastSeen:   "",
  state:      "IDLE",
  deviceId:   "voice-assistant-01",
  uptime:     0,
  queryCount: 0,
};

// Auto-offline if no heartbeat for 30s
setInterval(() => {
  if (vaStatus.lastSeen) {
    const age = Date.now() - new Date(vaStatus.lastSeen).getTime();
    if (age > 30_000 && vaStatus.online) {
      vaStatus.online = false;
      broadcastSSE("voice_assistant_offline", { deviceId: vaStatus.deviceId });
      console.log("[VA] Voice assistant went offline");
    }
  }
}, 15_000);

// POST /api/voice-assistant/audio
// Receives raw WAV from ESP32-S3, sends to Gemini, returns { reply }
app.post("/api/voice-assistant/audio", async (req, res) => {
  try {
    if (!ai) return res.status(500).json({ error: "Gemini AI not configured. Set GEMINI_API_KEY in .env" });

    // req.body is a Buffer thanks to express.raw() middleware above
    const wavBuffer: Buffer = req.body as Buffer;

    if (!wavBuffer || wavBuffer.length < 100) {
      return res.status(400).json({ error: "Audio too short or missing" });
    }

    console.log(`[VA] Received ${wavBuffer.length} bytes WAV audio`);

    // Base64 encode for Gemini inline audio
    const audioBase64 = wavBuffer.toString("base64");

    const systemPrompt = `You are MITRA, a warm, patient AI health companion for elderly patients.
Keep responses SHORT (2-3 sentences) since they will be spoken aloud.
Do NOT use markdown, bullet points, or special characters.
Speak naturally, like a caring family member.
If you hear nothing clear, kindly ask them to speak again.
Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
Time: ${new Date().toLocaleTimeString("en-US", { hour12: true })}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [
          { inlineData: { mimeType: "audio/wav", data: audioBase64 } },
          { text: "Please listen to this audio carefully and respond helpfully as MITRA." },
        ],
      },
      config: { systemInstruction: systemPrompt },
    });

    const reply = response.text?.trim() || "I am sorry, I could not understand. Please try again.";
    console.log(`[VA] Gemini reply: ${reply.substring(0, 80)}`);

    vaStatus.queryCount++;
    broadcastSSE("voice_assistant_query", { reply: reply.substring(0, 120), deviceId: vaStatus.deviceId });

    return res.json({ reply });
  } catch (err: any) {
    console.error("[VA] Audio error:", err?.message);
    return res.status(500).json({ error: err?.message || "Audio processing failed" });
  }
});


// POST /api/voice-assistant/heartbeat
app.post("/api/voice-assistant/heartbeat", (req, res) => {
  const { deviceId, state, uptime } = req.body as {
    deviceId?: string;
    state?: string;
    uptime?: number;
  };
  vaStatus.online   = true;
  vaStatus.lastSeen = new Date().toISOString();
  vaStatus.state    = state ?? "IDLE";
  vaStatus.uptime   = uptime ?? 0;
  vaStatus.deviceId = deviceId ?? "voice-assistant-01";
  broadcastSSE("voice_assistant_heartbeat", vaStatus);
  return res.json({ status: "ok" });
});

// POST /api/voice-assistant/event
app.post("/api/voice-assistant/event", (req, res) => {
  const { event, deviceId } = req.body as { event?: string; deviceId?: string };
  broadcastSSE("voice_assistant_event", { event, deviceId, ts: new Date().toISOString() });
  console.log(`[VA] Event: ${event} from ${deviceId}`);
  return res.json({ received: true });
});

// GET /api/voice-assistant/status
app.get("/api/voice-assistant/status", (_req, res) => {
  return res.json(vaStatus);
});

// ── Pending-Speak Queue — ESP32-S3 polls this to get medicine reminder text ──
// ESP32 cannot receive SSE. Instead it polls this endpoint every 30s.
// When a medicine reminder fires, the text is queued here.
const pendingSpeakQueue: Array<{ text: string; priority: string; queuedAt: string }> = [];

// GET /api/voice-assistant/pending-speak — ESP32 polls this, gets next queued message
app.get("/api/voice-assistant/pending-speak", (_req, res) => {
  if (pendingSpeakQueue.length === 0) {
    return res.json({ hasPending: false });
  }
  const next = pendingSpeakQueue.shift()!;  // pop oldest first
  console.log(`[VA] Delivering queued speak: ${next.text.substring(0, 60)}`);
  return res.json({ hasPending: true, text: next.text, priority: next.priority });
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
      source: body.source || "camera",
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
    // Default slots if Flask is offline
    return res.json({
      schedule: ["08:00", "13:00", "20:00"],
      slots: [
        { id: "slot-1", slotNumber: 1, medicineName: "Lisinopril", dosage: "10mg", scheduledTime: "08:00", taken: false, presenceConfirmed: false, touchVerified: false },
        { id: "slot-2", slotNumber: 2, medicineName: "Metformin", dosage: "500mg", scheduledTime: "13:00", taken: false, presenceConfirmed: false, touchVerified: false },
        { id: "slot-3", slotNumber: 3, medicineName: "Aspirin", dosage: "75mg", scheduledTime: "20:00", taken: false, presenceConfirmed: false, touchVerified: false },
      ]
    });
  }
});

app.post("/api/medicine-schedule", async (req, res) => {
  try {
    const { slots } = req.body;
    const times = (slots || []).map((s: any) => s.scheduledTime).filter(Boolean);
    await flaskPost("/api/schedule", times);
    broadcastSSE("medicine_schedule_updated", { slots });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

app.post("/api/medicine-taken", async (req, res) => {
  try {
    const { slotId, lidOpen, touchVerified } = req.body;
    await flaskPost("/api/medicine", {
      lid_open: lidOpen ?? true,
      reminder_triggered: false,
    });
    broadcastSSE("medicine_taken", { slotId });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

app.get("/api/medicine-state", async (_req, res) => {
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

      // 2. Send speak command: SSE (for dashboard) + queue (for ESP32 polling)
      broadcastSSE("voice_speak", { text: speakText, priority: "high" });
      if (pendingSpeakQueue.length < 5) {  // cap queue size
        pendingSpeakQueue.push({ text: speakText, priority: "high", queuedAt: now.toISOString() });
      }

      console.log(`[REMINDER] ${speakText}`);
    }
  } catch (err: any) {
    console.error("[REMINDER] Cron error:", err?.message);
  }
}, 60_000);

app.post("/api/scan-report", async (req, res) => {
  try {
    const { fileData, mimeType, fileName } = req.body;
    if (!fileData) return res.status(400).json({ error: "Missing fileData" });
    if (!ai) return res.status(500).json({ error: "Gemini AI not initialized. Configure GEMINI_API_KEY." });

    const filePart = { inlineData: { mimeType: mimeType || "image/jpeg", data: fileData } };

    // ── Call 1: Patient-friendly summary (existing behaviour) ──────────────
    const summaryPrompt = {
      text: `You are an expert senior geriatric healthcare consultant and medical analyst named AI_CARE.
Analyze this clinical report or medical document carefully.
Provide a highly empathetic, clear, patient-friendly summary for an elderly patient.
Format the output with rich Markdown structure, including:
1. **Document Overview** (with file name: ${fileName || "unnamed document"})
2. **Key Metrics & Readings** (highlighting any abnormal or concerning status)
3. **Action Items & Lifestyle Recommendations** (written in highly encouraging and reassuring language)
4. **Questions to Ask your Doctor** (so the patient is empowered for their next care visit)

Keep medical jargon explained in plain, humble, reassuring terminology.
If there is nothing critical, emphasize that they are doing wonderfully.
Always add a disclaimer at the bottom that this is an AI-assisted analysis and they should consult their personal physician.`,
    };

    const summaryResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: { parts: [filePart, summaryPrompt] },
    });
    const summary = summaryResponse.text || "No summary generated.";

    // ── Call 2: Medicine extraction (structured JSON) ──────────────────────
    const extractPrompt = {
      text: `Look at this prescription or medical document carefully.
Extract ALL medicines prescribed. For each medicine return a JSON array.
Each item must have:
  - "name": medicine name (string, e.g. "Lisinopril")
  - "dosage": strength/dose (string, e.g. "10mg" or "1 tablet")
  - "purpose": what it treats (string, e.g. "Blood pressure")
  - "times": array of 24h times when to take it (e.g. ["08:00"] or ["08:00","20:00"])
    Convert "morning" → "08:00", "afternoon/lunch" → "13:00", "evening" → "18:00", "night/bedtime" → "21:00"
    If once daily and time not specified → ["08:00"]
    If twice daily → ["08:00","20:00"]
    If three times daily → ["08:00","13:00","20:00"]

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.
If no medicines are found, return an empty array: []

Example output:
[{"name":"Metformin","dosage":"500mg","purpose":"Blood sugar control","times":["08:00","20:00"]},{"name":"Aspirin","dosage":"75mg","purpose":"Heart protection","times":["08:00"]}]`,
    };

    let extractedMedicines: Array<{ name: string; dosage: string; purpose: string; times: string[] }> = [];
    try {
      const extractResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: { parts: [filePart, extractPrompt] },
      });
      let raw = extractResponse.text?.trim() || "[]";
      // Strip markdown fences if Gemini adds them
      raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/,"").trim();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) extractedMedicines = parsed;
    } catch (e) {
      console.warn("[SCAN] Medicine extraction JSON parse failed:", e);
    }

    // ── Save to MongoDB via Flask ──────────────────────────────────────────
    const scanDate = new Date().toLocaleString("en-IN", {
      dateStyle: "medium", timeStyle: "short", hour12: true,
    });

    let savedToDb = false;
    let reportId = "";
    let medicinesSaved: string[] = [];

    try {
      const saveResult = await flaskPost("/api/reports/save", {
        fileName:  fileName || "unnamed",
        summary,
        medicines: extractedMedicines,
        scanDate,
      });
      savedToDb      = true;
      reportId       = saveResult.reportId || "";
      medicinesSaved = saveResult.medicinesSaved || [];
      console.log(`[SCAN] Saved report ${reportId} with ${medicinesSaved.length} medicines`);
    } catch (e: any) {
      console.warn("[SCAN] MongoDB save failed (Flask offline?):", e?.message);
    }

    // ── Broadcast SSE so dashboard updates ────────────────────────────────
    if (extractedMedicines.length > 0) {
      broadcastSSE("medicines_extracted", { medicines: extractedMedicines, source: "scan" });
    }

    return res.json({
      success: true,
      summary,
      extractedMedicines,
      savedToDb,
      reportId,
      medicinesSaved,
    });
  } catch (error: any) {
    console.error("Scan error:", error);
    return res.status(500).json({ error: error?.message || "Internal error during scan." });
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

// POST /api/voice-assistant/speak — trigger ESP32-S3 to speak a text (SSE + queue)
app.post("/api/voice-assistant/speak", (req, res) => {
  const { text, priority } = req.body as { text: string; priority?: string };
  if (!text) return res.status(400).json({ error: "text required" });
  const prio = priority || "normal";
  broadcastSSE("voice_speak", { text, priority: prio });
  if (pendingSpeakQueue.length < 5) {
    pendingSpeakQueue.push({ text, priority: prio, queuedAt: new Date().toISOString() });
  }
  console.log(`[VA] Speak queued: ${text.substring(0, 60)}`);
  return res.json({ sent: true, queued: pendingSpeakQueue.length });
});

// GET /api/voice-assistant/tts-pcm — fetches TTS audio and proxies raw bytes to ESP32
// ESP32 calls this with ?text=... and receives the audio bytes to write to I2S speaker
app.get("/api/voice-assistant/tts-pcm", async (req, res) => {
  const text = (req.query.text as string || "").replace(/\+/g, " ").trim();
  if (!text) return res.status(400).send("text required");

  try {
    const encoded = encodeURIComponent(text);
    // Use Google Translate TTS — returns MP3 audio
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encoded}`;
    const ttsRes = await fetch(ttsUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });

    if (!ttsRes.ok) {
      console.error(`[TTS] Google TTS failed: ${ttsRes.status}`);
      return res.status(502).send("TTS upstream error");
    }

    // Stream the MP3/audio bytes directly to ESP32
    // ESP32 will play these bytes on the MAX98357 speaker
    res.setHeader("Content-Type", "audio/mpeg");
    const ttsBuffer = Buffer.from(await ttsRes.arrayBuffer());
    console.log(`[TTS] Sending ${ttsBuffer.length} bytes TTS audio for: "${text.substring(0, 40)}"`);
    return res.send(ttsBuffer);
  } catch (err: any) {
    console.error("[TTS] Proxy error:", err?.message);
    return res.status(500).send("TTS error");
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// VOICE ASSISTANT — Gemini conversational AI for elderly care
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/voice-chat", async (req, res) => {
  try {
    const { message, history, patientContext } = req.body;
    if (!message) return res.status(400).json({ error: "message is required" });
    if (!ai) return res.status(500).json({ error: "Gemini AI not initialized. Configure GEMINI_API_KEY." });

    const systemPrompt = `You are MITRA, a warm, patient, and deeply empathetic AI health companion for elderly patients.
You are speaking with ${patientContext?.name || "Arthur Pendelton"}, who is ${patientContext?.age || "82"} years old.
${patientContext?.recentReports ? `Recent medical notes: ${patientContext.recentReports}` : ""}

Your role:
- Answer health questions in plain, kind language — no complex medical jargon
- Give age-appropriate lifestyle tips (diet, gentle exercise, hydration, sleep hygiene)
- Help them understand their medications, remind about doses and safety
- Be warm, encouraging, and never alarming — they may be anxious
- Keep responses concise (2-4 sentences unless detail is requested)
- If they describe a MEDICAL EMERGENCY (chest pain, can't breathe, collapse), IMMEDIATELY tell them to call 112 or 911
- Never diagnose — recommend professional consultation for clinical concerns
- Remember you are on an IoT elderly care dashboard connected to real sensors

Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
Current time: ${new Date().toLocaleTimeString("en-US", { hour12: true })}`;

    const messages: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    if (Array.isArray(history)) {
      for (const msg of history.slice(-10)) {
        if (msg.role === "user") {
          messages.push({ role: "user", parts: [{ text: msg.content }] });
        } else if (msg.role === "assistant") {
          messages.push({ role: "model", parts: [{ text: msg.content }] });
        }
      }
    }
    messages.push({ role: "user", parts: [{ text: message }] });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: messages,
      config: { systemInstruction: systemPrompt },
    });

    return res.json({ success: true, reply: response.text || "I'm sorry, I couldn't generate a response." });
  } catch (err: any) {
    console.error("Voice chat error:", err);
    return res.status(500).json({ error: err?.message || "Failed to get AI response." });
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
  // Default schedule
  return [
    { time: "08:00", medicine: "Lisinopril", dosage: "10mg",   boxNumber: 1, taken: false },
    { time: "14:00", medicine: "Vitamin D",  dosage: "1000IU", boxNumber: 2, taken: false },
    { time: "20:00", medicine: "Aspirin",    dosage: "81mg",   boxNumber: 3, taken: false },
  ];
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
app.get("/api/medication/schedule", (_req, res) => {
  // Return today's schedule for the device — reads from schedule.json
  const doses = readSchedule();
  return res.json({ deviceId: "medbox-01", doses });
});

// ── POST /api/medication/schedule  (caregiver sets/updates schedule) ──────────
app.post("/api/medication/schedule-esp", (req, res) => {
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

/**
 * ============================================================
 *  server.js — JEEVAN BPM + SpO₂ Backend Server
 * ============================================================
 *  Architecture:
 *
 *   ESP32 ──ws://──→ Express/ws ──Socket.IO──→ Dashboard(s)
 *
 *  • Raw WebSocket on /ws/esp32  — receives vitals from ESP32
 *  • Socket.IO on same HTTP server — pushes to dashboards
 *  • REST endpoints for history, status, health
 *  • WebSocket heartbeat: ping every 10 s, kill dead in 15 s
 * ============================================================
 */

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const cors      = require('cors');
const { Server: SocketIOServer } = require('socket.io');
const { WebSocketServer }        = require('ws');
const bpmStore     = require('./bpmStore');
const { validateBpmPayload } = require('./validation');

// ─── Config ─────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT, 10) || 3001;
const WS_PING_MS  = 10000;   // ping ESP32 every 10 s
const WS_DEAD_MS  = 15000;   // kill if silent > 15 s

// ─── Express App ────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Get last N vitals readings
app.get('/api/bpm/history', (req, res) => {
  const n = Math.min(parseInt(req.query.n, 10) || 60, 300);
  res.json({ history: bpmStore.getHistory(n), stats: bpmStore.getStats() });
});

// Get current system status
app.get('/api/bpm/status', (_req, res) => {
  res.json(bpmStore.getStatus());
});

// ─── HTTP Server ────────────────────────────────────────────
const server = http.createServer(app);

// ─── Socket.IO — dashboard clients ─────────────────────────
const io = new SocketIOServer(server, {
  cors:         { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout:  5000,
});

let dashboardClients = 0;

io.on('connection', (socket) => {
  dashboardClients++;
  console.log(`[Socket.IO] Dashboard connected (${dashboardClients} total)`);

  // Send current status immediately on connect
  socket.emit('bpm:status', bpmStore.getStatus());

  // Hydrate chart with recent history
  socket.emit('bpm:history', bpmStore.getHistory(60));

  socket.on('disconnect', () => {
    dashboardClients--;
    console.log(`[Socket.IO] Dashboard disconnected (${dashboardClients} total)`);
  });
});

// ─── Helper: mark ESP32 offline and notify dashboards ───────
function markEspOffline(reason) {
  if (bpmStore.espConnected) {
    console.log(`[WS] ESP32 marked OFFLINE — ${reason}`);
    bpmStore.setEspConnected(false);
    io.emit('esp:connected', false);
  }
}

// ─── Raw WebSocket — ESP32 ──────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] ESP32 connected from ${ip}`);
  bpmStore.setEspConnected(true);
  io.emit('esp:connected', true);

  // ── Per-connection heartbeat state ──────────────────────
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;   // device responded to our ping
  });

  // ── Heartbeat interval: ping every WS_PING_MS ───────────
  const heartbeat = setInterval(() => {
    if (!ws.isAlive) {
      // No pong received since last ping → connection is dead
      clearInterval(heartbeat);
      markEspOffline('heartbeat timeout (no pong)');
      ws.terminate();
      return;
    }
    ws.isAlive = false;  // reset; will be set true on pong
    ws.ping();
  }, WS_PING_MS);

  // ── Data handler ─────────────────────────────────────────
  ws.on('message', (raw) => {
    const text = raw.toString();
    console.log(`[WS] ← RAW: ${text.substring(0, 120)}`);   // ← log every packet

    try {
      const data = JSON.parse(text);
      const { valid, cleaned, error } = validateBpmPayload(data);

      if (!valid) {
        console.warn(`[WS] ✗ Invalid payload: ${error} | raw: ${text.substring(0, 80)}`);
        return;
      }

      // Store and broadcast
      bpmStore.push(cleaned);
      io.emit('bpm:data', cleaned);
      console.log(`[WS] ✓ BPM=${cleaned.bpm} SpO2=${cleaned.spo2} finger=${cleaned.fingerDetected} signal=${cleaned.signal}`);

    } catch (err) {
      console.warn(`[WS] ✗ JSON parse error: ${err.message} | raw: ${text.substring(0, 80)}`);
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    console.log(`[WS] ESP32 disconnected from ${ip} (code=${code})`);
    markEspOffline('clean close');
  });

  ws.on('error', (err) => {
    clearInterval(heartbeat);
    console.error(`[WS] ESP32 error: ${err.message}`);
    markEspOffline(`error: ${err.message}`);
  });
});

// ─── Upgrade handler — route /ws/esp32 to raw WS ───────────
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === '/ws/esp32') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── Start ──────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   JEEVAN Server v2.0                             ║');
  console.log(`║   HTTP + Socket.IO : http://0.0.0.0:${PORT}         ║`);
  console.log(`║   ESP32 WebSocket  : ws://0.0.0.0:${PORT}/ws/esp32  ║`);
  console.log('║   Metrics: BPM + SpO₂ (MAX30102)                 ║');
  console.log(`║   Heartbeat: ping ${WS_PING_MS/1000}s / dead ${WS_DEAD_MS/1000}s           ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();
});

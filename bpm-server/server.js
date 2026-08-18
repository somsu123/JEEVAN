/**
 * ============================================================
 *  server.js — BPM + SpO₂ Backend Server
 * ============================================================
 *  Architecture:
 *
 *   ESP32 ──ws://──→ Express/ws ──Socket.IO──→ Dashboard(s)
 *
 *  • Raw WebSocket on /ws/esp32  — receives vitals from ESP32
 *  • Socket.IO on same HTTP server — pushes to dashboards
 *  • REST endpoints for history, status, health
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
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// ─── Express App ────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));   // allow all origins (local LAN access)
app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Get last N vitals readings (BPM + SpO₂)
app.get('/api/bpm/history', (req, res) => {
  const n = Math.min(parseInt(req.query.n, 10) || 60, 300);
  res.json({
    history: bpmStore.getHistory(n),
    stats:   bpmStore.getStats(),
  });
});

// Get current system status
app.get('/api/bpm/status', (_req, res) => {
  res.json(bpmStore.getStatus());
});

// ─── HTTP Server ────────────────────────────────────────────
const server = http.createServer(app);

// ─── Socket.IO — dashboard clients ─────────────────────────
const io = new SocketIOServer(server, {
  cors:          { origin: '*', methods: ['GET', 'POST'] },
  pingInterval:  10000,
  pingTimeout:   5000,
});

let dashboardClients = 0;

io.on('connection', (socket) => {
  dashboardClients++;
  console.log(`[Socket.IO] Dashboard connected (${dashboardClients} total)`);

  // Send current status immediately on connect
  socket.emit('bpm:status', bpmStore.getStatus());

  // Send recent history so the chart hydrates instantly
  socket.emit('bpm:history', bpmStore.getHistory(60));

  socket.on('disconnect', () => {
    dashboardClients--;
    console.log(`[Socket.IO] Dashboard disconnected (${dashboardClients} total)`);
  });
});

// ─── Raw WebSocket — ESP32 ──────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] ESP32 connected from ${ip}`);
  bpmStore.setEspConnected(true);

  // Notify dashboards
  io.emit('esp:connected', true);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const { valid, cleaned, error } = validateBpmPayload(data);

      if (!valid) {
        console.warn(`[WS] Invalid payload: ${error}`);
        return;
      }

      // Store
      bpmStore.push(cleaned);

      // Broadcast vitals (bpm + spo2 + all fields) to all dashboards
      io.emit('bpm:data', cleaned);

    } catch (err) {
      console.warn(`[WS] Parse error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] ESP32 disconnected from ${ip}`);
    bpmStore.setEspConnected(false);
    io.emit('esp:connected', false);
  });

  ws.on('error', (err) => {
    console.error(`[WS] ESP32 error: ${err.message}`);
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
  console.log('║   Elder-Care Vitals Server v2.0                  ║');
  console.log(`║   HTTP + Socket.IO : http://0.0.0.0:${PORT}         ║`);
  console.log(`║   ESP32 WebSocket  : ws://0.0.0.0:${PORT}/ws/esp32  ║`);
  console.log('║   Metrics: BPM + SpO₂ (MAX30102)                 ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();
});

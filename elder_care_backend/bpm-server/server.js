/**
 * JEEVAN BPM server.
 * ESP32 raw WebSocket: /ws/esp32
 * Dashboard Socket.IO: default namespace and /socket.io path
 * Dashboard events: bpm:data (vitals schema), bpm:status, bpm:history,
 *                   esp:connected (boolean)
 */
require('dotenv').config();

const http = require('http');
const os = require('os');
const express = require('express');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');
const Bonjour = require('bonjour-service');
const bpmStore = require('./bpmStore');
const { validateBpmPayload } = require('./validation');

const PORT = Number.parseInt(process.env.PORT, 10) || 3001;
const HOST = '0.0.0.0';
const WS_PATH = '/ws/esp32';
const WS_PING_MS = 10000;
const WS_DEAD_MS = 30000;
const REPORT_INTERVAL_MS = 250;
const STALE_DATA_TTL_MS = 3000; // Allow 3s jitter before considering packet stream dead
const STALE_CHECK_MS = 50;
const MAX_WS_PAYLOAD_BYTES = 4096;
// Defaults support both local Vite dashboards; deployments may set a comma-separated list.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();
app.use(cors({ origin: CORS_ORIGINS.length === 1 && CORS_ORIGINS[0] === '*' ? '*' : CORS_ORIGINS }));
app.use(express.json({ limit: '16kb' }));

function healthPayload() {
  const status = bpmStore.getStatus();
  return {
    status: 'ok',
    uptime: process.uptime(),
    espConnected: status.espConnected,
    lastPacketAgeMs: status.lastReceived === null ? null : Date.now() - status.lastReceived,
    websocketPath: WS_PATH,
    socketIoPath: '/socket.io',
  };
}

// Both paths are retained for existing local monitors and the standard probe.
app.get('/health', (_req, res) => res.json(healthPayload()));
app.get('/api/health', (_req, res) => res.json(healthPayload()));

app.get('/api/bpm/history', (req, res) => {
  const requested = Number.parseInt(req.query.n, 10);
  const count = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 300)) : 60;
  res.json({ history: bpmStore.getHistory(count), stats: bpmStore.getStats() });
});

app.get('/api/bpm/status', (_req, res) => res.json(bpmStore.getStatus()));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: CORS_ORIGINS.length === 1 && CORS_ORIGINS[0] === '*' ? '*' : CORS_ORIGINS,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
  pingInterval: 10000,
  pingTimeout: 5000,
});

io.on('connection', (socket) => {
  socket.emit('bpm:status', bpmStore.getStatus());
  socket.emit('bpm:history', bpmStore.getHistory(60));
});

let espSocket = null;
let bonjour = null;
let advertisedService = null;
let isShuttingDown = false;

function emitOffline() {
  io.emit('esp:connected', false);
  io.emit('bpm:status', bpmStore.getStatus());
}

let offlineGraceTimer = null;

function markEspOffline(reason, expectedSocket = null) {
  if (expectedSocket && espSocket !== expectedSocket) return;
  const wasConnected = bpmStore.espConnected;
  if (espSocket && (!expectedSocket || espSocket === expectedSocket)) espSocket = null;
  bpmStore.setEspConnected(false);
  if (wasConnected) {
    console.warn(`[WS] ESP32 offline: ${reason}`);
    if (offlineGraceTimer) clearTimeout(offlineGraceTimer);
    offlineGraceTimer = setTimeout(() => {
      if (!bpmStore.espConnected) {
        emitOffline();
      }
    }, 4000);
  }
}

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

function clearHeartbeat(ws) {
  if (ws.pingTimer) clearInterval(ws.pingTimer);
  if (ws.deadTimer) clearTimeout(ws.deadTimer);
  ws.pingTimer = null;
  ws.deadTimer = null;
}

function armDeadTimer(ws) {
  if (ws.deadTimer) clearTimeout(ws.deadTimer);
  ws.deadTimer = setTimeout(() => {
    if (espSocket !== ws) return;
    markEspOffline('pong timeout', ws);
    ws.terminate();
  }, WS_DEAD_MS);
  ws.deadTimer.unref();
}

wss.on('connection', (ws, request) => {
  const remote = request.socket.remoteAddress || 'unknown';
  if (espSocket) {
    const previousSocket = espSocket;
    markEspOffline('replaced by a newer ESP32 connection', previousSocket);
    if (previousSocket.readyState === WebSocket.OPEN) {
      previousSocket.close(1012, 'replaced by a newer ESP32 connection');
    } else {
      previousSocket.terminate();
    }
  }
  if (offlineGraceTimer) {
    clearTimeout(offlineGraceTimer);
    offlineGraceTimer = null;
  }
  espSocket = ws;
  bpmStore.setEspConnected(true);
  io.emit('esp:connected', true);
  io.emit('bpm:status', bpmStore.getStatus());
  console.log(`[WS] ESP32 connected from ${remote}`);

  armDeadTimer(ws);
  ws.pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, WS_PING_MS);
  ws.pingTimer.unref();

  ws.on('pong', () => armDeadTimer(ws));

  ws.on('message', (raw) => {
    if (espSocket !== ws) return;
    armDeadTimer(ws);
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (error) {
      console.warn(`[WS] Rejected malformed JSON from ${remote}: ${error.message}`);
      return;
    }

    const { valid, cleaned, error } = validateBpmPayload(data);
    if (!valid) {
      console.warn(`[WS] Rejected vitals packet from ${remote}: ${error}`);
      return;
    }

    if (!bpmStore.espConnected) {
      bpmStore.setEspConnected(true);
      io.emit('esp:connected', true);
      io.emit('bpm:status', bpmStore.getStatus());
    }

    bpmStore.push(cleaned);
    // Broadcast schema: validation.js documents every field of bpm:data.
    io.emit('bpm:data', cleaned);
  });

  ws.on('close', (code, reason) => {
    clearHeartbeat(ws);
    console.log(`[WS] ESP32 disconnected from ${remote} (code=${code}, reason=${reason.toString()})`);
    markEspOffline('socket closed', ws);
  });

  ws.on('error', (error) => {
    clearHeartbeat(ws);
    console.error(`[WS] ESP32 socket error from ${remote}: ${error.message}`);
    markEspOffline(`socket error: ${error.message}`, ws);
    ws.terminate();
  });
});

server.on('upgrade', (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
  } catch (_error) {
    socket.destroy();
    return;
  }

  if (pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

// Expire telemetry UI state if no packet arrives within STALE_DATA_TTL_MS
const staleDataTimer = setInterval(() => {
  if (!bpmStore.clearIfStale(Date.now(), STALE_DATA_TTL_MS)) return;
  emitOffline();
}, STALE_CHECK_MS);
staleDataTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`[HTTP] listening on http://${HOST}:${PORT}`);
  console.log(`[WS] ESP32 endpoint ws://${HOST}:${PORT}${WS_PATH}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`[NET] ESP32 can connect to: ws://${net.address}:${PORT}${WS_PATH}`);
      }
    }
  }
  console.log('[Socket.IO] dashboard namespace=/ path=/socket.io; events bpm:data, bpm:status, bpm:history, esp:connected');
  try {
    bonjour = new Bonjour({}, (error) => console.error(`[mDNS] ${error.message}`));
    advertisedService = bonjour.publish({
      name: 'bpm-server',
      type: 'http',
      host: 'bpm-server.local',
      port: PORT,
      disableIPv6: true,
      txt: { websocket: WS_PATH, socketio: '/socket.io' },
    });
    advertisedService.on('error', (error) => console.error(`[mDNS] publish error: ${error.message}`));
    console.log(`[mDNS] advertising bpm-server.local:${PORT} (HTTP service: bpm-server._http._tcp.local)`);
  } catch (error) {
    console.error(`[mDNS] advertisement unavailable: ${error.message}`);
  }
});

// Clear in-memory readings even on an unexpected process exit.
process.on('exit', () => {
  clearInterval(staleDataTimer);
  bpmStore.setEspConnected(false);
});

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SERVER] shutting down (${signal})`);
  markEspOffline('server shutdown');
  clearInterval(staleDataTimer);
  for (const socket of io.sockets.sockets.values()) socket.disconnect(true);
  for (const client of wss.clients) client.close(1001, 'server shutdown');

  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  const closeHttp = () => server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
  if (bonjour) {
    bonjour.unpublishAll(() => bonjour.destroy(closeHttp));
  } else {
    closeHttp();
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

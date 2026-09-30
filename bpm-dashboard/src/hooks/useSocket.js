/**
 * ============================================================
 *  useSocket.js — Socket.IO Custom Hook (BPM + SpO₂)
 * ============================================================
 *  Manages the WebSocket connection to the vitals backend.
 *  Returns live BPM, SpO₂, history, connection states, etc.
 *
 *  Real-time fixes:
 *  - bpm:status fully hydrates lastUpdate + sensorStatus on reconnect
 *  - Local 1-second tick increments uptime between ESP32 messages
 *  - Stats poll seeds lastUpdate from server's lastReceived timestamp
 * ============================================================
 */

import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const MAX_HISTORY = 120; // keep 2 min of chart data

export default function useSocket() {
  const [bpm, setBpm]                   = useState(null);
  const [spo2, setSpo2]                 = useState(null);
  const [history, setHistory]           = useState([]);
  const [isConnected, setIsConnected]   = useState(false);
  const [espConnected, setEspConnected] = useState(false);
  const [sensorStatus, setSensorStatus] = useState({
    fingerDetected: false,
    signal: 'unknown',
    irValue: 0,
    redValue: 0,
    uptime: 0,
  });
  const [lastUpdate, setLastUpdate]     = useState(null);
  const [stats, setStats]               = useState({
    bpm:  { min: 0, max: 0, avg: 0, count: 0 },
    spo2: { min: 0, max: 0, avg: 0, count: 0 },
  });

  const socketRef = useRef(null);

  // ── Local uptime tick ──────────────────────────────────────
  // Increments sensorStatus.uptime by 1 every second so the
  // "Device Uptime" field keeps ticking even between ESP32 packets.
  useEffect(() => {
    const id = setInterval(() => {
      setSensorStatus(prev =>
        prev.uptime > 0 ? { ...prev, uptime: prev.uptime + 1 } : prev
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Connect directly to the backend on port 3001.
    // IMPORTANT: transports must be ['polling', 'websocket'] — polling
    // first so Socket.IO can establish the session via HTTP, then
    // upgrade to WebSocket. Reversing this order causes silent failures
    // when the WS upgrade is proxied or blocked.
    const socket = io('http://localhost:3001', {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socketRef.current = socket;

    // ── Connection events ───────────────────────────────────
    socket.on('connect', () => {
      console.log('[Socket.IO] Connected');
      setIsConnected(true);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket.IO] Disconnected:', reason);
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      console.warn('[Socket.IO] Connection error:', err.message);
    });

    // ── ESP32 connection status ─────────────────────────────
    socket.on('esp:connected', (status) => {
      setEspConnected(status);
      // ⚡ Clear ALL vitals immediately when ESP32 goes offline
      // so the dashboard never shows stale/hardcoded-looking values.
      if (!status) {
        setBpm(null);
        setSpo2(null);
        setLastUpdate(null);
        setSensorStatus({
          fingerDetected: false,
          signal: 'unknown',
          irValue: 0,
          redValue: 0,
          uptime: 0,
        });
      }
    });

    // ── Hydrate chart with history on connect ───────────────
    socket.on('bpm:history', (data) => {
      if (Array.isArray(data)) {
        const formatted = data.map((entry, idx) => ({
          ...entry,
          index: idx,
          time: new Date(entry.timestamp).toLocaleTimeString(),
        }));
        setHistory(formatted.slice(-MAX_HISTORY));
      }
    });

    // ── Server status on connect — full hydration ───────────
    socket.on('bpm:status', (status) => {
      if (!status) return;
      setEspConnected(status.espConnected);

      // Restore sensor status from latest server snapshot
      setSensorStatus(prev => ({
        ...prev,
        fingerDetected: status.fingerDetected ?? prev.fingerDetected,
        signal:         status.signal         ?? prev.signal,
      }));

      // Restore lastUpdate from server's lastReceived timestamp
      if (status.lastReceived) {
        setLastUpdate(new Date(status.lastReceived));
      }

      // Restore BPM / SpO₂ from latest snapshot
      if (status.latestBpm  != null) setBpm(status.latestBpm);
      if (status.latestSpo2 != null && status.latestSpo2 > 0) setSpo2(status.latestSpo2);
    });

    // ── Live vitals data ────────────────────────────────────
    socket.on('bpm:data', (data) => {
      if (!data) return;

      const entry = {
        ...data,
        time: new Date(data.timestamp).toLocaleTimeString(),
      };

      setBpm(data.bpm);
      setSpo2(data.spo2 > 0 ? data.spo2 : null);
      setLastUpdate(new Date(data.timestamp));
      setEspConnected(true);

      setSensorStatus({
        fingerDetected: data.fingerDetected,
        signal:         data.signal   || 'unknown',
        irValue:        data.irValue  || 0,
        redValue:       data.redValue || 0,
        uptime:         data.uptime   || 0,
      });

      setHistory((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
    });

    return () => { socket.disconnect(); };
  }, []);

  // ── Fetch stats periodically (every 5 s) ──────────────────
  useEffect(() => {
    const fetchStats = async () => {
      try {
        // Use Vite proxy path so fetch also goes through the proxy
        const res  = await fetch('/api/bpm/history?n=300');
        const data = await res.json();
        if (data.stats) setStats(data.stats);
      } catch { /* ignore */ }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── Stale-data watchdog (every 3 s) ───────────────────────
  // Safety net: if espConnected is false but stale bpm/spo2 values
  // are still on screen (e.g. device hard-reset without clean WS close),
  // force-clear them so the display is never misleadingly live-looking.
  useEffect(() => {
    const id = setInterval(() => {
      setEspConnected(prev => {
        if (!prev) {
          // espConnected is false — clear any lingering vitals
          setBpm(null);
          setSpo2(null);
          setSensorStatus(s =>
            s.fingerDetected
              ? { fingerDetected: false, signal: 'unknown', irValue: 0, redValue: 0, uptime: 0 }
              : s
          );
        }
        return prev;
      });
    }, 3000);
    return () => clearInterval(id);
  }, []);

  return {
    bpm,
    spo2,
    history,
    isConnected,
    espConnected,
    sensorStatus,
    lastUpdate,
    stats,
  };
}


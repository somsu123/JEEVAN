/**
 * ============================================================
 *  useSocket.js — Socket.IO Custom Hook (BPM + SpO₂)
 * ============================================================
 *  Manages the WebSocket connection to the vitals backend.
 *  Returns live BPM, SpO₂, history, connection states, etc.
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

  useEffect(() => {
    // Connect to backend server
    const socket = io('http://localhost:3001', {
      transports: ['websocket', 'polling'],
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

    // ── Server status on connect ────────────────────────────
    socket.on('bpm:status', (status) => {
      if (status) {
        setEspConnected(status.espConnected);
      }
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

  // Fetch stats periodically (every 5 s)
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res  = await fetch('http://localhost:3001/api/bpm/history?n=300');
        const data = await res.json();
        if (data.stats) setStats(data.stats);
      } catch { /* ignore */ }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
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

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const MAX_HISTORY = 120;
const STALE_AFTER_MS = 4000;
const EMPTY_SENSOR = {
  fingerDetected: false,
  signal: 'unknown',
  irValue: 0,
  redValue: 0,
  uptime: 0,
  sensorError: false,
};
const EMPTY_STATS = {
  bpm: { min: 0, max: 0, avg: 0, count: 0 },
  spo2: { min: 0, max: 0, avg: 0, count: 0 },
};

function formatHistory(entries) {
  return entries.slice(-MAX_HISTORY).map((entry, index) => ({
    ...entry,
    index,
    time: new Date(entry.timestamp || Date.now()).toLocaleTimeString(),
  }));
}

export default function useSocket() {
  const [bpm, setBpm] = useState(null);
  const [spo2, setSpo2] = useState(null);
  const [history, setHistory] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [espConnected, setEspConnected] = useState(false);
  const [isFresh, setIsFresh] = useState(false);
  const [sensorStatus, setSensorStatus] = useState(EMPTY_SENSOR);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [stats, setStats] = useState(EMPTY_STATS);

  useEffect(() => {
    let lastPacketAt = 0;
    let freshnessTimer = null;
    let currentBpm = null;
    let currentSpo2 = null;

    const backendUrl = import.meta.env.VITE_BPM_SERVER_URL || window.location.origin;
    const socket = io(backendUrl, {
      path: '/socket.io',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.5,
    });

    const clearLiveVitals = () => {
      if (freshnessTimer) clearTimeout(freshnessTimer);
      freshnessTimer = null;
      setIsFresh(false);
      setEspConnected(false);
      currentBpm = null;
      currentSpo2 = null;
      setBpm(null);
      setSpo2(null);
      setLastUpdate(null);
      setSensorStatus(EMPTY_SENSOR);
    };

    const armFreshnessGuard = () => {
      if (freshnessTimer) clearTimeout(freshnessTimer);
      freshnessTimer = setTimeout(() => {
        if (lastPacketAt && Date.now() - lastPacketAt > STALE_AFTER_MS) {
          lastPacketAt = 0;
          clearLiveVitals();
        } else if (lastPacketAt) {
          armFreshnessGuard();
        }
      }, Math.max(1, STALE_AFTER_MS - (Date.now() - lastPacketAt) + 1));
    };

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => {
      setIsConnected(false);
      lastPacketAt = 0;
      clearLiveVitals();
    });

    socket.on('esp:connected', (connected) => {
      const online = Boolean(connected);
      setEspConnected(online);
      if (!online) {
        lastPacketAt = 0;
        clearLiveVitals();
      }
    });

    socket.on('bpm:history', (entries) => {
      if (Array.isArray(entries)) setHistory(formatHistory(entries));
    });

    socket.on('bpm:status', (status) => {
      if (!status) return;
      const serverTime = Number(status.lastReceived);
      const ageMs = Number.isFinite(serverTime) ? Date.now() - serverTime : Infinity;
      const fresh = Boolean(status.espConnected && ageMs >= -5000 && ageMs <= STALE_AFTER_MS);
      setEspConnected(fresh);
      setIsFresh(fresh);
      if (!fresh || !status.fingerDetected) {
        lastPacketAt = fresh ? Date.now() - Math.max(0, ageMs) : 0;
        if (fresh) armFreshnessGuard();
        else clearLiveVitals();
        currentBpm = null;
        currentSpo2 = null;
        setBpm(null);
        setSpo2(null);
        setLastUpdate(fresh ? new Date(serverTime) : null);
        setSensorStatus({ ...EMPTY_SENSOR, signal: fresh ? (status.signal || 'unknown') : 'unknown' });
        return;
      }
      lastPacketAt = Date.now() - Math.max(0, ageMs);
      armFreshnessGuard();
      if (status.latestBpm > 0) {
        currentBpm = status.latestBpm;
        setBpm(status.latestBpm);
      }
      if (status.latestSpo2 > 0) {
        currentSpo2 = status.latestSpo2;
        setSpo2(status.latestSpo2);
      }
      setLastUpdate(new Date(serverTime));
      setSensorStatus((previous) => ({ ...previous, fingerDetected: true, signal: status.signal || 'unknown' }));
    });

    socket.on('bpm:data', (data) => {
      if (!data || data.type !== 'vitals') return;
      const receivedAt = Date.now();
      lastPacketAt = receivedAt;
      armFreshnessGuard();
      setEspConnected(true);
      setIsFresh(true);
      setLastUpdate(new Date(receivedAt));

      if (data.fingerDetected) {
        if (data.bpm > 0) {
          currentBpm = data.bpm;
          setBpm(data.bpm);
        } else if (currentBpm) {
          setBpm(currentBpm);
        }
        if (data.spo2 > 0) {
          currentSpo2 = data.spo2;
          setSpo2(data.spo2);
        } else if (currentSpo2) {
          setSpo2(currentSpo2);
        }
      } else {
        currentBpm = null;
        currentSpo2 = null;
        setBpm(null);
        setSpo2(null);
      }

      setSensorStatus({
        fingerDetected: Boolean(data.fingerDetected),
        signal: data.signal || 'unknown',
        irValue: data.irValue || 0,
        redValue: data.redValue || 0,
        uptime: data.uptime || 0,
        sensorError: Boolean(data.sensorError),
      });

      setHistory((previous) => {
        const [entry] = formatHistory([{
          ...data,
          bpm: data.bpm > 0 ? data.bpm : (currentBpm || data.bpm),
          spo2: data.spo2 > 0 ? data.spo2 : (currentSpo2 || data.spo2),
          timestamp: receivedAt
        }]);
        return [...previous, entry].slice(-MAX_HISTORY);
      });
    });

    return () => {
      if (freshnessTimer) clearTimeout(freshnessTimer);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let activeController = null;
    let requestTimeout = null;
    let requestInFlight = false;
    const fetchStats = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      const controller = new AbortController();
      activeController = controller;
      requestTimeout = window.setTimeout(() => controller.abort(), 3000);
      try {
        const backendUrl = import.meta.env.VITE_BPM_SERVER_URL || '';
        const response = await fetch(`${backendUrl}/api/bpm/history?n=300`, { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.stats) setStats(data.stats);
      } catch { /* keep the last server-provided stats during reconnects */ }
      finally {
        clearTimeout(requestTimeout);
        activeController = null;
        requestInFlight = false;
      }
    };

    fetchStats();
    const timer = setInterval(fetchStats, 5000);
    return () => {
      cancelled = true;
      if (requestTimeout) clearTimeout(requestTimeout);
      activeController?.abort();
      clearInterval(timer);
    };
  }, []);

  return {
    bpm,
    spo2,
    history,
    isConnected,
    espConnected,
    isFresh,
    sensorStatus,
    lastUpdate,
    stats,
  };
}

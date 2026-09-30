/**
 * ============================================================
 *  App.jsx — JEEVAN Dashboard (BPM + SpO₂)
 * ============================================================
 *  Layout:
 *   Left column  (4/12) — BpmCard + SpO₂Card + Connection + Sensor
 *   Right column (8/12) — Dual-metric live chart
 * ============================================================
 */

import React, { useState, useEffect } from 'react';
import { Heart, Activity } from 'lucide-react';
import useSocket from './hooks/useSocket.js';
import BpmCard from './components/BpmCard.jsx';
import SpO2Card from './components/SpO2Card.jsx';
import BpmChart from './components/BpmChart.jsx';
import ConnectionStatus from './components/ConnectionStatus.jsx';
import SensorStatus from './components/SensorStatus.jsx';

export default function App() {
  const {
    bpm,
    spo2,
    history,
    isConnected,
    espConnected,
    sensorStatus,
    lastUpdate,
    stats,
  } = useSocket();

  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen p-4 md:p-6 lg:p-8">
      {/* ── Header ────────────────────────────────────────── */}
      <header className="max-w-7xl mx-auto mb-8 animate-fade-in" id="dashboard-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Heart className="w-6 h-6 text-white fill-white" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
                JEEVAN
              </h1>
              <p className="text-sm text-slate-400 mt-0.5">
                Real-time BPM &amp; SpO₂ monitoring · ESP32 + MAX30102
              </p>
            </div>
          </div>

          {/* Live clock */}
          <div className="hidden md:flex items-center gap-3 text-slate-400">
            <Activity className="w-4 h-4" />
            <span className="text-sm tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {currentTime.toLocaleTimeString()}
            </span>
          </div>
        </div>
      </header>

      {/* ── Main Grid ─────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* Left column — cards */}
          <div className="lg:col-span-4 space-y-6">

            {/* BPM Card */}
            <div className="animate-fade-in animate-fade-in-delay-1">
              <BpmCard
                bpm={bpm}
                fingerDetected={sensorStatus.fingerDetected}
                stats={stats.bpm}
              />
            </div>

            {/* SpO₂ Card */}
            <div className="animate-fade-in animate-fade-in-delay-2">
              <SpO2Card
                spo2={spo2}
                fingerDetected={sensorStatus.fingerDetected}
                stats={stats.spo2}
              />
            </div>

            {/* Connection Status */}
            <div className="animate-fade-in animate-fade-in-delay-3">
              <ConnectionStatus
                isConnected={isConnected}
                espConnected={espConnected}
                lastUpdate={lastUpdate}
              />
            </div>

            {/* Sensor Status */}
            <div className="animate-fade-in animate-fade-in-delay-4">
              <SensorStatus sensorStatus={sensorStatus} />
            </div>
          </div>

          {/* Right column — Dual-metric chart */}
          <div className="lg:col-span-8 animate-fade-in animate-fade-in-delay-2">
            <BpmChart history={history} />
          </div>
        </div>
      </main>

      {/* ── Footer ────────────────────────────────────────── */}
      <footer className="max-w-7xl mx-auto mt-12 pb-6 animate-fade-in animate-fade-in-delay-4">
        <div className="flex items-center justify-center gap-2 text-slate-600 text-xs">
          <Heart className="w-3 h-3" />
          <span>Elder-Care Smart Bracelet · ESP32 + MAX30102 · BPM + SpO₂</span>
        </div>
      </footer>
    </div>
  );
}

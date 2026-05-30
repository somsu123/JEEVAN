/**
 * ============================================================
 *  App.jsx — BPM Dashboard Main Layout
 * ============================================================
 *  Assembles all components into a responsive grid layout.
 *  Dark glassmorphism UI with gradient mesh background.
 * ============================================================
 */

import React, { useState, useEffect } from 'react';
import { Heart, Activity } from 'lucide-react';
import useSocket from './hooks/useSocket.js';
import BpmCard from './components/BpmCard.jsx';
import BpmChart from './components/BpmChart.jsx';
import ConnectionStatus from './components/ConnectionStatus.jsx';
import SensorStatus from './components/SensorStatus.jsx';

export default function App() {
  const {
    bpm,
    history,
    isConnected,
    espConnected,
    sensorStatus,
    lastUpdate,
    stats,
  } = useSocket();

  const [currentTime, setCurrentTime] = useState(new Date());

  // Update clock every second (forces re-render for "time since" displays)
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen p-4 md:p-6 lg:p-8">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="max-w-7xl mx-auto mb-8 animate-fade-in" id="dashboard-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Heart className="w-6 h-6 text-white fill-white" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
                BPM Dashboard
              </h1>
              <p className="text-sm text-slate-400 mt-0.5">
                Real-time heart rate monitoring • ESP32 + MAX30102
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

      {/* ── Main Grid ──────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* Left column — BPM Card + Status cards */}
          <div className="lg:col-span-4 space-y-6">
            {/* BPM Card */}
            <div className="animate-fade-in animate-fade-in-delay-1">
              <BpmCard
                bpm={bpm}
                fingerDetected={sensorStatus.fingerDetected}
                stats={stats}
              />
            </div>

            {/* Connection Status */}
            <div className="animate-fade-in animate-fade-in-delay-2">
              <ConnectionStatus
                isConnected={isConnected}
                espConnected={espConnected}
                lastUpdate={lastUpdate}
              />
            </div>

            {/* Sensor Status */}
            <div className="animate-fade-in animate-fade-in-delay-3">
              <SensorStatus sensorStatus={sensorStatus} />
            </div>
          </div>

          {/* Right column — Chart */}
          <div className="lg:col-span-8 animate-fade-in animate-fade-in-delay-2">
            <BpmChart history={history} />
          </div>
        </div>
      </main>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="max-w-7xl mx-auto mt-12 pb-6 animate-fade-in animate-fade-in-delay-4">
        <div className="flex items-center justify-center gap-2 text-slate-600 text-xs">
          <Heart className="w-3 h-3" />
          <span>BPM Smart Bracelet • ESP32 + MAX30102 • Built with ❤️</span>
        </div>
      </footer>
    </div>
  );
}

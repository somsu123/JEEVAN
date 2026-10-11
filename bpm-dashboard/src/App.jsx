/**
 * ============================================================
 *  App.jsx — JEEVAN Dashboard (BPM + SpO₂)
 * ============================================================
 *  Layout:
 *   Left column  (4/12) — BpmCard + SpO₂Card + Connection + Sensor
 *   Right column (8/12) — Dual-metric live chart
 * ============================================================
 */

import React, { useState, useEffect, useRef } from 'react';
import { Heart, Activity, AlertTriangle, ShieldAlert, Package, Zap } from 'lucide-react';
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
    isFresh,
    sensorStatus,
    lastUpdate,
    stats,
  } = useSocket();

  const [currentTime, setCurrentTime] = useState(new Date());
  const [sosDismissed, setSosDismissed] = useState(false);
  const lastAutoOpenRef = useRef(0);

  const isBpmCritical = Boolean(sensorStatus.fingerDetected && bpm && Number(bpm) > 0 && (Number(bpm) <= 45 || Number(bpm) > 120));
  const isBradycardia = Boolean(isBpmCritical && Number(bpm) <= 45);

  // Trigger remote open when BPM <= 45 or > 120
  useEffect(() => {
    if (isBpmCritical && !sosDismissed) {
      const now = Date.now();
      if (now - lastAutoOpenRef.current > 25000) {
        lastAutoOpenRef.current = now;
        fetch('http://localhost:5050/api/hardware/remote-open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            compartment: 0,
            label: isBradycardia ? 'SOS BRADY ≤45' : 'SOS TACHY >120',
            emergency: true,
            bpm,
          }),
        }).catch(() => {});
      }
    }
  }, [isBpmCritical, isBradycardia, bpm, sosDismissed]);

  const handleManualOpen = () => {
    fetch('http://localhost:5050/api/hardware/remote-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compartment: 0, label: 'EMERGENCY SOS', emergency: true }),
    }).catch(() => {});
  };

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

      {/* ── Emergency SOS & Designated Medicine Box Slot Section ── */}
      {isBpmCritical && !sosDismissed && (
        <section className="max-w-7xl mx-auto mb-8 bg-gradient-to-r from-rose-950/80 via-red-900/60 to-slate-900 border-2 border-rose-500 rounded-3xl p-6 text-white shadow-2xl animate-pulse">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-rose-500/30 pb-4">
            <div className="flex items-center gap-3.5">
              <div className="p-3 bg-rose-500 text-white rounded-2xl shrink-0">
                <AlertTriangle className="w-6 h-6 animate-bounce" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold tracking-tight">
                    🚨 CARDIAC SOS TRIGGERED: {isBradycardia ? 'Critical Bradycardia (≤45 BPM)' : 'Critical Tachycardia (>120 BPM)'}
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500 text-white">
                    {bpm} BPM
                  </span>
                </div>
                <p className="text-xs sm:text-sm text-rose-200 mt-0.5">
                  Lid opened automatically. ONLY Slot 1 LED is blinking repeatedly — box closes ONLY upon pressing the physical Confirm Button (D4).
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleManualOpen}
                className="px-4 py-2 bg-rose-500 hover:bg-rose-600 text-white font-bold rounded-xl text-xs transition flex items-center gap-1.5 cursor-pointer"
              >
                <Package className="w-4 h-4" /> Re-open Lid
              </button>
              <button
                onClick={() => setSosDismissed(true)}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl text-xs border border-slate-700 transition cursor-pointer"
              >
                Acknowledge
              </button>
            </div>
          </div>

          {/* Overlapping Slot & Designated Emergency Meds Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            <div className="bg-slate-900/80 border border-rose-500/30 rounded-2xl p-4">
              <div className="flex justify-between items-center text-xs text-rose-300 mb-2">
                <span className="font-bold">DESIGNATED SLOT</span>
                <span className="bg-rose-500/20 text-rose-300 px-2 py-0.5 rounded-md font-bold">Overlapping</span>
              </div>
              <div className="text-base font-bold text-white">Compartment #1 (Box 1)</div>
              <p className="text-xs text-slate-400 mt-1">
                Due to limited physical compartments, Compartment 1 holds both routine meds and emergency cardiac response medications.
              </p>
            </div>

            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4">
              <span className="text-xs font-bold text-rose-400 uppercase tracking-wider block mb-1">High Pulse Emergency (&gt;120)</span>
              <div className="text-sm font-bold text-white">Nitroglycerin 0.5mg + Aspirin 325mg</div>
              <p className="text-xs text-slate-400 mt-1">
                Sublingual tablet under tongue immediately. Rapid coronary vasodilation.
              </p>
            </div>

            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4">
              <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider block mb-1">Low Pulse Emergency (≤45)</span>
              <div className="text-sm font-bold text-white">Emergency Cardiotonic / Atropine</div>
              <p className="text-xs text-slate-400 mt-1">
                Oral cardiac support dose for profound bradycardia. Restores sinus rate.
              </p>
            </div>
          </div>
        </section>
      )}

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
            <BpmChart history={history} isFresh={isFresh} />
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

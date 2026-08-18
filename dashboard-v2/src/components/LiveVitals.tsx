import React from 'react';
import {
  Heart,
  Activity,
  Wind,
  Footprints,
  User,
  Radio,
  TrendingUp,
} from 'lucide-react';
import { VitalState } from '../types';

interface LiveVitalsProps {
  vitals: VitalState;
  hardwareOnline: boolean;
  espConnected?: boolean;
}

// ─── Status color utilities ───────────────────────────────────────────────────
function spo2Status(spo2: number) {
  if (spo2 < 90) return { label: 'CRITICAL LOW', color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/20' };
  if (spo2 < 94) return { label: 'LOW', color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' };
  return { label: 'Normal', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' };
}

function signalBadge(signal?: string) {
  switch (signal) {
    case 'excellent':
      return { label: 'Signal: Excellent', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' };
    case 'good':
      return { label: 'Signal: Good', color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/20' };
    case 'fair':
      return { label: 'Signal: Fair', color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' };
    case 'weak':
      return { label: 'Signal: Weak', color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/20' };
    default:
      return { label: 'Signal: Standby', color: 'text-slate-400', bg: 'bg-slate-800/50', border: 'border-slate-700/50' };
  }
}

const movementIcons: Record<string, React.ElementType> = {
  'Resting': Activity,
  'Gentle Walk': Footprints,
  'Seated Activity': User,
  'Sleeping': Activity,
};

// ─── ECG Sparkline Component ──────────────────────────────────────────────────
function BPMSparkline({ history, fingerPresent }: { history: any[], fingerPresent: boolean }) {
  if (!history || history.length === 0) {
    return (
      <div className="h-28 flex items-center justify-center text-xs font-mono text-slate-500">
        Awaiting pulse wave telemetry...
      </div>
    );
  }

  const maxPoints = 60;
  const data = history.slice(-maxPoints);
  const min = Math.min(...data.map((d: any) => d.value), 40) - 10;
  const max = Math.max(...data.map((d: any) => d.value), 120) + 10;
  const range = Math.max(max - min, 1);

  const points = data.map((d: any, i: number) => {
    const x = (i / Math.max(data.length - 1, 1)) * 100;
    const y = 100 - ((d.value - min) / range) * 100;
    return `${x},${y}`;
  }).join(' ');

  const fillPoints = `0,100 ${points} 100,100`;

  return (
    <div className="relative w-full h-28 mt-auto">
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="hr-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1="25" x2="100" y2="25" className="stroke-slate-800/50" strokeWidth="0.3" strokeDasharray="2,2" />
        <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-800/50" strokeWidth="0.3" strokeDasharray="2,2" />
        <line x1="0" y1="75" x2="100" y2="75" className="stroke-slate-800/50" strokeWidth="0.3" strokeDasharray="2,2" />

        {fingerPresent && data.length > 1 ? (
          <>
            <polygon points={fillPoints} fill="url(#hr-gradient)" />
            <polyline
              points={points}
              fill="none"
              stroke="#10b981"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="drop-shadow-sm"
            />
          </>
        ) : (
          <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-700" strokeWidth="1" strokeDasharray="4,4" />
        )}
      </svg>
    </div>
  );
}

// ─── SpO2 Trend Sparkline Component ───────────────────────────────────────────
function SpO2Sparkline({ history, fingerPresent }: { history: any[], fingerPresent: boolean }) {
  if (!history || history.length === 0) {
    return (
      <div className="h-16 flex items-center justify-center text-[10px] font-mono text-slate-500">
        Awaiting SpO₂ trend...
      </div>
    );
  }

  const maxPoints = 40;
  const data = history.slice(-maxPoints);
  const min = 85;
  const max = 100;
  const range = max - min;

  const points = data.map((d: any, i: number) => {
    const x = (i / Math.max(data.length - 1, 1)) * 100;
    const clampedVal = Math.max(85, Math.min(100, d.value));
    const y = 100 - ((clampedVal - min) / range) * 100;
    return `${x},${y}`;
  }).join(' ');

  const fillPoints = `0,100 ${points} 100,100`;

  return (
    <div className="relative w-full h-16 mt-2">
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spo2-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
          </linearGradient>
        </defs>
        {fingerPresent && data.length > 1 ? (
          <>
            <polygon points={fillPoints} fill="url(#spo2-gradient)" />
            <polyline
              points={points}
              fill="none"
              stroke="#06b6d4"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-700" strokeWidth="1" strokeDasharray="4,4" />
        )}
      </svg>
    </div>
  );
}

// ─── Circular SpO2 Gauge ──────────────────────────────────────────────────────
function SpO2Gauge({ value, status }: { value: number; status: { label: string; color: string } }) {
  const circumference = 2 * Math.PI * 40; // radius = 40
  const clamped = Math.max(0, Math.min(100, value || 0));
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div className="relative w-32 h-32">
      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="none" stroke="#1e293b" strokeWidth="8" />
        <circle
          cx="50" cy="50" r="40" fill="none"
          stroke="#06b6d4"
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="drop-shadow-lg transition-all duration-1000"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-headline font-bold text-slate-100">
          {value > 0 ? value : '--'}<span className="text-base text-slate-400">%</span>
        </span>
        <span className={`text-[10px] font-medium mt-0.5 ${status.color}`}>{status.label}</span>
      </div>
    </div>
  );
}

export default function LiveVitals({ vitals, hardwareOnline, espConnected = false }: LiveVitalsProps) {
  const spo2St = spo2Status(vitals.oxygenSpO2);
  const sigBadge = signalBadge(vitals.signalQuality);
  const MovementIcon = movementIcons[vitals.movementState] || Activity;

  // Derive sensor state clearly
  const sensorOffline = !espConnected && !hardwareOnline;
  const fingerPresent = espConnected && vitals.fingerPresent;
  const bpmHistory = vitals.heartRateHistory || [];
  const bpmValues = bpmHistory.map((h: any) => h.value).filter((v: number) => v > 0);
  const minBpm = bpmValues.length > 0 ? Math.min(...bpmValues) : '--';
  const maxBpm = bpmValues.length > 0 ? Math.max(...bpmValues) : '--';

  return (
    <div className="flex flex-col gap-6 relative">
      {/* Decorative orb */}
      <div className="orb-emerald -top-40 -right-40" />

      {/* ── Header ── */}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-headline font-bold text-slate-100 tracking-tight">
            Live Vitals Monitor
          </h1>
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 px-3 py-1 rounded-full">
            <div className="w-2 h-2 rounded-full bg-red-500 pulse-red-dot" />
            <span className="text-xs font-bold text-red-400 uppercase tracking-wider font-label">Live</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Signal Quality */}
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono ${sigBadge.bg} ${sigBadge.border} ${sigBadge.color}`}>
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>{sigBadge.label}</span>
          </div>

          {/* Hardware Connection */}
          <div className="flex items-center gap-2 bg-slate-800/60 px-3 py-1.5 rounded-lg border border-slate-700/50">
            <div className={`w-2 h-2 rounded-full ${
              espConnected
                ? 'bg-emerald-500 pulse-emerald'
                : hardwareOnline
                  ? 'bg-amber-400'
                  : 'bg-rose-600'
            }`} />
            <span className={`text-xs font-medium ${
              espConnected ? 'text-emerald-300' : hardwareOnline ? 'text-amber-300' : 'text-rose-400'
            }`}>
              {espConnected ? 'ESP32 Connected' : hardwareOnline ? 'ESP32 Standby' : 'Sensor Offline'}
            </span>
          </div>

          <div className="font-mono text-slate-400 text-xs px-3 py-1.5 bg-slate-800/50 rounded-lg border border-slate-700/50">
            {vitals.lastUpdated}
          </div>
        </div>
      </header>

      {/* ── Bento Grid Layout ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">

        {/* ── Large Heart Rate Section (Left) ── */}
        <div className="lg:col-span-6 glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />

          <div className="flex justify-between items-start mb-4 z-10">
            <div className="flex items-center gap-2">
              <Heart className="h-5 w-5 text-emerald-500" />
              <h2 className="text-lg font-headline font-semibold text-slate-200">Heart Rate (BPM)</h2>
            </div>
            {/* Three-state finger/sensor status badge */}
            {sensorOffline ? (
              <div className="flex items-center gap-1.5 bg-rose-500/10 px-3 py-1 rounded-full border border-rose-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                <span className="text-xs font-bold text-rose-400 font-mono tracking-wide">⚡ SENSOR OFFLINE</span>
              </div>
            ) : fingerPresent ? (
              <div className="flex items-center gap-2 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 pulse-emerald" />
                <span className="text-xs font-medium text-emerald-400">Finger Detected</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/30 animate-pulse">
                <span className="text-xs">👆</span>
                <span className="text-xs font-bold text-amber-400 font-mono tracking-wide">FINGER NOT DETECTED</span>
              </div>
            )}
          </div>

          {/* Hero BPM */}
          <div className="flex-1 flex flex-col justify-center items-center z-10 py-3">
            <div className="flex items-baseline gap-2">
              <span className={`text-7xl lg:text-8xl font-headline font-bold tracking-tighter transition-colors duration-500 ${
                sensorOffline
                  ? 'text-rose-800'
                  : fingerPresent
                    ? 'text-emerald-500'
                    : 'text-slate-600'
              }`}>
                {fingerPresent && vitals.heartRate ? vitals.heartRate : '--'}
              </span>
              <span className={`text-xl font-bold font-label ${
                fingerPresent ? 'text-emerald-500/60' : 'text-slate-700'
              }`}>BPM</span>
            </div>
            {/* Subtle status line under BPM */}
            {!sensorOffline && !fingerPresent && (
              <p className="text-xs text-amber-500/70 font-mono mt-2 animate-pulse">
                Place finger on MAX30102 sensor
              </p>
            )}
            {sensorOffline && (
              <p className="text-xs text-rose-500/70 font-mono mt-2">
                Reconnect ESP32 to resume monitoring
              </p>
            )}
            {fingerPresent && typeof vitals.heartRate === 'number' && vitals.heartRate > 0 && (
              <Heart
                className="h-6 w-6 text-rose-400 animate-pulse mt-2"
                style={{ animationDuration: `${(60 / vitals.heartRate).toFixed(2)}s` }}
              />
            )}
          </div>

          {/* BPM Stats */}
          <div className="grid grid-cols-2 gap-2 my-2 z-10">
            <div className="bg-slate-800/40 rounded-lg p-2 border border-slate-700/40 text-center">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Min BPM</span>
              <span className="text-sm font-bold text-slate-200 font-mono">{minBpm}</span>
            </div>
            <div className="bg-slate-800/40 rounded-lg p-2 border border-slate-700/40 text-center">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Max BPM</span>
              <span className="text-sm font-bold text-slate-200 font-mono">{maxBpm}</span>
            </div>
          </div>

          {/* ECG Graph */}
          <div className="z-10 mt-2">
            <div className="flex justify-between text-[9px] text-slate-500 font-mono mb-1 uppercase tracking-wider">
              <span>Last {Math.min(bpmHistory.length, 60)} readings</span>
              <span>MAX30102 PPG Waveform</span>
            </div>
            <BPMSparkline history={bpmHistory} fingerPresent={fingerPresent} />
          </div>
        </div>

        {/* ── SpO2 & Activity Section (Right) ── */}
        <div className="lg:col-span-6 grid grid-cols-1 sm:grid-cols-2 gap-6">

          {/* SpO2 Card — Circular Gauge + Trend */}
          <div className="glass-card rounded-2xl p-5 flex flex-col justify-between sm:col-span-2 relative overflow-hidden">
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-2">
                <Wind className="h-5 w-5 text-cyan-400" />
                <h2 className="text-base font-headline font-semibold text-slate-200">Blood Oxygen (SpO₂)</h2>
              </div>
              <span className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${spo2St.bg} ${spo2St.border} ${spo2St.color}`}>
                {spo2St.label}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
              <div className="flex justify-center">
                <SpO2Gauge value={fingerPresent ? vitals.oxygenSpO2 : 0} status={spo2St} />
              </div>
              <div className="flex flex-col justify-center">
                <div className="text-xs text-slate-400 mb-1 flex items-center gap-1 font-mono">
                  <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
                  <span>SpO₂ Calibration Curve (R-ratio)</span>
                </div>
                <div className="text-[11px] text-slate-500 leading-relaxed mb-2">
                  Clinical DC-filtered high-pass ratio computed from Red/IR photoplethysmogram channels.
                </div>
                <SpO2Sparkline history={vitals.spo2History || []} fingerPresent={fingerPresent} />
              </div>
            </div>
          </div>

          {/* Movement Card */}
          <div className="glass-card rounded-2xl p-5 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <MovementIcon className="h-4 w-4 text-indigo-400" />
              <h2 className="text-sm font-headline font-semibold text-slate-300">Activity Status</h2>
            </div>
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-2">
                <MovementIcon className="h-6 w-6 text-indigo-400" />
              </div>
              <div className="text-lg font-headline font-semibold text-slate-200">{vitals.movementState}</div>
              <div className="text-[10px] text-slate-500 mt-1 font-label">Motion Accelerometer</div>
            </div>
          </div>

          {/* Room Presence Card */}
          <div className="glass-card rounded-2xl p-5 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <User className="h-4 w-4 text-teal-400" />
              <h2 className="text-sm font-headline font-semibold text-slate-300">Room Presence</h2>
            </div>
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="relative mb-2">
                <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center border border-slate-700">
                  <User className="h-6 w-6 text-slate-300" />
                </div>
                <div className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-slate-900 ${
                  vitals.roomPresence ? 'bg-emerald-500' : 'bg-slate-600'
                }`} />
              </div>
              <span className="text-lg font-headline font-semibold text-slate-200">
                {vitals.roomPresence ? 'Patient Present' : 'No Presence'}
              </span>
              <p className="text-[10px] text-slate-500 font-label mt-1">Ultrasonic HC-SR04</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Sedentary Sync Bar ── */}
      <div>
        <div className="flex justify-between items-end mb-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider font-label">Sedentary Time Tracker</span>
          <span className="text-xs font-mono text-slate-500">
            {vitals.movementState === 'Resting' ? 'Resting' : 'Active'} for <span className="text-amber-400 font-bold">{vitals.bloodLevelSeconds} min</span>
          </span>
        </div>
        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full shadow-[0_0_10px_rgba(16,185,129,0.4)] transition-all duration-500"
            style={{ width: `${Math.min(100, (vitals.bloodLevelSeconds / 60) * 100)}%` }}
          />
        </div>
        {vitals.bloodLevelSeconds > 45 && (
          <p className="text-[10px] text-amber-400 mt-1.5 font-mono">⚠ Consider encouraging gentle movement to improve circulation.</p>
        )}
      </div>
    </div>
  );
}

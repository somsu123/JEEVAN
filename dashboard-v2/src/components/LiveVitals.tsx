import React, { useEffect, useState } from 'react';
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
  hideHeader?: boolean;
  isHomeView?: boolean;
}

// ─── Status color utilities ───────────────────────────────────────────────────
function spo2Status(spo2: number, fingerPresent: boolean = false) {
  if (!fingerPresent || !spo2 || spo2 <= 0) {
    return { label: 'Standby', color: 'text-slate-500', bg: 'bg-slate-100', border: 'border-slate-200' };
  }
  if (spo2 < 90) return { label: 'Critical Low', color: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200' };
  if (spo2 < 94) return { label: 'Low Level', color: 'text-amber-800', bg: 'bg-amber-50', border: 'border-amber-200' };
  return { label: 'Normal Oxygen', color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' };
}

function signalBadge(signal?: string) {
  switch (signal) {
    case 'excellent':
      return { label: 'Signal: Strong', color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' };
    case 'good':
      return { label: 'Signal: Good', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200' };
    case 'fair':
      return { label: 'Signal: Fair', color: 'text-amber-800', bg: 'bg-amber-50', border: 'border-amber-200' };
    case 'weak':
      return { label: 'Signal: Weak', color: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200' };
    default:
      return { label: 'Signal: Standby', color: 'text-slate-600', bg: 'bg-slate-100', border: 'border-slate-200' };
  }
}

const movementIcons: Record<string, React.ElementType> = {
  'Resting': Activity,
  'Gentle Walk': Footprints,
  'Seated Activity': User,
  'Sleeping': Activity,
  'Unknown': Activity,
};

// ─── ECG Sparkline Component ──────────────────────────────────────────────────
function BPMSparkline({ history, fingerPresent }: { history: any[], fingerPresent: boolean }) {
  if (!history || history.length === 0) {
    return (
      <div className="h-24 flex items-center justify-center text-xs text-slate-400 font-medium">
        Awaiting pulse wave transmission...
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
    <div className="relative w-full h-24 mt-auto">
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="hr-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#10B981" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#10B981" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <line x1="0" y1="25" x2="100" y2="25" className="stroke-slate-100" strokeWidth="0.5" strokeDasharray="2,2" />
        <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-100" strokeWidth="0.5" strokeDasharray="2,2" />
        <line x1="0" y1="75" x2="100" y2="75" className="stroke-slate-100" strokeWidth="0.5" strokeDasharray="2,2" />

        {fingerPresent && data.length > 1 ? (
          <>
            <polygon points={fillPoints} fill="url(#hr-gradient)" />
            <polyline
              points={points}
              fill="none"
              stroke="#10B981"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-300" strokeWidth="1" strokeDasharray="4,4" />
        )}
      </svg>
    </div>
  );
}

// ─── SpO2 Trend Sparkline Component ───────────────────────────────────────────
function SpO2Sparkline({ history, fingerPresent }: { history: any[], fingerPresent: boolean }) {
  if (!history || history.length === 0) {
    return (
      <div className="h-14 flex items-center justify-center text-xs text-slate-400 font-medium">
        Awaiting oxygen trend...
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
    <div className="relative w-full h-14 mt-1">
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spo2-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        {fingerPresent && data.length > 1 ? (
          <>
            <polygon points={fillPoints} fill="url(#spo2-gradient)" />
            <polyline
              points={points}
              fill="none"
              stroke="#3B82F6"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-300" strokeWidth="1" strokeDasharray="4,4" />
        )}
      </svg>
    </div>
  );
}

// ─── Circular SpO2 Gauge ──────────────────────────────────────────────────────
function SpO2Gauge({ value, status }: { value: number; status: { label: string; color: string } }) {
  const circumference = 2 * Math.PI * 38; // radius = 38
  const clamped = Math.max(0, Math.min(100, value || 0));
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div className="relative w-28 h-28">
      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="38" fill="none" stroke="#F1F5F9" strokeWidth="7" />
        <circle
          cx="50" cy="50" r="38" fill="none"
          stroke="#3B82F6"
          strokeWidth="7"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-2xl font-headline font-bold ${value > 0 ? 'text-slate-800' : 'text-slate-400'}`}>
          {value > 0 ? value : '--'}<span className="text-xs text-slate-500 font-bold ml-0.5">%</span>
        </span>
        <span className={`text-xs font-semibold mt-0.5 ${status.color}`}>{status.label}</span>
      </div>
    </div>
  );
}

export default function LiveVitals({ vitals, hardwareOnline, espConnected = false, hideHeader = false, isHomeView = false }: LiveVitalsProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const packetAgeMs = vitals.lastPacketAt == null ? Infinity : Math.max(0, now - vitals.lastPacketAt);
  const vitalsFresh = espConnected && vitals.lastPacketAt != null && packetAgeMs <= 8000;
  const fingerPresent = vitalsFresh && vitals.fingerPresent;
  const spo2St = spo2Status(vitals.oxygenSpO2, fingerPresent);
  const sigBadge = signalBadge(vitalsFresh ? vitals.signalQuality : 'unknown');
  const MovementIcon = movementIcons[vitals.movementState] || Activity;

  const bpmHistory = vitals.heartRateHistory || [];
  const bpmValues = vitalsFresh && fingerPresent
    ? bpmHistory.map((h: any) => h.value).filter((v: number) => v > 0)
    : [];
  const minBpm = bpmValues.length > 0 ? Math.min(...bpmValues) : '--';
  const maxBpm = bpmValues.length > 0 ? Math.max(...bpmValues) : '--';
  const hasSedentaryData = typeof vitals.bloodLevelSeconds === 'number' && Number.isFinite(vitals.bloodLevelSeconds);
  const sedentaryPercent = hasSedentaryData
    ? Math.min(100, ((vitals.bloodLevelSeconds as number) / 60) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-6 relative">
      {/* ── Header ── */}
      {!hideHeader && (
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-headline font-bold text-slate-800 tracking-tight">
            Live Biometric Vitals
          </h1>
          <div className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-xs font-semibold ${vitalsFresh ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
            <div className={`w-2.5 h-2.5 rounded-full ${vitalsFresh ? 'bg-emerald-500 pulse-emerald' : 'bg-slate-400'}`} />
            <span>{vitalsFresh ? 'Live Stream Active' : 'Standby Mode'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Signal Quality */}
          <div className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-medium ${sigBadge.bg} ${sigBadge.border} ${sigBadge.color} shadow-2xs`}>
            <Radio className={`w-4 h-4 ${vitalsFresh ? 'animate-pulse' : ''}`} />
            <span>{sigBadge.label}</span>
          </div>

          {/* Hardware Connection */}
          <div className="flex items-center gap-2 bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-2xs">
            <div className={`w-2.5 h-2.5 rounded-full ${
              vitalsFresh
                ? 'bg-emerald-500 pulse-emerald'
                : hardwareOnline
                  ? 'bg-slate-400'
                  : 'bg-rose-500'
            }`} />
            <span className={`text-xs font-semibold ${
              vitalsFresh ? 'text-emerald-700' : hardwareOnline ? 'text-slate-600' : 'text-rose-600'
            }`}>
              {vitalsFresh ? 'Bracelet Connected' : hardwareOnline ? 'Waiting for vitals' : 'Bracelet Standby'}
            </span>
          </div>

          <div className="text-slate-500 text-xs px-3.5 py-2 bg-white rounded-xl border border-slate-200 shadow-2xs font-medium">
            {vitalsFresh ? vitals.lastUpdated : '--:--'}
          </div>
        </div>
      </header>
      )}

      {/* ── Bento Grid Layout ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 flex-1">

        {/* ── Heart Rate Card ── */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-3xl p-6 flex flex-col relative overflow-hidden shadow-xs hover:shadow-sm transition-shadow">
          <div className="flex justify-between items-start mb-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-rose-50 text-rose-600 border border-rose-100">
                <Heart className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-headline font-bold text-slate-800">Heart Rate (Pulse BPM)</h2>
                <p className="text-xs text-slate-500 font-medium">Optical Pulse Oximetry Sensor (MAX30102)</p>
              </div>
            </div>

            {!vitalsFresh ? (
              <div className="flex items-center gap-1.5 bg-slate-100 px-3 py-1 rounded-full border border-slate-200">
                <span className="w-2 h-2 rounded-full bg-slate-400" />
                <span className="text-xs font-semibold text-slate-600">Standby</span>
              </div>
            ) : vitals.sensorError ? (
              <div className="flex items-center gap-1.5 bg-rose-50 px-3 py-1 rounded-full border border-rose-200">
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                <span className="text-xs font-bold text-rose-700">Sensor Error</span>
              </div>
            ) : fingerPresent ? (
              <div className="flex items-center gap-1.5 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
                <span className="w-2 h-2 rounded-full bg-emerald-500 pulse-emerald" />
                <span className="text-xs font-bold text-emerald-700">Pulse Detected</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 bg-amber-50 px-3 py-1 rounded-full border border-amber-200 animate-pulse">
                <span className="text-xs">👆</span>
                <span className="text-xs font-bold text-amber-800">Place Finger</span>
              </div>
            )}
          </div>

          {/* Hero BPM Reading */}
          <div className="flex-1 flex flex-col justify-center items-center py-3">
            <div className="flex items-baseline gap-2.5">
              <span className={`text-6xl lg:text-7xl font-headline font-bold tracking-tight ${
                !vitalsFresh
                  ? 'text-slate-300'
                  : fingerPresent
                    ? 'text-slate-800'
                    : 'text-slate-300'
              }`}>
                {fingerPresent && vitals.heartRate ? vitals.heartRate : '--'}
              </span>
              <span className={`text-lg font-bold ${
                fingerPresent ? 'text-rose-600' : 'text-slate-400'
              }`}>BPM</span>
            </div>

            {vitalsFresh && !fingerPresent && (
              <p className="text-xs text-amber-800 font-medium mt-1">
                Rest finger gently on the bracelet sensor
              </p>
            )}
            {!vitalsFresh && (
              <p className="text-xs text-slate-400 font-medium mt-1">
                Waiting for real-time sensor transmission
              </p>
            )}
            {fingerPresent && typeof vitals.heartRate === 'number' && vitals.heartRate > 0 && (
              <div className="flex items-center gap-1.5 mt-1 text-xs text-emerald-700 font-semibold bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">
                <Heart className="h-3.5 w-3.5 text-rose-500 animate-pulse" />
                <span>Normal sinus pulse detected</span>
              </div>
            )}
          </div>

          {/* BPM Stats Chips */}
          <div className="grid grid-cols-2 gap-3 my-2">
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-200/80 text-center">
              <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider block">Minimum BPM</span>
              <span className="text-base font-bold text-slate-800 font-mono mt-0.5 block">{minBpm}</span>
            </div>
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-200/80 text-center">
              <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider block">Maximum BPM</span>
              <span className="text-base font-bold text-slate-800 font-mono mt-0.5 block">{maxBpm}</span>
            </div>
          </div>

          {/* ECG Graph */}
          <div className="mt-2">
            <div className="flex justify-between text-xs text-slate-500 font-medium mb-1">
              <span>Past {Math.min(bpmHistory.length, 60)} Data Points</span>
              <span>Pulse PPG Stream</span>
            </div>
            <BPMSparkline history={bpmHistory} fingerPresent={fingerPresent} />
          </div>
        </div>

        {/* ── SpO2 & Movement Section (Right) ── */}
        <div className="lg:col-span-6 grid grid-cols-1 sm:grid-cols-2 gap-5">

          {/* SpO2 Card */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 flex flex-col justify-between sm:col-span-2 shadow-xs hover:shadow-sm transition-shadow">
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
                  <Wind className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-headline font-bold text-slate-800">Blood Oxygen Level (SpO₂)</h2>
                  <p className="text-xs text-slate-500 font-medium">Dual-wavelength Red/IR Pulse Oximetry</p>
                </div>
              </div>
              <span className={`text-xs font-semibold px-3.5 py-1 rounded-full border ${spo2St.bg} ${spo2St.border} ${spo2St.color}`}>
                {spo2St.label}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-center mt-2">
              <div className="flex justify-center">
                <SpO2Gauge value={fingerPresent ? vitals.oxygenSpO2 : 0} status={spo2St} />
              </div>
              <div className="flex flex-col justify-center">
                <div className="text-xs text-slate-700 mb-1 flex items-center gap-1.5 font-semibold">
                  <TrendingUp className="w-4 h-4 text-blue-600" />
                  <span>Oxygen Saturation History</span>
                </div>
                <div className="text-xs text-slate-500 leading-relaxed mb-1">
                  Synchronized infrared optical photoplethysmogram tracking.
                </div>
                <SpO2Sparkline history={vitals.spo2History || []} fingerPresent={fingerPresent} />
              </div>
            </div>
          </div>

          {/* Movement & Activity Card */}
          {!isHomeView && (
            <>
              <div className="bg-white border border-slate-200 rounded-3xl p-5 flex flex-col shadow-xs">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
                    <MovementIcon className="h-4 w-4" />
                  </div>
                  <h2 className="text-sm font-headline font-bold text-slate-800">Activity State</h2>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center py-2">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center mb-2 text-indigo-600 shadow-2xs">
                    <MovementIcon className="h-6 w-6" />
                  </div>
                  <div className="text-base font-headline font-bold text-slate-800">
                    {vitals.movementState === 'Unknown' ? 'Standby' : vitals.movementState}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 font-medium">Motion Accelerometer</p>
                </div>
              </div>

              {/* Room Presence Card */}
              <div className="bg-white border border-slate-200 rounded-3xl p-5 flex flex-col shadow-xs">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="p-2 rounded-xl bg-teal-50 text-teal-600 border border-teal-100">
                    <User className="h-4 w-4" />
                  </div>
                  <h2 className="text-sm font-headline font-bold text-slate-800">Patient Proximity</h2>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center py-2">
                  <div className="relative mb-2">
                    <div className="w-12 h-12 rounded-2xl bg-teal-50 flex items-center justify-center border border-teal-100 text-teal-600 shadow-2xs">
                      <User className="h-6 w-6" />
                    </div>
                    <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                      vitals.roomPresence === null ? 'bg-slate-300' : vitals.roomPresence ? 'bg-emerald-500' : 'bg-slate-300'
                    }`} />
                  </div>
                  <span className="text-base font-headline font-bold text-slate-800">
                    {vitals.roomPresence === null ? 'Standby' : vitals.roomPresence ? 'Near Device' : 'No Presence'}
                  </span>
                  <p className="text-xs text-slate-500 mt-0.5 font-medium">Ultrasonic Sensor (D5)</p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Sedentary Activity Bar ── */}
      <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs">
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Rest & Sedentary Duration</span>
          <span className="text-xs text-slate-600 font-semibold">
            {hasSedentaryData
              ? <>{vitals.movementState === 'Resting' ? 'Resting' : 'Active'} for <span className="text-blue-700 font-bold">{Math.round((vitals.bloodLevelSeconds as number) / 60)} min</span></>
              : 'Activity duration standby'}
          </span>
        </div>
        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${hasSedentaryData ? 'bg-blue-600' : 'bg-slate-200'}`}
            style={{ width: `${sedentaryPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
}

import React, { useRef, useEffect } from 'react';
import {
  Heart,
  Activity,
  Wind,
  Footprints,
  User,
  Wifi,
  WifiOff,
  TrendingUp,
  TrendingDown,
  Minus,
} from 'lucide-react';
import { VitalState } from '../types';

interface LiveVitalsProps {
  vitals: VitalState;
  hardwareOnline: boolean;
}

// ─── Status color utilities ───────────────────────────────────────────────────
function spo2Status(spo2: number) {
  if (spo2 < 90) return { label: 'CRITICAL LOW', color: 'text-rose-400' };
  if (spo2 < 94) return { label: 'LOW', color: 'text-amber-400' };
  return { label: 'NORMAL', color: 'text-emerald-400' };
}

function bpStatus(sys: number, dia: number) {
  if (sys >= 180 || dia >= 120) return { label: 'HYPERTENSIVE CRISIS', color: 'text-rose-400' };
  if (sys >= 140 || dia >= 90) return { label: 'STAGE 2 HIGH', color: 'text-rose-400' };
  if (sys >= 130 || dia >= 80) return { label: 'STAGE 1 HIGH', color: 'text-amber-400' };
  if (sys < 90 || dia < 60) return { label: 'LOW BP', color: 'text-blue-400' };
  return { label: 'NORMAL', color: 'text-emerald-400' };
}

const movementIcons: Record<string, React.ElementType> = {
  'Resting': Activity,
  'Gentle Walk': Footprints,
  'Seated Activity': User,
  'Sleeping': Activity,
};

// ─── Sparkline Component ───────────────────────────────────────────────────────
function BPMSparkline({ history, currentBPM, fingerPresent }: { history: any[], currentBPM: number | string, fingerPresent: boolean }) {
  if (!history || history.length === 0) {
    return <div className="h-16 flex items-center justify-center text-xs font-mono text-slate-500">Waiting for data...</div>;
  }
  
  const maxPoints = 60;
  const data = history.slice(-maxPoints);
  const min = Math.min(...data.map(d => d.value), 40) - 10;
  const max = Math.max(...data.map(d => d.value), 120) + 10;
  const range = max - min;
  
  const points = data.map((d, i) => {
    const x = (i / (Math.max(data.length - 1, 1))) * 100;
    const y = 100 - ((d.value - min) / range) * 100;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="relative h-16 w-full overflow-hidden mt-2">
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* Grid lines */}
        <line x1="0" y1="25" x2="100" y2="25" className="stroke-slate-800" strokeWidth="0.5" strokeDasharray="2,2" />
        <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-800" strokeWidth="0.5" strokeDasharray="2,2" />
        <line x1="0" y1="75" x2="100" y2="75" className="stroke-slate-800" strokeWidth="0.5" strokeDasharray="2,2" />
        
        {fingerPresent && data.length > 1 ? (
          <polyline
            points={points}
            fill="none"
            className="stroke-rose-500"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
           <line x1="0" y1="50" x2="100" y2="50" className="stroke-slate-700" strokeWidth="2" strokeDasharray="4,4" />
        )}
      </svg>
    </div>
  );
}

export default function LiveVitals({ vitals, hardwareOnline }: LiveVitalsProps) {
  const spo2St = spo2Status(vitals.oxygenSpO2);
  const bpSt = bpStatus(vitals.systolicBP, vitals.diastolicBP);
  const MovementIcon = movementIcons[vitals.movementState] || Activity;


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row justify-between gap-6 border-b border-slate-800/60 pb-6">
        <div className="lg:w-1/2">
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Heart className="h-6 w-6 text-emerald-400 animate-pulse" />
            Live Vitals Telemetry
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Real-time physiological data from Arthur's smart bracelet (ESP32 + MAX30102 + MPU6050).
          </p>
          <div className="mt-6 flex items-center gap-4">
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-black text-white">{vitals.heartRate}</span>
              <span className="text-sm text-slate-400 font-medium">BPM</span>
            </div>
            {vitals.fingerPresent ? (
               <Heart className="h-8 w-8 text-rose-400 animate-pulse ml-2" style={{
                 animationDuration: typeof vitals.heartRate === 'number' && vitals.heartRate > 0 ? `${(60 / vitals.heartRate).toFixed(2)}s` : '0s'
               }} />
            ) : (
               <span className="text-[10px] text-amber-500 font-mono bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 ml-2">NO FINGER DETECTED</span>
            )}
          </div>
        </div>
        <div className="lg:w-1/2 bg-slate-950/60 rounded-xl p-4 border border-slate-900 flex flex-col justify-end">
           <div className="flex justify-between text-[9px] text-slate-500 font-mono mb-1 uppercase tracking-wider">
             <span>LAST {Math.min(vitals.heartRateHistory?.length || 0, 60)} READINGS</span>
             <span>REAL-TIME ECG TRACE</span>
           </div>
           <BPMSparkline history={vitals.heartRateHistory || []} currentBPM={vitals.heartRate} fingerPresent={vitals.fingerPresent} />
        </div>
      </div>

      {/* ── Vitals Grid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

        {/* SpO2 */}
        <div className="bg-slate-900/50 p-5 rounded-2xl border border-slate-800 hover:border-emerald-500/20 transition-all flex flex-col gap-3">
          <div className="flex justify-between items-start">
            <span className="text-[10px] text-slate-500 font-mono tracking-wider">OXYGEN SAT. (SpO2)</span>
            <Wind className="h-4 w-4 text-sky-400" />
          </div>
          <div>
            <span className="text-3xl font-black text-white">{vitals.oxygenSpO2}</span>
            <span className="text-sm text-slate-400 ml-1">%</span>
          </div>
          <span className={`text-[10px] font-mono font-bold ${spo2St.color}`}>
            ● {spo2St.label}
          </span>
        </div>

        {/* Blood Pressure */}
        <div className="bg-slate-900/50 p-5 rounded-2xl border border-slate-800 hover:border-emerald-500/20 transition-all flex flex-col gap-3">
          <div className="flex justify-between items-start">
            <span className="text-[10px] text-slate-500 font-mono tracking-wider">BLOOD PRESSURE</span>
            <Activity className="h-4 w-4 text-violet-400" />
          </div>
          <div>
            <span className="text-3xl font-black text-white">{vitals.systolicBP}/{vitals.diastolicBP}</span>
            <span className="text-xs text-slate-400 ml-1">mmHg</span>
          </div>
          <span className={`text-[10px] font-mono font-bold ${bpSt.color}`}>
            ● {bpSt.label}
          </span>
        </div>

        {/* Movement */}
        <div className="bg-slate-900/50 p-5 rounded-2xl border border-slate-800 hover:border-emerald-500/20 transition-all flex flex-col gap-3">
          <div className="flex justify-between items-start">
            <span className="text-[10px] text-slate-500 font-mono tracking-wider">MOVEMENT STATE</span>
            <MovementIcon className="h-4 w-4 text-amber-400" />
          </div>
          <div className="mt-1">
            <span className="text-xl font-bold text-white leading-tight">{vitals.movementState}</span>
          </div>
          <span className="text-[10px] font-mono text-slate-400">
            MPU6050 accelerometer
          </span>
        </div>

        {/* Room Presence */}
        <div className="bg-slate-900/50 p-5 rounded-2xl border border-slate-800 hover:border-emerald-500/20 transition-all flex flex-col gap-3">
          <div className="flex justify-between items-start">
            <span className="text-[10px] text-slate-500 font-mono tracking-wider">ROOM PRESENCE</span>
            <User className="h-4 w-4 text-teal-400" />
          </div>
          <div className="flex items-center gap-3 mt-1">
            <div className={`h-4 w-4 rounded-full ${vitals.roomPresence ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
            <span className="text-xl font-bold text-white">{vitals.roomPresence ? 'Present' : 'Absent'}</span>
          </div>
          <span className={`text-[10px] font-mono font-bold ${vitals.roomPresence ? 'text-emerald-400' : 'text-slate-500'}`}>
            ● Ultrasonic HC-SR04
          </span>
        </div>

      </div>

      {/* Sedentary time tracker */}
      <div className="bg-slate-900/35 border border-slate-800/80 rounded-2xl p-5 flex items-center gap-6">
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <Activity className="h-5 w-5 text-amber-400" />
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-bold text-white">Sedentary Time Tracker</h4>
          <p className="text-xs text-slate-400 mt-0.5">
            Patient has been {vitals.movementState === 'Resting' ? 'resting' : 'active'} for approximately&nbsp;
            <span className="text-amber-400 font-bold font-mono">{vitals.bloodLevelSeconds} min</span>.
            {vitals.bloodLevelSeconds > 45
              ? ' Consider encouraging gentle movement to improve circulation.'
              : ' Activity level within recommended parameters.'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <span className="text-xs text-slate-500 font-mono block">LAST UPDATE</span>
          <span className="text-sm font-bold text-slate-200 font-mono">{vitals.lastUpdated}</span>
        </div>
      </div>

    </div>
  );
}

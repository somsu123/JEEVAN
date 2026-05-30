/**
 * ============================================================
 *  SensorStatus.jsx — Sensor Health & Signal Quality
 * ============================================================
 *  Displays finger detection state, IR signal quality bars,
 *  and device uptime.
 * ============================================================
 */

import React from 'react';
import { Fingerprint, Signal, Timer, Cpu } from 'lucide-react';

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getSignalLevel(signal) {
  switch (signal) {
    case 'excellent': return { bars: 4, color: 'bg-emerald-400', label: 'Excellent' };
    case 'good':      return { bars: 3, color: 'bg-emerald-400', label: 'Good' };
    case 'fair':      return { bars: 2, color: 'bg-amber-400',   label: 'Fair' };
    case 'weak':      return { bars: 1, color: 'bg-red-400',     label: 'Weak' };
    default:          return { bars: 0, color: 'bg-slate-600',   label: 'Unknown' };
  }
}

function SignalBars({ signal }) {
  const { bars, color } = getSignalLevel(signal);
  const heights = [8, 14, 20, 26]; // px

  return (
    <div className="flex items-end gap-[3px]">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`w-[5px] rounded-sm transition-all duration-300 ${
            i < bars ? `${color} signal-bar-animate` : 'bg-slate-700'
          }`}
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  );
}

export default function SensorStatus({ sensorStatus }) {
  const { fingerDetected, signal, irValue, uptime } = sensorStatus;
  const signalInfo = getSignalLevel(signal);

  return (
    <div className="glass-card p-6" id="sensor-status">
      <div className="flex items-center gap-3 mb-5">
        <Cpu className="w-5 h-5 text-indigo-400" />
        <h2 className="text-lg font-semibold text-slate-200 tracking-tight">Sensor</h2>
      </div>

      <div className="space-y-4">
        {/* Finger Detection */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Fingerprint className={`w-5 h-5 ${fingerDetected ? 'text-emerald-400' : 'text-slate-500'}`} />
            <span className="text-sm text-slate-300">Finger</span>
          </div>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            fingerDetected
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-slate-600/20 text-slate-400 border border-slate-600/20'
          }`}>
            {fingerDetected ? 'Detected' : 'Not Detected'}
          </span>
        </div>

        {/* Signal Quality */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Signal className={`w-5 h-5 ${
              signalInfo.bars >= 3 ? 'text-emerald-400' :
              signalInfo.bars >= 2 ? 'text-amber-400' :
              signalInfo.bars >= 1 ? 'text-red-400' : 'text-slate-500'
            }`} />
            <span className="text-sm text-slate-300">Signal</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">{signalInfo.label}</span>
            <SignalBars signal={signal} />
          </div>
        </div>

        {/* IR Value */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 flex items-center justify-center">
              <div className={`w-2.5 h-2.5 rounded-full ${fingerDetected ? 'bg-red-500 animate-pulse' : 'bg-slate-600'}`} />
            </div>
            <span className="text-sm text-slate-300">IR Value</span>
          </div>
          <span className="text-xs text-slate-400 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
            {irValue > 0 ? irValue.toLocaleString() : '—'}
          </span>
        </div>

        {/* Uptime */}
        <div className="flex items-center justify-between pt-3 border-t border-white/[0.06]">
          <div className="flex items-center gap-3">
            <Timer className="w-5 h-5 text-slate-500" />
            <span className="text-sm text-slate-300">Device Uptime</span>
          </div>
          <span className="text-xs text-slate-400 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
            {formatUptime(uptime)}
          </span>
        </div>
      </div>
    </div>
  );
}

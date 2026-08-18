/**
 * ============================================================
 *  SpO2Card.jsx — Live SpO₂ Display
 * ============================================================
 *  Shows blood oxygen saturation from MAX30102 Red + IR LEDs.
 *  Color zones:
 *    • Green  (≥95%) — Normal
 *    • Amber  (90–94%) — Low / Caution
 *    • Red    (<90%) — Critical / Hypoxic
 *    • Grey   — No finger / algorithm initialising
 * ============================================================
 */

import React, { useMemo } from 'react';
import { Droplets } from 'lucide-react';

function getSpo2Zone(spo2, fingerDetected) {
  if (!fingerDetected || spo2 === null || spo2 === 0) {
    return {
      zone: 'inactive',
      color: 'text-slate-500',
      glow: '',
      label: 'No Signal',
      bgAccent: 'from-slate-800/40 to-slate-900/40',
      barColor: 'bg-slate-600',
    };
  }
  if (spo2 >= 95) {
    return {
      zone: 'normal',
      color: 'text-emerald-400',
      glow: 'drop-shadow-[0_0_12px_rgba(52,211,153,0.5)]',
      label: 'Normal',
      bgAccent: 'from-emerald-900/20 to-emerald-950/30',
      barColor: 'bg-emerald-400',
    };
  }
  if (spo2 >= 90) {
    return {
      zone: 'caution',
      color: 'text-amber-400',
      glow: 'drop-shadow-[0_0_12px_rgba(251,191,36,0.5)]',
      label: 'Low',
      bgAccent: 'from-amber-900/20 to-amber-950/30',
      barColor: 'bg-amber-400',
    };
  }
  return {
    zone: 'critical',
    color: 'text-red-400',
    glow: 'drop-shadow-[0_0_12px_rgba(248,113,113,0.5)]',
    label: 'Critical',
    bgAccent: 'from-red-900/20 to-red-950/30',
    barColor: 'bg-red-400',
  };
}

export default function SpO2Card({ spo2, fingerDetected, stats }) {
  const zone       = useMemo(() => getSpo2Zone(spo2, fingerDetected), [spo2, fingerDetected]);
  const displaySpo2 = fingerDetected && spo2 !== null && spo2 > 0 ? spo2 : '--';

  // Progress bar: map 85–100% → 0–100% fill
  const barPct = (spo2 && spo2 > 0)
    ? Math.min(100, Math.max(0, ((spo2 - 85) / 15) * 100))
    : 0;

  return (
    <div
      className={`glass-card p-8 relative overflow-hidden bg-gradient-to-br ${zone.bgAccent}`}
      id="spo2-card"
    >
      {/* Decorative rings */}
      <div className="absolute -right-12 -top-12 w-48 h-48 rounded-full border border-white/[0.03] pointer-events-none" />
      <div className="absolute -right-6  -top-6  w-36 h-36 rounded-full border border-white/[0.02] pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Droplets
            className={`w-7 h-7 ${zone.color} ${fingerDetected && spo2 > 0 ? 'animate-pulse' : ''}`}
            style={{ fill: fingerDetected && spo2 > 0 ? 'currentColor' : 'none' }}
          />
          <h2 className="text-lg font-semibold text-slate-200 tracking-tight">
            Blood Oxygen
          </h2>
        </div>

        {/* Zone badge */}
        <span className={`text-xs font-medium px-3 py-1 rounded-full border ${
          zone.zone === 'normal'   ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' :
          zone.zone === 'caution'  ? 'border-amber-500/30  bg-amber-500/10  text-amber-400'  :
          zone.zone === 'critical' ? 'border-red-500/30    bg-red-500/10    text-red-400'    :
          'border-slate-600/30 bg-slate-600/10 text-slate-400'
        }`}>
          {zone.label}
        </span>
      </div>

      {/* SpO₂ Value */}
      <div className="flex items-baseline gap-2 mb-5">
        <span
          className={`text-8xl font-black tracking-tighter tabular-nums ${zone.color} ${zone.glow} transition-all duration-300`}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {displaySpo2}
        </span>
        <span className="text-2xl font-medium text-slate-400">%</span>
      </div>

      {/* Saturation progress bar */}
      <div className="mb-5">
        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
          <span>85%</span>
          <span>SpO₂ Level</span>
          <span>100%</span>
        </div>
        <div className="h-2 w-full rounded-full bg-slate-700/60 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${zone.barColor}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
      </div>

      {/* Stats bar */}
      {stats && stats.count > 0 && (
        <div className="flex items-center gap-6 pt-4 border-t border-white/[0.06]">
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Min</span>
            <span className="text-lg font-semibold text-slate-300 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {stats.min > 0 ? `${stats.min}%` : '—'}
            </span>
          </div>
          <div className="w-px h-8 bg-white/[0.06]" />
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Avg</span>
            <span className="text-lg font-semibold text-slate-300 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {stats.avg > 0 ? `${stats.avg}%` : '—'}
            </span>
          </div>
          <div className="w-px h-8 bg-white/[0.06]" />
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Max</span>
            <span className="text-lg font-semibold text-slate-300 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {stats.max > 0 ? `${stats.max}%` : '—'}
            </span>
          </div>
          <div className="w-px h-8 bg-white/[0.06]" />
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Readings</span>
            <span className="text-lg font-semibold text-slate-300 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {stats.count}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

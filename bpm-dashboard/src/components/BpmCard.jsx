/**
 * ============================================================
 *  BpmCard.jsx — Live BPM Display with Heartbeat Animation
 * ============================================================
 *  Shows the current heart rate as a large animated number.
 *  Pulsing heart icon synced to BPM. Color-coded zones:
 *    • Green  (60–100) — Normal resting
 *    • Amber  (40–60 or 100–130) — Caution
 *    • Red    (<40 or >130) — Alert
 *    • Grey   — No finger / no data
 * ============================================================
 */

import React, { useMemo } from 'react';
import { Heart, HeartOff } from 'lucide-react';

function getBpmZone(bpm, fingerDetected) {
  if (!fingerDetected || bpm === null || bpm === 0) {
    return { zone: 'inactive', color: 'text-slate-500', glow: 'bpm-glow-muted', label: 'No Signal', bgAccent: 'from-slate-800/40 to-slate-900/40' };
  }
  if (bpm >= 60 && bpm <= 100) {
    return { zone: 'normal', color: 'text-emerald-400', glow: 'bpm-glow-green', label: 'Normal', bgAccent: 'from-emerald-900/20 to-emerald-950/30' };
  }
  if ((bpm >= 40 && bpm < 60) || (bpm > 100 && bpm <= 130)) {
    return { zone: 'caution', color: 'text-amber-400', glow: 'bpm-glow-amber', label: bpm < 60 ? 'Low' : 'Elevated', bgAccent: 'from-amber-900/20 to-amber-950/30' };
  }
  return { zone: 'alert', color: 'text-red-400', glow: 'bpm-glow-red', label: bpm < 40 ? 'Very Low' : 'High', bgAccent: 'from-red-900/20 to-red-950/30' };
}

export default function BpmCard({ bpm, fingerDetected, stats }) {
  const zone = useMemo(() => getBpmZone(bpm, fingerDetected), [bpm, fingerDetected]);

  // Pulse duration based on BPM (60 BPM = 1s interval)
  const pulseDuration = bpm && bpm > 0 ? `${(60 / bpm).toFixed(2)}s` : '1s';

  const displayBpm = fingerDetected && bpm !== null && bpm > 0 ? bpm : '--';

  return (
    <div className={`glass-card p-8 relative overflow-hidden bg-gradient-to-br ${zone.bgAccent}`} id="bpm-card">
      {/* Background decorative ring */}
      <div className="absolute -right-12 -top-12 w-48 h-48 rounded-full border border-white/[0.03] pointer-events-none" />
      <div className="absolute -right-6 -top-6 w-36 h-36 rounded-full border border-white/[0.02] pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="heart-pulse-dynamic"
            style={{ '--pulse-duration': pulseDuration }}
          >
            {fingerDetected ? (
              <Heart className={`w-7 h-7 ${zone.color} fill-current`} />
            ) : (
              <HeartOff className="w-7 h-7 text-slate-500" />
            )}
          </div>
          <h2 className="text-lg font-semibold text-slate-200 tracking-tight">Heart Rate</h2>
        </div>

        {/* Zone badge */}
        <span className={`text-xs font-medium px-3 py-1 rounded-full border ${
          zone.zone === 'normal' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' :
          zone.zone === 'caution' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' :
          zone.zone === 'alert' ? 'border-red-500/30 bg-red-500/10 text-red-400' :
          'border-slate-600/30 bg-slate-600/10 text-slate-400'
        }`}>
          {zone.label}
        </span>
      </div>

      {/* BPM Value */}
      <div className="flex items-baseline gap-3 mb-6">
        <span
          className={`text-8xl font-black tracking-tighter tabular-nums ${zone.color} ${zone.glow} transition-all duration-300`}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {displayBpm}
        </span>
        <span className="text-2xl font-medium text-slate-400">BPM</span>
      </div>

      {/* Stats bar */}
      {stats && stats.count > 0 && (
        <div className="flex items-center gap-6 pt-4 border-t border-white/[0.06]">
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Min</span>
            <span className="text-lg font-semibold text-slate-300 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {stats.min}
            </span>
          </div>
          <div className="w-px h-8 bg-white/[0.06]" />
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Avg</span>
            <span className="text-lg font-semibold text-slate-300 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {stats.avg}
            </span>
          </div>
          <div className="w-px h-8 bg-white/[0.06]" />
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Max</span>
            <span className="text-lg font-semibold text-slate-300 tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              {stats.max}
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

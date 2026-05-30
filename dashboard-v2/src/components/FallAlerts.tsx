import React, { useState } from 'react';
import {
  ShieldAlert,
  Camera,
  Watch,
  CheckCircle2,
  Clock,
  MapPin,
  AlertTriangle,
  Shield,
  Activity,
  Trash2,
} from 'lucide-react';
import { FallEvent } from '../types';

interface FallAlertsProps {
  fallEvents: FallEvent[];
  activeAlert: boolean;
  onResolveEvent: (id: string) => void;
  onClearAll: () => void;
}

function confidenceColor(conf: number) {
  if (conf >= 0.85) return 'text-rose-400';
  if (conf >= 0.65) return 'text-amber-400';
  return 'text-yellow-400';
}

function severityConfig(type: FallEvent['type']) {
  switch (type) {
    case 'Critical Fall':
      return {
        bg: 'bg-rose-500/10 border-rose-500/40',
        badge: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
        icon: ShieldAlert,
        iconColor: 'text-rose-400',
        dot: 'bg-rose-500',
      };
    case 'Rapid Descent':
      return {
        bg: 'bg-amber-500/10 border-amber-500/30',
        badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
        icon: AlertTriangle,
        iconColor: 'text-amber-400',
        dot: 'bg-amber-500',
      };
    default:
      return {
        bg: 'bg-yellow-500/10 border-yellow-500/30',
        badge: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
        icon: Activity,
        iconColor: 'text-yellow-400',
        dot: 'bg-yellow-500',
      };
  }
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.85 ? '#f43f5e' : value >= 0.65 ? '#f59e0b' : '#eab308';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className={`text-[10px] font-mono font-bold ${confidenceColor(value)}`}>{pct}%</span>
    </div>
  );
}

export default function FallAlerts({ fallEvents, activeAlert, onResolveEvent, onClearAll }: FallAlertsProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('all');

  const activeFalls = fallEvents.filter(e => e.status === 'active');
  const filtered = filter === 'all' ? fallEvents : fallEvents.filter(e => e.status === filter);

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/60 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-rose-400" />
            Fall Detection Monitor
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Dual-source detection: MediaPipe camera CV + ESP32 bracelet accelerometer (3-phase).
          </p>
        </div>
        <div className="flex items-center gap-3">
          {activeFalls.length > 0 ? (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-500/10 border border-rose-500/40 animate-pulse">
              <span className="h-2 w-2 bg-rose-500 rounded-full animate-ping" />
              <span className="text-sm font-bold text-rose-400 font-mono uppercase tracking-wide">
                {activeFalls.length} ACTIVE ALERT{activeFalls.length > 1 ? 'S' : ''}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
              <Shield className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-bold text-emerald-400 font-mono">ALL CLEAR</span>
            </div>
          )}
          {fallEvents.length > 0 && (
            <button
              onClick={onClearAll}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 transition"
              title="Clear all resolved events"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Monitoring Status Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10">
            <Camera className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <span className="text-[10px] text-slate-500 font-mono block">CAMERA VISION</span>
            <span className="text-sm font-bold text-emerald-400">MediaPipe Active</span>
          </div>
          <span className="ml-auto h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
        </div>
        <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/10">
            <Watch className="h-5 w-5 text-blue-400" />
          </div>
          <div>
            <span className="text-[10px] text-slate-500 font-mono block">WRIST BRACELET</span>
            <span className="text-sm font-bold text-blue-400">MPU6050 Online</span>
          </div>
          <span className="ml-auto h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
        </div>
        <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-violet-500/10">
            <Activity className="h-5 w-5 text-violet-400" />
          </div>
          <div>
            <span className="text-[10px] text-slate-500 font-mono block">TOTAL EVENTS</span>
            <span className="text-sm font-bold text-white">{fallEvents.length} logged</span>
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      {fallEvents.length > 0 && (
        <div className="flex gap-2">
          {(['all', 'active', 'resolved'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold capitalize transition-all ${
                filter === f
                  ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                  : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {f} {f === 'active' ? `(${activeFalls.length})` : f === 'all' ? `(${fallEvents.length})` : ''}
            </button>
          ))}
        </div>
      )}

      {/* Event timeline */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
          <div className="p-5 rounded-2xl bg-emerald-500/5 border border-emerald-500/10">
            <Shield className="h-12 w-12 text-emerald-500/40" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-300">No Fall Events Detected</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-sm">
              Both the camera (MediaPipe) and wrist bracelet are actively monitoring.
              Any detected event will appear here immediately.
            </p>
          </div>
          <div className="px-4 py-2 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400">
            Pi camera script: <span className="text-emerald-400">pi-fall-detector/fall_detector.py</span>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((event) => {
            const cfg = severityConfig(event.type);
            const Icon = cfg.icon;
            const SourceIcon = event.source === 'camera' ? Camera : Watch;

            return (
              <div
                key={event.id}
                className={`p-4 rounded-2xl border transition-all ${
                  event.status === 'resolved'
                    ? 'bg-slate-900/30 border-slate-800/60 opacity-60'
                    : cfg.bg
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  <div className={`p-2.5 rounded-xl border shrink-0 ${
                    event.status === 'resolved'
                      ? 'bg-slate-800 border-slate-700'
                      : 'bg-slate-950/60 border-slate-800'
                  }`}>
                    {event.status === 'resolved'
                      ? <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                      : <Icon className={`h-5 w-5 ${cfg.iconColor}`} />
                    }
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${cfg.badge}`}>
                        {event.type.toUpperCase()}
                      </span>
                      <span className="flex items-center gap-1 text-[10px] text-slate-400 font-mono">
                        <SourceIcon className="h-3 w-3" />
                        {event.source.toUpperCase()}
                      </span>
                      {event.status === 'resolved' && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          RESOLVED {event.resolvedAt ? `@ ${event.resolvedAt}` : ''}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 mb-2 text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {event.timestamp}
                      </span>
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {event.location}
                      </span>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                        <span>Detection confidence</span>
                      </div>
                      <ConfidenceMeter value={event.confidence} />
                    </div>
                  </div>

                  {/* Resolve action */}
                  {event.status === 'active' && (
                    <button
                      onClick={() => onResolveEvent(event.id)}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-emerald-500/10 border border-slate-700 hover:border-emerald-500/30 text-xs font-bold text-slate-400 hover:text-emerald-400 font-mono transition-all"
                    >
                      Resolve
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pi script info box */}
      <div className="bg-slate-900/30 border border-slate-800/50 rounded-2xl p-5">
        <h4 className="text-xs font-bold text-slate-300 font-mono uppercase tracking-wider mb-3">
          Hardware Integration Guide
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-400">
          <div className="space-y-1">
            <span className="text-emerald-400 font-bold block">Raspberry Pi Camera</span>
            <code className="text-slate-400 font-mono text-[10px] bg-slate-950/60 px-2 py-1 rounded block">
              python pi-fall-detector/fall_detector.py
            </code>
            <p className="text-[10px] leading-relaxed">
              MediaPipe Pose + skeleton detection. Posts to /api/fall-event on detection.
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-blue-400 font-bold block">ESP32 Wrist Bracelet</span>
            <code className="text-slate-400 font-mono text-[10px] bg-slate-950/60 px-2 py-1 rounded block">
              hardware/braclet_bpm.ino → /api/fall-event
            </code>
            <p className="text-[10px] leading-relaxed">
              3-phase fall detection: free-fall → impact → confirm. MPU6050 at ±8g range.
            </p>
          </div>
        </div>
      </div>

    </div>
  );
}

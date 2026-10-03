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
  if (conf >= 0.85) return 'text-rose-700';
  if (conf >= 0.65) return 'text-amber-800';
  return 'text-amber-700';
}

function severityConfig(type: FallEvent['type']) {
  switch (type) {
    case 'Critical Fall':
      return {
        bg: 'border-l-4 border-l-rose-500 bg-white border-t border-r border-b border-slate-200 shadow-xs',
        badge: 'bg-rose-50 text-rose-700 border-rose-200 font-bold',
        icon: ShieldAlert,
        iconColor: 'text-rose-600',
      };
    case 'Rapid Descent':
      return {
        bg: 'border-l-4 border-l-amber-500 bg-white border-t border-r border-b border-slate-200 shadow-xs',
        badge: 'bg-amber-50 text-amber-800 border-amber-200 font-bold',
        icon: AlertTriangle,
        iconColor: 'text-amber-600',
      };
    default:
      return {
        bg: 'border-l-4 border-l-blue-500 bg-white border-t border-r border-b border-slate-200 shadow-xs',
        badge: 'bg-blue-50 text-blue-700 border-blue-200 font-bold',
        icon: Activity,
        iconColor: 'text-blue-600',
      };
  }
}

function ConfidenceMeter({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="text-xs text-slate-400 font-medium">Telemetry Available</span>;
  }
  const pct = Math.round(value * 100);
  const color = value >= 0.85 ? '#f43f5e' : value >= 0.65 ? '#f59e0b' : '#3b82f6';
  return (
    <div className="flex items-center gap-2.5 max-w-[220px]">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden border border-slate-200/60">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className={`text-xs font-bold ${confidenceColor(value)}`}>{pct}% confidence</span>
    </div>
  );
}

export default function FallAlerts({ fallEvents, activeAlert, onResolveEvent, onClearAll }: FallAlertsProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('all');

  const activeFalls = fallEvents.filter(e => e.status === 'active');
  const filtered = filter === 'all' ? fallEvents : fallEvents.filter(e => e.status === filter);

  return (
    <div className="flex flex-col gap-6 relative">
      {/* ── Header ── */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-800 tracking-tight flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-rose-50 text-rose-600 border border-rose-100">
              <ShieldAlert className="h-6 w-6" />
            </div>
            Fall Safety & Incident Alerts
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            Continuous real-time safety monitoring via Camera Vision AI and Wearable Wrist Accelerometer.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {activeFalls.length > 0 ? (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-rose-50 border border-rose-200 shadow-2xs animate-pulse">
              <span className="h-2.5 w-2.5 bg-rose-600 rounded-full pulse-red-dot" />
              <span className="text-xs font-bold text-rose-700 uppercase tracking-wide">
                {activeFalls.length} Active Emergency Alert{activeFalls.length > 1 ? 's' : ''}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-50 border border-emerald-200 shadow-2xs">
              <Shield className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-bold text-emerald-700 tracking-wide">All Clear • No Active Fall Events</span>
            </div>
          )}
          {fallEvents.length > 0 && (
            <button
              onClick={onClearAll}
              className="p-2.5 rounded-2xl bg-white border border-slate-200 hover:border-rose-200 text-slate-400 hover:text-rose-600 shadow-2xs transition-all cursor-pointer"
              title="Clear all resolved events"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* ── Stats Row (3 cards) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <div className="bg-white border border-slate-200 rounded-3xl p-5 flex items-center gap-4 shadow-xs">
          <div className="p-3 rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-100">
            <Camera className="h-5 w-5" />
          </div>
          <div>
            <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Camera Sensor</span>
            <span className="text-sm font-bold text-slate-800 font-headline mt-0.5 block">Vision AI Active</span>
          </div>
          <span className="ml-auto h-2.5 w-2.5 rounded-full bg-emerald-500 pulse-emerald" />
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl p-5 flex items-center gap-4 shadow-xs">
          <div className="p-3 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
            <Watch className="h-5 w-5" />
          </div>
          <div>
            <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Wrist Bracelet</span>
            <span className="text-sm font-bold text-slate-800 font-headline mt-0.5 block">MPU-6050 6-Axis</span>
          </div>
          <span className="ml-auto h-2.5 w-2.5 rounded-full bg-blue-500" />
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl p-5 flex items-center gap-4 shadow-xs">
          <div className="p-3 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Total History</span>
            <span className="text-sm font-bold text-slate-800 font-headline mt-0.5 block">{fallEvents.length} Recorded</span>
          </div>
        </div>
      </div>

      {/* ── Filter Tabs ── */}
      {fallEvents.length > 0 && (
        <div className="flex gap-2">
          {(['all', 'active', 'resolved'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2.5 rounded-2xl text-xs font-semibold capitalize transition-all cursor-pointer ${
                filter === f
                  ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-2xs font-bold'
                  : 'bg-white text-slate-600 border border-slate-200 hover:text-slate-800'
              }`}
            >
              {f} {f === 'active' ? `(${activeFalls.length})` : f === 'all' ? `(${fallEvents.length})` : ''}
            </button>
          ))}
        </div>
      )}

      {/* ── Event Timeline ── */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-3xl flex flex-col items-center justify-center py-16 text-center space-y-3 shadow-xs">
          <div className="p-4 rounded-3xl bg-emerald-50 border border-emerald-100 text-emerald-600">
            <Shield className="h-10 w-10" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-800 font-headline">Zero Fall Incidents Detected</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-sm">
              Continuous monitoring active across vision models and wearable motion sensors.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3.5">
          {filtered.map((event) => {
            const cfg = severityConfig(event.type);
            const Icon = cfg.icon;
            const SourceIcon = event.source === 'camera' ? Camera : Watch;

            return (
              <div
                key={event.id}
                className={`p-5 rounded-3xl transition-all ${
                  event.status === 'resolved'
                    ? 'bg-slate-50/70 border border-slate-200'
                    : cfg.bg
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  <div className={`p-3 rounded-2xl border shrink-0 ${
                    event.status === 'resolved'
                      ? 'bg-white border-slate-200 text-slate-400'
                      : 'bg-slate-50 border-slate-200'
                  }`}>
                    {event.status === 'resolved'
                      ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      : <Icon className={`h-5 w-5 ${cfg.iconColor}`} />
                    }
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${cfg.badge}`}>
                        {event.type}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-slate-600 font-medium">
                        <SourceIcon className="h-3.5 w-3.5 text-slate-500" />
                        {event.source === 'camera' ? 'Camera Vision' : 'Wrist Sensor'}
                      </span>
                      {event.status === 'resolved' && (
                        <span className="px-3 py-1 rounded-full text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                          Resolved {event.resolvedAt ? `@ ${event.resolvedAt}` : ''}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-4 mb-2 text-xs text-slate-500 font-medium">
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-slate-400" />
                        {event.timestamp}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 text-slate-400" />
                        {event.location}
                      </span>
                    </div>

                    <div className="space-y-1">
                      <span className="text-xs text-slate-400 font-medium">Detection Confidence</span>
                      <ConfidenceMeter value={event.confidence} />
                    </div>
                  </div>

                  {/* Resolve action */}
                  {event.status === 'active' && (
                    <button
                      onClick={() => onResolveEvent(event.id)}
                      className="shrink-0 px-4 py-2.5 rounded-2xl bg-white hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-xs font-bold text-slate-700 hover:text-emerald-700 transition-all shadow-2xs cursor-pointer"
                    >
                      Acknowledge & Resolve
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Hardware Integration Guide ── */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs">
        <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">
          Configured Sensor Detection Pipelines
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600">
          <div className="space-y-1.5 p-4 bg-slate-50 rounded-2xl border border-slate-200">
            <span className="text-emerald-700 font-bold block text-sm">Camera Skeleton Pose Tracking</span>
            <p className="text-xs leading-relaxed text-slate-500">
              Vision AI continuously scanning for sudden vertical falls and floor posture.
            </p>
          </div>
          <div className="space-y-1.5 p-4 bg-slate-50 rounded-2xl border border-slate-200">
            <span className="text-blue-700 font-bold block text-sm">ESP32 Wrist IMU Sensor</span>
            <p className="text-xs leading-relaxed text-slate-500">
              MPU-6050 accelerometer tracking free-fall acceleration drops followed by impact deceleration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

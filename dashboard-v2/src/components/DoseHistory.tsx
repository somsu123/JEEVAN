import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, XCircle, Clock, Package, RefreshCw, Loader2,
  BarChart3, Filter,
} from 'lucide-react';
import { DoseEvent } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

const COMP_NAMES  = ['Compartment 0', 'Compartment 1', 'Compartment 2', 'Compartment 3'];
const COMP_COLORS = ['text-emerald-400', 'text-blue-400', 'text-violet-400', 'text-amber-400'];
const COMP_BG     = ['bg-emerald-500/10', 'bg-blue-500/10', 'bg-violet-500/10', 'bg-amber-500/10'];

// ─── Adherence bar ────────────────────────────────────────────────────────────
function AdherenceBar({ taken, missed }: { taken: number; missed: number }) {
  const total = taken + missed;
  const pct = total > 0 ? Math.round((taken / total) * 100) : 0;
  const color = pct >= 85 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  const label = pct >= 85 ? 'Good' : pct >= 60 ? 'Moderate' : 'Poor';
  const labelColor = pct >= 85 ? 'text-emerald-400' : pct >= 60 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-slate-400">Adherence</span>
        <span className={`font-bold ${labelColor}`}>{pct}% · {label}</span>
      </div>
      <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-slate-500">
        <span className="text-emerald-400">{taken} taken</span>
        <span className="text-red-400">{missed} missed</span>
        <span>{total} total</span>
      </div>
    </div>
  );
}

// ─── Mini adherence chart ─────────────────────────────────────────────────────
function MiniBarChart({ events }: { events: DoseEvent[] }) {
  // Group last 14 days by date
  const today = new Date();
  const days: { label: string; taken: number; missed: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dayEvents = events.filter(e => {
      const ed = new Date(e.loggedAt);
      return ed.toDateString() === d.toDateString();
    });
    days.push({
      label: i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
      taken: dayEvents.filter(e => e.status === 'taken').length,
      missed: dayEvents.filter(e => e.status === 'missed').length,
    });
  }

  const maxVal = Math.max(...days.map(d => d.taken + d.missed), 1);

  return (
    <div className="flex items-end gap-1 h-16">
      {days.map((d, i) => {
        const total = d.taken + d.missed;
        const takenH = total > 0 ? Math.round((d.taken / maxVal) * 64) : 0;
        const missedH = total > 0 ? Math.round((d.missed / maxVal) * 64) : 0;
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative" title={`${d.label}: ${d.taken} taken, ${d.missed} missed`}>
            <div className="w-full flex flex-col justify-end" style={{ height: 56 }}>
              {missedH > 0 && <div className="w-full rounded-t-sm bg-red-500/50" style={{ height: missedH }} />}
              {takenH > 0 && <div className={`w-full rounded-sm ${d.missed === 0 ? 'rounded-t-sm' : ''} bg-emerald-500/60`} style={{ height: takenH }} />}
              {total === 0 && <div className="w-full rounded-sm bg-slate-800" style={{ height: 4 }} />}
            </div>
            <span className="text-[8px] font-mono text-slate-600 truncate w-full text-center">{d.label.slice(0, 3)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Timeline event row ───────────────────────────────────────────────────────
function EventRow({ event }: { event: DoseEvent }) {
  const c = event.compartment % 4;
  const taken = event.status === 'taken';
  return (
    <div className={`flex items-start gap-4 py-3 border-b border-slate-800/60 last:border-0 group`}>
      {/* Status icon */}
      <div className={`mt-0.5 shrink-0 p-1.5 rounded-lg ${taken ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
        {taken
          ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          : <XCircle className="h-4 w-4 text-red-400" />}
      </div>
      {/* Medicine info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold text-slate-200 leading-tight">{event.label}</p>
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ${COMP_BG[c]} ${COMP_COLORS[c]}`}>
            {COMP_NAMES[c]}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[11px] font-mono text-slate-500">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" /> Scheduled {fmt12(event.scheduledTime)}
          </span>
          {taken && event.takenAt && (
            <span className="text-emerald-500">Taken {fmtTime(event.takenAt)}</span>
          )}
          {!taken && <span className="text-red-500">Missed</span>}
        </div>
      </div>
      {/* Date */}
      <div className="text-right shrink-0">
        <p className="text-[10px] font-mono text-slate-500">{fmtDate(event.loggedAt)}</p>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function DoseHistory() {
  const [events, setEvents]           = useState<DoseEvent[]>([]);
  const [loading, setLoading]         = useState(true);
  const [compFilter, setCompFilter]   = useState<number | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'taken' | 'missed'>('all');

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/dose-events?limit=200');
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events || []);
      }
    } catch { /* offline */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // SSE: real-time dose updates
  useEffect(() => {
    let src: EventSource | null = null;
    try {
      src = new EventSource('/api/events-stream');
      src.addEventListener('dose_event', (e) => {
        const ev = JSON.parse(e.data);
        setEvents(prev => [{
          id: `sse-${Date.now()}`,
          compartment: ev.compartment,
          label: ev.label,
          scheduledTime: ev.scheduledTime || '--:--',
          takenAt: ev.takenAt || null,
          status: ev.status,
          loggedAt: new Date().toISOString(),
        } as DoseEvent, ...prev]);
      });
    } catch {}
    return () => src?.close();
  }, []);

  // Filtered events
  const filtered = events.filter(e => {
    if (compFilter !== 'all' && e.compartment !== compFilter) return false;
    if (statusFilter !== 'all' && e.status !== statusFilter) return false;
    return true;
  });

  const taken = events.filter(e => e.status === 'taken').length;
  const missed = events.filter(e => e.status === 'missed').length;

  // Group by date for the timeline
  const grouped: { date: string; events: DoseEvent[] }[] = [];
  for (const ev of filtered) {
    const dateStr = fmtDate(ev.loggedAt);
    const group = grouped.find(g => g.date === dateStr);
    if (group) group.events.push(ev);
    else grouped.push({ date: dateStr, events: [ev] });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-100 tracking-tight flex items-center gap-3">
            <BarChart3 className="h-6 w-6 text-emerald-400" /> Dose History
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Adherence log automatically built from ESP32 polling — {events.length} events recorded
          </p>
        </div>
        <button onClick={fetchEvents} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl glass-card hover:border-emerald-500/30 text-xs text-slate-400 hover:text-emerald-400 transition-all self-start">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* ── LEFT: Summary cards + chart ── */}
        <div className="space-y-4">

          {/* Adherence summary */}
          <div className="glass-card rounded-2xl p-5 space-y-4">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono flex items-center gap-2">
              <BarChart3 className="h-3.5 w-3.5" /> Overall Adherence
            </h2>
            <AdherenceBar taken={taken} missed={missed} />
          </div>

          {/* 14-day bar chart */}
          <div className="glass-card rounded-2xl p-5 space-y-3">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">14-day Overview</h2>
            <MiniBarChart events={events} />
            <div className="flex items-center gap-4 text-[10px] font-mono text-slate-500">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/60 inline-block" /> Taken</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/50 inline-block" /> Missed</span>
            </div>
          </div>

          {/* Per-compartment stats */}
          <div className="glass-card rounded-2xl p-5 space-y-3">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono flex items-center gap-2">
              <Package className="h-3.5 w-3.5" /> Per-Compartment
            </h2>
            {[0, 1, 2, 3].map(comp => {
              const compEvents = events.filter(e => e.compartment === comp);
              const t = compEvents.filter(e => e.status === 'taken').length;
              const m = compEvents.filter(e => e.status === 'missed').length;
              const pct = t + m > 0 ? Math.round(t / (t + m) * 100) : 0;
              const label = compEvents[0]?.label || '(empty)';
              return (
                <div key={comp} className="flex items-center gap-3">
                  <div className={`p-1.5 rounded-lg ${COMP_BG[comp]} shrink-0`}>
                    <Package className={`h-3.5 w-3.5 ${COMP_COLORS[comp]}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-200 truncate">{label}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div className={`h-full ${pct >= 85 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500'} rounded-full`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] font-mono text-slate-400 shrink-0">{pct}%</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT: Filtered timeline ── */}
        <div className="xl:col-span-2 space-y-4">

          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <Filter className="h-3.5 w-3.5 text-slate-500" />

            {/* Compartment filter */}
            <div className="flex gap-1.5">
              {(['all', 0, 1, 2, 3] as const).map(comp => (
                <button key={comp} onClick={() => setCompFilter(comp)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold transition-all ${
                    compFilter === comp
                      ? 'bg-slate-700 text-white border border-slate-600'
                      : 'text-slate-500 hover:text-slate-300 border border-transparent'
                  }`}>
                  {comp === 'all' ? 'All' : `C${comp}`}
                </button>
              ))}
            </div>

            <div className="h-4 w-px bg-slate-800" />

            {/* Status filter */}
            <div className="flex gap-1.5">
              {(['all', 'taken', 'missed'] as const).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold capitalize transition-all ${
                    statusFilter === s
                      ? s === 'taken'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : s === 'missed'
                          ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                          : 'bg-slate-700 text-white border border-slate-600'
                      : 'text-slate-500 hover:text-slate-300 border border-transparent'
                  }`}>
                  {s}
                </button>
              ))}
            </div>

            <span className="ml-auto text-[10px] font-mono text-slate-500">{filtered.length} events</span>
          </div>

          {/* Timeline */}
          <div className="glass-card rounded-2xl p-5">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 text-slate-600 animate-spin" />
              </div>
            ) : events.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <Clock className="h-10 w-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-mono">No dose events recorded yet</p>
                <p className="text-xs mt-1 text-slate-600">Events are logged automatically when the ESP32 polls.</p>
                <p className="text-xs mt-1 text-slate-700">Make sure ESP32_BASE_URL is set in your .env file.</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <Filter className="h-8 w-8 mx-auto mb-2 opacity-20" />
                <p className="text-sm font-mono">No events match current filters</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800/40">
                {grouped.map(group => (
                  <div key={group.date}>
                    <div className="py-2 sticky top-0 bg-slate-900/80 backdrop-blur-sm z-10">
                      <p className="text-[10px] font-mono text-slate-500 font-bold uppercase tracking-widest">{group.date}</p>
                    </div>
                    {group.events.map(ev => <EventRow key={ev.id} event={ev} />)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

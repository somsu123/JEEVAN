import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, XCircle, Clock, Package, RefreshCw, Loader2,
  BarChart3, Filter,
} from 'lucide-react';
import { DoseEvent } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt12(hhmm: string): string {
  if (!hhmm || !hhmm.includes(':')) return '08:00 AM';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

const COMP_NAMES  = ['Compartment 1', 'Compartment 2', 'Compartment 3', 'Compartment 4'];
const COMP_COLORS = ['text-emerald-700', 'text-blue-700', 'text-purple-700', 'text-amber-800'];
const COMP_BG     = ['bg-emerald-50', 'bg-blue-50', 'bg-purple-50', 'bg-amber-50'];

// ─── Adherence bar ────────────────────────────────────────────────────────────
function AdherenceBar({ taken, missed }: { taken: number; missed: number }) {
  const total = taken + missed;
  const pct = total > 0 ? Math.round((taken / total) * 100) : 0;
  const color = pct >= 85 ? 'bg-emerald-600' : pct >= 60 ? 'bg-amber-500' : 'bg-rose-500';
  const label = pct >= 85 ? 'Optimal Adherence' : pct >= 60 ? 'Moderate' : 'Needs Attention';
  const labelColor = pct >= 85 ? 'text-emerald-700' : pct >= 60 ? 'text-amber-800' : 'text-rose-700';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500 font-semibold uppercase tracking-wider">Overall Dose Compliance</span>
        <span className={`font-bold ${labelColor}`}>{pct}% · {label}</span>
      </div>
      <div className="h-3 rounded-full bg-slate-100 border border-slate-200/60 overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-xs font-medium text-slate-500">
        <span className="text-emerald-700 font-bold">{taken} taken</span>
        <span className="text-rose-600 font-bold">{missed} missed</span>
        <span>{total} total logged</span>
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
    <div className="flex items-end gap-2 h-24 pt-2">
      {days.map((d, i) => {
        const total = d.taken + d.missed;
        const takenH = total > 0 ? Math.round((d.taken / maxVal) * 64) : 0;
        const missedH = total > 0 ? Math.round((d.missed / maxVal) * 64) : 0;
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 group relative" title={`${d.label}: ${d.taken} taken, ${d.missed} missed`}>
            <div className="w-full flex flex-col justify-end" style={{ height: 64 }}>
              {missedH > 0 && <div className="w-full rounded-t-sm bg-rose-400" style={{ height: missedH }} />}
              {takenH > 0 && <div className={`w-full rounded-sm ${d.missed === 0 ? 'rounded-t-sm' : ''} bg-emerald-500`} style={{ height: takenH }} />}
              {total === 0 && <div className="w-full rounded-sm bg-slate-100" style={{ height: 4 }} />}
            </div>
            <span className="text-xs text-slate-500 truncate w-full text-center font-medium">{d.label.slice(0, 3)}</span>
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
    <div className="flex items-start gap-4 py-4 border-b border-slate-100 last:border-0 group hover:bg-slate-50/60 transition px-2 rounded-2xl">
      {/* Status icon */}
      <div className={`mt-0.5 shrink-0 p-2.5 rounded-2xl border ${taken ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-rose-50 text-rose-600 border-rose-200'}`}>
        {taken
          ? <CheckCircle2 className="h-5 w-5" />
          : <XCircle className="h-5 w-5" />}
      </div>
      {/* Medicine info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <p className="text-sm font-bold text-slate-800 leading-tight">{event.label}</p>
          <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border border-slate-200/80 ${COMP_BG[c]} ${COMP_COLORS[c]}`}>
            {COMP_NAMES[c]}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500">
          <span className="flex items-center gap-1 font-medium">
            <Clock className="h-3.5 w-3.5 text-slate-400" /> Scheduled {fmt12(event.scheduledTime)}
          </span>
          {taken && event.takenAt && (
            <span className="text-emerald-700 font-semibold">Taken at {fmtTime(event.takenAt)}</span>
          )}
          {!taken && <span className="text-rose-600 font-semibold">Missed dose</span>}
        </div>
      </div>
      {/* Date */}
      <div className="text-right shrink-0">
        <p className="text-xs text-slate-400 font-medium">{fmtDate(event.loggedAt)}</p>
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
          <h1 className="text-2xl font-headline font-bold text-slate-800 tracking-tight flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
              <BarChart3 className="h-6 w-6" />
            </div>
            Medication History &amp; Compliance Logs
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            Automated compliance logs captured from Smart MedBox — {events.length} events recorded
          </p>
        </div>
        <button onClick={fetchEvents} className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-xs self-start cursor-pointer">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* ── LEFT: Summary cards + chart ── */}
        <div className="space-y-5">

          {/* Adherence summary */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-4 shadow-xs">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-blue-600" /> Overall Compliance
            </h2>
            <AdherenceBar taken={taken} missed={missed} />
          </div>

          {/* 14-day bar chart */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-3 shadow-xs">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider">14-Day Compliance Trend</h2>
            <MiniBarChart events={events} />
            <div className="flex items-center gap-5 text-xs text-slate-500 pt-3 border-t border-slate-100">
              <span className="flex items-center gap-1.5 font-medium"><span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" /> Taken</span>
              <span className="flex items-center gap-1.5 font-medium"><span className="w-3 h-3 rounded-sm bg-rose-400 inline-block" /> Missed</span>
            </div>
          </div>

          {/* Per-compartment stats */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-3 shadow-xs">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <Package className="h-4 w-4 text-blue-600" /> Per-Compartment Breakdown
            </h2>
            {[0, 1, 2, 3].map(comp => {
              const compEvents = events.filter(e => e.compartment === comp);
              const t = compEvents.filter(e => e.status === 'taken').length;
              const m = compEvents.filter(e => e.status === 'missed').length;
              const pct = t + m > 0 ? Math.round(t / (t + m) * 100) : 0;
              const label = compEvents[0]?.label || `Slot ${comp + 1}`;
              return (
                <div key={comp} className="flex items-center gap-3.5 p-3 rounded-2xl bg-slate-50/70 border border-slate-200/80">
                  <div className={`p-2.5 rounded-xl ${COMP_BG[comp]} border border-slate-200/60 shrink-0`}>
                    <Package className={`h-4 w-4 ${COMP_COLORS[comp]}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-800 truncate">{label}</p>
                    <div className="flex items-center gap-2.5 mt-1.5">
                      <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                        <div className={`h-full ${pct >= 85 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-rose-500'} rounded-full`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs font-bold text-slate-700 shrink-0">{pct}%</span>
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
            <Filter className="h-4 w-4 text-slate-400" />

            {/* Compartment filter */}
            <div className="flex gap-1.5">
              {(['all', 0, 1, 2, 3] as const).map(comp => (
                <button key={comp} onClick={() => setCompFilter(comp)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all shadow-2xs cursor-pointer ${
                    compFilter === comp
                      ? 'bg-blue-600 text-white shadow-xs font-bold'
                      : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                  }`}>
                  {comp === 'all' ? 'All Slots' : `Slot ${comp + 1}`}
                </button>
              ))}
            </div>

            <div className="h-4 w-px bg-slate-200" />

            {/* Status filter */}
            <div className="flex gap-1.5">
              {(['all', 'taken', 'missed'] as const).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold capitalize transition-all shadow-2xs cursor-pointer ${
                    statusFilter === s
                      ? s === 'taken'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 font-bold'
                        : s === 'missed'
                          ? 'bg-rose-50 text-rose-700 border border-rose-300 font-bold'
                          : 'bg-blue-600 text-white font-bold'
                      : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                  }`}>
                  {s}
                </button>
              ))}
            </div>

            <span className="ml-auto text-xs font-semibold text-slate-500">{filtered.length} events</span>
          </div>

          {/* Timeline */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 text-blue-600 animate-spin" />
              </div>
            ) : events.length === 0 ? (
              <div className="text-center py-14 text-slate-400">
                <Clock className="h-10 w-10 mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-semibold text-slate-700">No dose events recorded yet</p>
                <p className="text-xs mt-1 text-slate-400">Events are logged automatically when the ESP32 MedBox records activity.</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-14 text-slate-400">
                <Filter className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                <p className="text-sm font-semibold text-slate-700">No events match current filters</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {grouped.map(group => (
                  <div key={group.date}>
                    <div className="py-3 sticky top-0 bg-white/95 backdrop-blur-sm z-10 border-b border-slate-100 mb-1">
                      <p className="text-xs text-slate-600 font-bold uppercase tracking-wider">{group.date}</p>
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

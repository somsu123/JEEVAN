import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  CheckCircle2, XCircle, Clock, Package, RefreshCw, Loader2,
  BarChart3, Filter, SlidersHorizontal, ChevronLeft, ChevronRight, Calendar,
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

// ─── Compliance Trend Chart with Horizontal Slider & Scroll Protection ───────────
function ComplianceTrendChart({ events }: { events: DoseEvent[] }) {
  const [dayRange, setDayRange] = useState<number>(14);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Group days by date based on slider range
  const today = new Date();
  const days: { label: string; fullDate: string; taken: number; missed: number; total: number }[] = [];
  for (let i = dayRange - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dayEvents = events.filter(e => {
      const ed = new Date(e.loggedAt);
      return ed.toDateString() === d.toDateString();
    });
    const taken = dayEvents.filter(e => e.status === 'taken').length;
    const missed = dayEvents.filter(e => e.status === 'missed').length;
    days.push({
      label: i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
      fullDate: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      taken,
      missed,
      total: taken + missed,
    });
  }

  const maxVal = Math.max(...days.map(d => d.taken + d.missed), 1);

  // Auto-scroll to "Today" on range change
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = scrollContainerRef.current.scrollWidth;
    }
  }, [dayRange]);

  const handleScroll = (offset: number) => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({ left: offset, behavior: 'smooth' });
    }
  };

  return (
    <div className="space-y-3.5 overflow-hidden">
      {/* Horizontal Range Slider Control */}
      <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 font-bold text-slate-700">
            <SlidersHorizontal className="h-3.5 w-3.5 text-blue-600" />
            <span>Range:</span>
            <span className="px-2 py-0.5 rounded-lg bg-blue-100/80 text-blue-800 font-bold">
              Last {dayRange} Days
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleScroll(-120)}
              title="Scroll left"
              className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 hover:text-slate-700 transition cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleScroll(120)}
              title="Scroll right"
              className="p-1 rounded-lg hover:bg-slate-200 text-slate-500 hover:text-slate-700 transition cursor-pointer"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Range Slider Track */}
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-semibold text-slate-400 shrink-0">7d</span>
          <input
            type="range"
            min="7"
            max="30"
            step="1"
            value={dayRange}
            onChange={(e) => setDayRange(Number(e.target.value))}
            className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <span className="text-[11px] font-semibold text-slate-400 shrink-0">30d</span>
        </div>
      </div>

      {/* Horizontally Scrollable Bar Container (Bounded & Protected) */}
      <div
        ref={scrollContainerRef}
        className="overflow-x-auto custom-scrollbar pb-2.5 pt-1 px-1 -mx-1"
      >
        <div className="flex items-end gap-1.5 min-w-max h-28 px-1">
          {days.map((d, i) => {
            const takenPct = maxVal > 0 ? (d.taken / maxVal) * 100 : 0;
            const missedPct = maxVal > 0 ? (d.missed / maxVal) * 100 : 0;
            const isToday = i === days.length - 1;

            return (
              <div
                key={i}
                className={`flex flex-col items-center gap-1.5 w-11 shrink-0 p-1 rounded-xl transition-all ${
                  isToday
                    ? 'bg-blue-50/70 border border-blue-200 shadow-2xs'
                    : 'hover:bg-slate-50 border border-transparent hover:border-slate-200'
                }`}
                title={`${d.fullDate} (${d.label}): ${d.taken} taken, ${d.missed} missed`}
              >
                {/* Bar track */}
                <div className="w-full flex flex-col justify-end h-16 bg-slate-100 rounded-lg overflow-hidden p-0.5 relative">
                  {missedPct > 0 && (
                    <div
                      className="w-full rounded-t-sm bg-rose-400 transition-all duration-300"
                      style={{ height: `${Math.min(100, Math.max(8, missedPct))}%` }}
                    />
                  )}
                  {takenPct > 0 && (
                    <div
                      className={`w-full rounded-sm ${missedPct === 0 ? 'rounded-t-sm' : ''} bg-emerald-500 transition-all duration-300`}
                      style={{ height: `${Math.min(100, Math.max(8, takenPct))}%` }}
                    />
                  )}
                  {d.total === 0 && (
                    <div className="w-full h-1 bg-slate-200 rounded-sm mt-auto" />
                  )}
                </div>

                {/* Day Label */}
                <span className={`text-[10px] truncate w-full text-center font-bold ${
                  isToday ? 'text-blue-700' : 'text-slate-500'
                }`}>
                  {d.label === 'Today' ? 'Today' : d.label.slice(0, 3)}
                </span>
                <span className="text-[10px] text-slate-400 font-semibold -mt-1">
                  {d.taken}
                </span>
              </div>
            );
          })}
        </div>
      </div>
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

          {/* Compliance Trend Chart with Horizontal Slider */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-3.5 shadow-xs overflow-hidden">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-blue-600" /> Compliance Trend
              </h2>
              <div className="flex items-center gap-3 text-xs text-slate-500 font-medium">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> Taken</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-rose-400 inline-block" /> Missed</span>
              </div>
            </div>
            <ComplianceTrendChart events={events} />
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

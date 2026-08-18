import React, { useState, useEffect } from 'react';
import {
  Pill,
  Clock,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Bell,
  User,
  Fingerprint,
  Wifi,
  WifiOff,
  Cpu,
  AlertTriangle,
  Plus,
  Save,
  X,
  Activity,
  Package,
} from 'lucide-react';
import { MedicineSlot, MedboxStatus, MedboxDeviceState } from '../types';

// ─── Props ────────────────────────────────────────────────────────────────────
interface MedicineBoxProps {
  slots: MedicineSlot[];
  lidOpen: boolean;
  medboxStatus: MedboxStatus;
  onMarkTaken: (id: string) => void;
  onMarkMissed: (id: string) => void;
  onResetSlot: (id: string) => void;
  onUpdateSlots: (slots: MedicineSlot[]) => void;
}

// ─── Countdown hook ───────────────────────────────────────────────────────────
function useCountdown(scheduledTime: string, taken: boolean, missed: boolean): string {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    if (taken)  { setCountdown('Taken ✓'); return; }
    if (missed) { setCountdown('Missed'); return; }

    const tick = () => {
      const now = new Date();
      const [h, m] = scheduledTime.split(':').map(Number);
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      const diff = target.getTime() - now.getTime();
      const hh = Math.floor(diff / 3_600_000);
      const mm = Math.floor((diff % 3_600_000) / 60_000);
      const ss = Math.floor((diff % 60_000) / 1000);
      setCountdown(`${hh}h ${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [scheduledTime, taken, missed]);

  return countdown;
}

function formatTime12(time24: string): string {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function formatUptime(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Device State Badge ───────────────────────────────────────────────────────
const STATE_CONFIG: Record<MedboxDeviceState, { label: string; color: string; pulse: boolean }> = {
  IDLE:       { label: 'IDLE',       color: 'bg-slate-700 text-slate-300 border-slate-600',            pulse: false },
  REMINDER:   { label: 'REMINDER',   color: 'bg-amber-500/20 text-amber-300 border-amber-500/40',      pulse: true  },
  DISPENSING: { label: 'DISPENSING', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40',         pulse: true  },
  CONFIRMED:  { label: 'CONFIRMED',  color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',pulse: false },
  MISSED:     { label: 'MISSED',     color: 'bg-red-500/20 text-red-300 border-red-500/40',            pulse: false },
  UNKNOWN:    { label: 'UNKNOWN',    color: 'bg-slate-800 text-slate-500 border-slate-700',             pulse: false },
};

function StateBadge({ state }: { state: MedboxDeviceState }) {
  const cfg = STATE_CONFIG[state] ?? STATE_CONFIG.UNKNOWN;
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${cfg.color} ${cfg.pulse ? 'animate-pulse' : ''}`}>
      {cfg.label}
    </span>
  );
}

// ─── Device Status Bar ────────────────────────────────────────────────────────
function DeviceStatusBar({ status }: { status: MedboxStatus }) {
  const lastSeen = status.lastSeen
    ? new Date(status.lastSeen).toLocaleTimeString('en-US', { hour12: false })
    : 'Never';

  return (
    <div className={`glass-card rounded-2xl p-5 transition-all ${
      status.online
        ? 'hover:border-emerald-500/20'
        : ''
    }`}>
      <div className="flex flex-wrap items-center gap-3">

        {/* Online / Offline */}
        <div className="flex items-center gap-2">
          {status.online
            ? <Wifi className="h-4 w-4 text-emerald-400" />
            : <WifiOff className="h-4 w-4 text-slate-500" />
          }
          <div>
            <span className={`text-[10px] font-mono block leading-none ${status.online ? 'text-slate-400' : 'text-slate-600'}`}>
              DEVICE
            </span>
            <span className={`text-xs font-bold font-mono ${status.online ? 'text-emerald-400' : 'text-slate-500'}`}>
              {status.online ? '🟢 ONLINE' : '🔴 OFFLINE'}
            </span>
          </div>
        </div>

        <div className="h-8 border-l border-slate-800" />

        {/* ESP32 State */}
        <div className="flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-slate-500" />
          <div>
            <span className="text-[10px] font-mono text-slate-500 block leading-none">STATE</span>
            <StateBadge state={status.state} />
          </div>
        </div>

        <div className="h-8 border-l border-slate-800" />

        {/* Patient Presence */}
        <div className="flex items-center gap-2">
          <User className="h-3.5 w-3.5 text-slate-500" />
          <div>
            <span className="text-[10px] font-mono text-slate-500 block leading-none">PRESENCE</span>
            <span className={`text-xs font-bold font-mono ${status.presenceDetected ? 'text-blue-400' : 'text-slate-500'}`}>
              {status.presenceDetected ? 'DETECTED' : 'NONE'}
            </span>
          </div>
        </div>

        <div className="h-8 border-l border-slate-800" />

        {/* Next Dose */}
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-slate-500" />
          <div>
            <span className="text-[10px] font-mono text-slate-500 block leading-none">NEXT DOSE</span>
            <span className="text-xs font-bold font-mono text-slate-200">
              {status.nextDoseTime ? formatTime12(status.nextDoseTime) : '—'}
            </span>
          </div>
        </div>

        <div className="h-8 border-l border-slate-800 hidden sm:block" />

        {/* Last Heartbeat + Uptime */}
        <div className="ml-auto text-right hidden sm:block">
          <span className="text-[10px] font-mono text-slate-600 block">
            Last seen: {lastSeen}
          </span>
          <span className="text-[10px] font-mono text-slate-600">
            Uptime: {formatUptime(status.uptime ?? 0)}
          </span>
        </div>

      </div>
    </div>
  );
}

// ─── Physical Box Card ────────────────────────────────────────────────────────
function BoxCard({
  slot,
  espState,
  onMarkTaken,
  onMarkMissed,
  onResetSlot,
}: {
  slot: MedicineSlot;
  espState: MedboxDeviceState;
  onMarkTaken: (id: string) => void;
  onMarkMissed: (id: string) => void;
  onResetSlot: (id: string) => void;
}) {
  const [confirmMiss, setConfirmMiss] = useState(false);
  const missed = (slot as any).missed === true;
  const countdown = useCountdown(slot.scheduledTime, slot.taken, missed);

  // Is this specific box currently being dispensed by ESP32?
  const isDispensing = espState === 'DISPENSING' && !slot.taken && !missed;

  const boxColors = [
    'from-emerald-500 to-teal-500',
    'from-blue-500 to-indigo-500',
    'from-violet-500 to-purple-500',
  ];
  const gradient = boxColors[(slot.slotNumber - 1) % boxColors.length];

  // Status badge config
  type SlotStatus = 'TAKEN' | 'MISSED' | 'DISPENSING' | 'PENDING';
  const status: SlotStatus = slot.taken
    ? 'TAKEN'
    : missed
    ? 'MISSED'
    : isDispensing
    ? 'DISPENSING'
    : 'PENDING';

  const statusStyles: Record<SlotStatus, string> = {
    TAKEN:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    MISSED:     'bg-red-500/15 text-red-300 border-red-500/30',
    DISPENSING: 'bg-blue-500/15 text-blue-300 border-blue-500/30 animate-pulse',
    PENDING:    'bg-slate-800 text-slate-400 border-slate-700',
  };

  return (
    <div className={`relative rounded-2xl border overflow-hidden transition-all duration-500 ${
      slot.taken
        ? 'bg-emerald-950/20 border-emerald-500/20'
        : missed
        ? 'bg-red-950/20 border-red-500/20'
        : isDispensing
        ? 'bg-blue-950/20 border-blue-500/30 shadow-lg shadow-blue-500/10'
        : 'bg-slate-900/50 border-slate-800'
    }`}>

      {/* Dispensing glow ring */}
      {isDispensing && (
        <div className="absolute inset-0 rounded-2xl border-2 border-blue-400/30 animate-ping pointer-events-none" />
      )}

      {/* Top accent bar */}
      <div className={`h-1 w-full bg-gradient-to-r ${gradient} ${slot.taken ? 'opacity-40' : 'opacity-100'}`} />

      <div className="p-5 space-y-4">

        {/* Header: box number + medicine name + status badge */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center h-10 w-10 rounded-xl bg-gradient-to-br ${gradient} text-white font-black text-lg shrink-0 ${slot.taken || missed ? 'opacity-40' : ''}`}>
              {slot.slotNumber}
            </div>
            <div>
              <h3 className={`text-sm font-bold font-headline ${slot.taken ? 'line-through text-slate-500' : missed ? 'text-red-300' : 'text-white'}`}>
                {slot.medicineName}
              </h3>
              <span className="text-[11px] text-slate-400 font-mono">{slot.dosage}</span>
            </div>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-[10px] font-label font-bold border shrink-0 ${statusStyles[status]}`}>
            {status}
          </span>
        </div>

        {/* Time + countdown */}
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-slate-300 font-mono font-bold">
            <Clock className="h-3.5 w-3.5 text-slate-500" />
            {formatTime12(slot.scheduledTime)}
          </div>
          <span className={`font-mono text-[10px] ${
            slot.taken ? 'text-emerald-400' : missed ? 'text-red-400' : 'text-slate-500'
          }`}>
            {slot.taken && slot.takenAt ? `at ${slot.takenAt}` : countdown}
          </span>
        </div>

        {/* Sensor indicators */}
        <div className="flex gap-2">
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono border ${
            slot.presenceConfirmed
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-slate-800/60 text-slate-600 border-slate-700'
          }`}>
            <User className="h-3 w-3" />
            Presence
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono border ${
            slot.touchVerified
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-slate-800/60 text-slate-600 border-slate-700'
          }`}>
            <Fingerprint className="h-3 w-3" />
            Touch
          </div>
          {isDispensing && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono border bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse">
              <Package className="h-3 w-3" />
              Servo Open
            </div>
          )}
        </div>

        {/* Notes */}
        {(slot as any).notes && (
          <p className="text-[10px] text-slate-500 font-mono leading-relaxed border-l-2 border-slate-700 pl-2">
            {(slot as any).notes}
          </p>
        )}

        {/* Caregiver override buttons */}
        <div className="flex gap-2 pt-1">
          {slot.taken ? (
            <button
              onClick={() => onResetSlot(slot.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-mono text-slate-400 hover:text-slate-200 transition"
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </button>
          ) : missed ? (
            <button
              onClick={() => onResetSlot(slot.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-mono text-slate-400 hover:text-slate-200 transition"
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </button>
          ) : (
            <>
              {/* Mark Taken */}
              <button
                onClick={() => onMarkTaken(slot.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-xs font-bold font-mono text-emerald-400 transition"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark Taken
              </button>

              {/* Mark Missed (with confirm) */}
              {confirmMiss ? (
                <div className="flex gap-1.5 items-center">
                  <span className="text-[10px] text-red-400 font-mono">Sure?</span>
                  <button
                    onClick={() => { onMarkMissed(slot.id); setConfirmMiss(false); }}
                    className="px-2 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-xs font-mono text-red-400 transition"
                  >Yes</button>
                  <button
                    onClick={() => setConfirmMiss(false)}
                    className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-slate-400 transition"
                  >No</button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmMiss(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/5 hover:bg-red-500/10 border border-red-500/20 text-xs font-mono text-red-400/70 hover:text-red-400 transition"
                >
                  <XCircle className="h-3.5 w-3.5" /> Mark Missed
                </button>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}

// ─── Add Schedule Form ────────────────────────────────────────────────────────
function AddSlotForm({ onAdd, onClose }: {
  onAdd: (slot: Omit<MedicineSlot, 'id' | 'taken' | 'presenceConfirmed' | 'touchVerified'>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [time, setTime] = useState('08:00');
  const [box, setBox] = useState<1 | 2>(1);
  const [notes, setNotes] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ slotNumber: box, medicineName: name.trim(), dosage: dosage.trim() || '—', scheduledTime: time, notes });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Plus className="h-4 w-4 text-emerald-400" /> Add Medicine Slot
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Box Number */}
          <div>
            <label className="block text-[10px] font-mono text-slate-400 mb-1">PHYSICAL BOX (1–2)</label>
            <div className="flex gap-2">
              {([1, 2] as const).map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setBox(n)}
                  className={`flex-1 py-2 rounded-xl font-bold text-sm border transition ${
                    box === n
                      ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >Box {n}</button>
              ))}
            </div>
          </div>

          {[
            { label: 'MEDICINE NAME', value: name, setter: setName, type: 'text', placeholder: 'e.g. Lisinopril' },
            { label: 'DOSAGE',        value: dosage, setter: setDosage, type: 'text', placeholder: 'e.g. 10mg' },
          ].map(({ label, value, setter, type, placeholder }) => (
            <div key={label}>
              <label className="block text-[10px] font-mono text-slate-400 mb-1">{label}</label>
              <input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={e => setter(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-emerald-500/50 placeholder-slate-600"
              />
            </div>
          ))}

          <div>
            <label className="block text-[10px] font-mono text-slate-400 mb-1">SCHEDULED TIME</label>
            <input
              type="time"
              value={time}
              onChange={e => setTime(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          <div>
            <label className="block text-[10px] font-mono text-slate-400 mb-1">NOTES (OPTIONAL)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Take with water"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-300 font-mono focus:outline-none focus:border-emerald-500/50 resize-none placeholder-slate-600"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-xl border border-slate-700 text-xs text-slate-400 hover:bg-slate-800 transition">
              Cancel
            </button>
            <button type="submit" className="flex-1 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs transition flex items-center justify-center gap-1.5">
              <Save className="h-3.5 w-3.5" /> Save Slot
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function MedicineBox({
  slots,
  lidOpen,
  medboxStatus,
  onMarkTaken,
  onMarkMissed,
  onResetSlot,
  onUpdateSlots,
}: MedicineBoxProps) {
  const [showAddForm, setShowAddForm] = useState(false);

  const takenCount  = slots.filter(s => s.taken).length;
  const missedCount = slots.filter(s => (s as any).missed).length;
  const adherencePct = slots.length > 0
    ? Math.round((takenCount / slots.length) * 100)
    : 0;

  const handleAddSlot = (partial: Omit<MedicineSlot, 'id' | 'taken' | 'presenceConfirmed' | 'touchVerified'>) => {
    const newSlot: MedicineSlot = {
      id: `slot-${Date.now()}`,
      taken: false,
      presenceConfirmed: false,
      touchVerified: false,
      ...partial,
    };
    onUpdateSlots([...slots, newSlot]);
  };

  return (
    <div className="flex flex-col gap-6 relative">
      {showAddForm && (
        <AddSlotForm onAdd={handleAddSlot} onClose={() => setShowAddForm(false)} />
      )}

      {/* Decorative orb */}
      <div className="orb-emerald -top-40 -left-40" />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-100 tracking-tight flex items-center gap-3">
            <Pill className="h-6 w-6 text-amber-400" />
            Smart Medicine Box
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            ESP32 IoT box — ultrasonic presence + touch-sensor verification + servo dispensing.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-label font-bold ${
            lidOpen
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : 'glass-card text-slate-400'
          }`}>
            <Package className="h-3.5 w-3.5" />
            {lidOpen ? 'LID OPEN' : 'LID CLOSED'}
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl glass-card hover:border-emerald-500/30 text-xs font-label text-slate-300 hover:text-emerald-400 transition-all"
          >
            <Plus className="h-3.5 w-3.5" /> Add Slot
          </button>
        </div>
      </header>

      {/* ── Device Status Bar ───────────────────────────────────────────────── */}
      <DeviceStatusBar status={medboxStatus} />

      {/* ── Adherence bar ──────────────────────────────────────────────────── */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-5 space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Bell className="h-4 w-4 text-amber-400" />
            Today's Adherence
          </h3>
          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="text-emerald-400">✓ {takenCount} taken</span>
            {missedCount > 0 && <span className="text-red-400">✗ {missedCount} missed</span>}
            <span className="text-slate-400">◯ {slots.length - takenCount - missedCount} pending</span>
            <span className="text-white font-black">{adherencePct}%</span>
          </div>
        </div>
        <div className="h-3 bg-slate-800 rounded-full overflow-hidden flex">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-700"
            style={{ width: `${adherencePct}%` }}
          />
          {missedCount > 0 && (
            <div
              className="h-full bg-gradient-to-r from-red-600 to-red-500 transition-all duration-700"
              style={{ width: `${slots.length > 0 ? (missedCount / slots.length) * 100 : 0}%` }}
            />
          )}
        </div>
        {takenCount === slots.length && slots.length > 0 && (
          <p className="text-emerald-400 font-bold text-xs font-mono animate-pulse">
            🎉 All doses complete for today!
          </p>
        )}
        {missedCount > 0 && (
          <div className="flex items-center gap-2 text-xs text-red-400 font-mono">
            <AlertTriangle className="h-3.5 w-3.5" />
            {missedCount} missed dose{missedCount > 1 ? 's' : ''} — caregiver alert sent via email.
          </div>
        )}
      </div>

      {/* ── Physical 3-box grid ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono flex items-center gap-2">
            <Activity className="h-3.5 w-3.5" />
            Physical Medicine Compartments ({slots.length})
          </h3>
        </div>

        {slots.length === 0 ? (
          <div className="text-center py-12 text-slate-600 border border-dashed border-slate-800 rounded-2xl">
            <Pill className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-mono">No slots configured. Add a slot to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {slots.map(slot => (
              <BoxCard
                key={slot.id}
                slot={slot}
                espState={medboxStatus.state}
                onMarkTaken={onMarkTaken}
                onMarkMissed={onMarkMissed}
                onResetSlot={onResetSlot}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Hardware info footer ────────────────────────────────────────────── */}
      <div className="bg-slate-900/30 border border-slate-800/50 rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
        {[
          { icon: User,        color: 'text-blue-400',   bg: 'bg-blue-500/10',   label: 'HC-SR04 Ultrasonic',  desc: 'Detects patient presence < 40 cm before dispensing.' },
          { icon: Fingerprint, color: 'text-amber-400',  bg: 'bg-amber-500/10',  label: 'TTP223 Touch Sensor', desc: 'Physically verifies pill removal from the compartment.' },
          { icon: Activity,    color: 'text-violet-400', bg: 'bg-violet-500/10', label: '3× SG90 Servos',       desc: 'Open/close compartments on schedule (0° closed, 90° open).' },
        ].map(({ icon: Icon, color, bg, label, desc }) => (
          <div key={label} className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${bg} shrink-0`}><Icon className={`h-4 w-4 ${color}`} /></div>
            <div>
              <span className="font-bold text-slate-200 block">{label}</span>
              <span className="text-slate-500 text-[10px] leading-relaxed">{desc}</span>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

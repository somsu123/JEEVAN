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
  IDLE:       { label: 'Idle / Ready',       color: 'bg-slate-100 text-slate-700 border-slate-200',         pulse: false },
  REMINDER:   { label: 'Dose Reminder',      color: 'bg-amber-50 text-amber-800 border-amber-300 font-bold', pulse: true  },
  DISPENSING: { label: 'Dispensing Now',     color: 'bg-blue-50 text-blue-700 border-blue-300 font-bold',   pulse: true  },
  CONFIRMED:  { label: 'Dose Taken',         color: 'bg-emerald-50 text-emerald-700 border-emerald-300',   pulse: false },
  MISSED:     { label: 'Dose Missed',        color: 'bg-rose-50 text-rose-700 border-rose-300',             pulse: false },
  UNKNOWN:    { label: 'Standby',            color: 'bg-slate-100 text-slate-500 border-slate-200',         pulse: false },
};

function StateBadge({ state }: { state: MedboxDeviceState }) {
  const cfg = STATE_CONFIG[state] ?? STATE_CONFIG.UNKNOWN;
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${cfg.color} ${cfg.pulse ? 'animate-pulse ring-2 ring-blue-400/20' : ''}`}>
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
    <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs transition-all hover:border-slate-300">
      <div className="flex flex-wrap items-center gap-4 sm:gap-6">

        {/* Online / Offline */}
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-2xl ${status.online ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
            {status.online ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-400 block leading-none uppercase tracking-wider">
              Smart Box
            </span>
            <span className={`text-sm font-bold mt-1 inline-block ${status.online ? 'text-emerald-700' : 'text-slate-500'}`}>
              {status.online ? '● Connected' : '○ Offline'}
            </span>
          </div>
        </div>

        <div className="h-8 border-l border-slate-200 hidden sm:block" />

        {/* ESP32 State */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-2xl bg-slate-50 text-slate-600 border border-slate-200">
            <Cpu className="h-5 w-5" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-400 block leading-none uppercase tracking-wider mb-1">State</span>
            <StateBadge state={status.state} />
          </div>
        </div>

        <div className="h-8 border-l border-slate-200 hidden sm:block" />

        {/* Patient Presence */}
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-2xl border ${status.presenceDetected ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-slate-50 text-slate-400 border-slate-200'}`}>
            <User className="h-5 w-5" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-400 block leading-none uppercase tracking-wider">Presence</span>
            <span className={`text-sm font-bold mt-0.5 inline-block ${status.presenceDetected ? 'text-blue-700' : 'text-slate-500'}`}>
              {status.presenceDetected ? 'Detected' : 'None'}
            </span>
          </div>
        </div>

        <div className="h-8 border-l border-slate-200 hidden sm:block" />

        {/* Next Dose */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-2xl bg-amber-50 text-amber-600 border border-amber-200">
            <Clock className="h-5 w-5" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-400 block leading-none uppercase tracking-wider">Next Dose</span>
            <span className="text-sm font-bold text-slate-800 mt-0.5 inline-block">
              {status.nextDoseTime ? formatTime12(status.nextDoseTime) : '—'}
            </span>
          </div>
        </div>

        <div className="h-8 border-l border-slate-200 hidden md:block" />

        {/* Last Heartbeat + Uptime */}
        <div className="ml-auto text-right hidden md:block">
          <span className="text-xs text-slate-500 font-medium block">
            Last seen: <span className="font-semibold text-slate-700">{lastSeen}</span>
          </span>
          <span className="text-xs text-slate-500 font-medium">
            Uptime: <span className="font-semibold text-slate-700">{formatUptime(status.uptime ?? 0)}</span>
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
    'from-emerald-600 to-teal-600',
    'from-blue-600 to-indigo-600',
    'from-violet-600 to-purple-600',
    'from-amber-600 to-orange-600',
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

  const statusLabels: Record<SlotStatus, string> = {
    TAKEN: 'Taken ✓',
    MISSED: 'Missed ✗',
    DISPENSING: 'Open Now',
    PENDING: 'Scheduled',
  };

  const statusStyles: Record<SlotStatus, string> = {
    TAKEN:      'bg-emerald-50 text-emerald-700 border-emerald-200',
    MISSED:     'bg-rose-50 text-rose-700 border-rose-200',
    DISPENSING: 'bg-blue-50 text-blue-700 border-blue-300 ring-2 ring-blue-500/20 animate-pulse',
    PENDING:    'bg-slate-100 text-slate-600 border-slate-200',
  };

  return (
    <div className={`relative rounded-3xl border overflow-hidden transition-all duration-200 shadow-xs hover:shadow-sm ${
      slot.taken
        ? 'bg-emerald-50/20 border-emerald-200'
        : missed
        ? 'bg-rose-50/20 border-rose-200'
        : isDispensing
        ? 'bg-blue-50/30 border-blue-300 ring-2 ring-blue-500/20'
        : 'bg-white border-slate-200 hover:border-slate-300'
    }`}>

      {/* Top accent bar */}
      <div className={`h-1.5 w-full bg-gradient-to-r ${gradient} ${slot.taken ? 'opacity-40' : 'opacity-100'}`} />

      <div className="p-5 space-y-4">

        {/* Header: box number + medicine name + status badge */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`flex items-center justify-center h-12 w-12 rounded-2xl bg-gradient-to-br ${gradient} text-white font-bold text-lg shrink-0 shadow-xs ${slot.taken || missed ? 'opacity-50' : ''}`}>
              {slot.slotNumber}
            </div>
            <div>
              <h3 className={`text-base font-bold font-headline leading-tight ${slot.taken ? 'line-through text-slate-400' : missed ? 'text-rose-700' : 'text-slate-800'}`}>
                {slot.medicineName}
              </h3>
              <span className="text-xs text-slate-500 font-medium">{slot.dosage}</span>
            </div>
          </div>
          <span className={`px-3 py-1 rounded-full text-xs font-semibold border shrink-0 ${statusStyles[status]}`}>
            {statusLabels[status]}
          </span>
        </div>

        {/* Time + countdown */}
        <div className="flex items-center justify-between text-xs py-2 px-3.5 rounded-2xl bg-slate-50 border border-slate-100">
          <div className="flex items-center gap-2 text-slate-800 font-semibold">
            <Clock className="h-4 w-4 text-slate-500" />
            <span>{formatTime12(slot.scheduledTime)}</span>
          </div>
          <span className={`font-semibold text-xs ${
            slot.taken ? 'text-emerald-700' : missed ? 'text-rose-600' : 'text-blue-700'
          }`}>
            {slot.taken && slot.takenAt ? `at ${slot.takenAt}` : countdown}
          </span>
        </div>

        {/* Sensor indicators */}
        <div className="flex gap-2">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border ${
            slot.presenceConfirmed
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-slate-50 text-slate-400 border-slate-200'
          }`}>
            <User className="h-3.5 w-3.5" />
            Presence
          </div>
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border ${
            slot.touchVerified
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-slate-50 text-slate-400 border-slate-200'
          }`}>
            <Fingerprint className="h-3.5 w-3.5" />
            Touch
          </div>
          {isDispensing && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border bg-blue-50 text-blue-700 border-blue-300 animate-pulse">
              <Package className="h-3.5 w-3.5" />
              Lid Open
            </div>
          )}
        </div>

        {/* Notes */}
        {(slot as any).notes && (
          <p className="text-xs text-slate-600 leading-relaxed border-l-2 border-blue-400 pl-3 bg-blue-50/40 py-1.5 rounded-r-xl">
            {(slot as any).notes}
          </p>
        )}

        {/* Caregiver override buttons */}
        <div className="flex gap-2 pt-1">
          {slot.taken ? (
            <button
              onClick={() => onResetSlot(slot.id)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-slate-100 hover:bg-slate-200 border border-slate-200 text-xs font-semibold text-slate-700 transition cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset Slot
            </button>
          ) : missed ? (
            <button
              onClick={() => onResetSlot(slot.id)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-slate-100 hover:bg-slate-200 border border-slate-200 text-xs font-semibold text-slate-700 transition cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset Slot
            </button>
          ) : (
            <>
              {/* Mark Taken */}
              <button
                onClick={() => onMarkTaken(slot.id)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs text-xs font-bold transition active:scale-95 cursor-pointer"
              >
                <CheckCircle2 className="h-4 w-4" /> Mark Taken
              </button>

              {/* Mark Missed (with confirm) */}
              {confirmMiss ? (
                <div className="flex gap-1.5 items-center">
                  <span className="text-xs text-rose-600 font-bold">Sure?</span>
                  <button
                    onClick={() => { onMarkMissed(slot.id); setConfirmMiss(false); }}
                    className="px-3 py-2 rounded-xl bg-rose-600 text-white text-xs font-bold transition shadow-xs cursor-pointer"
                  >Yes</button>
                  <button
                    onClick={() => setConfirmMiss(false)}
                    className="px-3 py-2 rounded-xl bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-700 transition cursor-pointer"
                  >No</button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmMiss(true)}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-2xl bg-rose-50 hover:bg-rose-100 border border-rose-200 text-xs font-semibold text-rose-700 transition cursor-pointer"
                >
                  <XCircle className="h-4 w-4" /> Missed
                </button>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}

// ─── Add Schedule Form Modal ───────────────────────────────────────────────────
function AddSlotForm({ onAdd, onClose }: {
  onAdd: (slot: Omit<MedicineSlot, 'id' | 'taken' | 'presenceConfirmed' | 'touchVerified'>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [time, setTime] = useState('08:00');
  const [box, setBox] = useState<1 | 2 | 3 | 4>(1);
  const [notes, setNotes] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ slotNumber: box, medicineName: name.trim(), dosage: dosage.trim() || '—', scheduledTime: time, notes });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-7 w-full max-w-md shadow-2xl space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
              <Plus className="h-5 w-5" />
            </div>
            Add Medication Slot
          </h3>
          <button onClick={onClose} className="p-2 rounded-2xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition cursor-pointer">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Box Number */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
              Physical Compartment (1–4)
            </label>
            <div className="grid grid-cols-4 gap-2.5">
              {([1, 2, 3, 4] as const).map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setBox(n)}
                  className={`py-2.5 rounded-2xl font-bold text-sm border transition-all cursor-pointer ${
                    box === n
                      ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >Slot {n}</button>
              ))}
            </div>
          </div>

          {[
            { label: 'Medicine Name', value: name, setter: setName, type: 'text', placeholder: 'e.g. Lisinopril, Metformin' },
            { label: 'Dosage',        value: dosage, setter: setDosage, type: 'text', placeholder: 'e.g. 10mg, 1 tablet' },
          ].map(({ label, value, setter, type, placeholder }) => (
            <div key={label}>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5">{label}</label>
              <input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={e => setter(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 placeholder-slate-400 transition"
              />
            </div>
          ))}

          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5">Scheduled Time</label>
            <input
              type="time"
              value={time}
              onChange={e => setTime(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800 font-mono focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5">Special Instructions (Optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Take after breakfast with water"
              className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 resize-none placeholder-slate-400 transition"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-3 rounded-2xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-100 transition cursor-pointer">
              Cancel
            </button>
            <button type="submit" className="flex-1 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm transition flex items-center justify-center gap-2 shadow-xs active:scale-95 cursor-pointer">
              <Save className="h-4 w-4" /> Save Slot
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

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-800 tracking-tight flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
              <Pill className="h-6 w-6" />
            </div>
            Smart Medication Box
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            Ultrasonic presence detection, physical push-button verification, and automated servo lid.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl border text-xs font-semibold ${
            lidOpen
              ? 'bg-amber-50 border-amber-300 text-amber-800 animate-pulse ring-2 ring-amber-400/20'
              : 'bg-white text-slate-600 border-slate-200'
          }`}>
            <Package className="h-4 w-4" />
            {lidOpen ? 'Lid Open' : 'Lid Closed'}
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold shadow-xs transition-all active:scale-95 cursor-pointer"
          >
            <Plus className="h-4 w-4" /> Add Slot
          </button>
        </div>
      </header>

      {/* ── Device Status Bar ───────────────────────────────────────────────── */}
      <DeviceStatusBar status={medboxStatus} />

      {/* ── Adherence bar ──────────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-4 shadow-xs">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <h3 className="text-base font-bold text-slate-800 flex items-center gap-2 font-headline">
            <Bell className="h-5 w-5 text-amber-500" />
            Today's Dose Compliance
          </h3>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-emerald-700 font-semibold">✓ {takenCount} taken</span>
            {missedCount > 0 && <span className="text-rose-600 font-semibold">✗ {missedCount} missed</span>}
            <span className="text-slate-500 font-medium">◯ {slots.length - takenCount - missedCount} pending</span>
            <span className="text-slate-800 font-bold text-sm bg-slate-100 px-3 py-1 rounded-xl">{adherencePct}%</span>
          </div>
        </div>
        <div className="h-3 bg-slate-100 rounded-full overflow-hidden flex border border-slate-200/60">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all duration-700"
            style={{ width: `${adherencePct}%` }}
          />
          {missedCount > 0 && (
            <div
              className="h-full bg-gradient-to-r from-rose-500 to-rose-600 transition-all duration-700"
              style={{ width: `${slots.length > 0 ? (missedCount / slots.length) * 100 : 0}%` }}
            />
          )}
        </div>
        {takenCount === slots.length && slots.length > 0 && (
          <p className="text-emerald-700 font-semibold text-xs flex items-center gap-1.5">
            🎉 All scheduled doses complete for today!
          </p>
        )}
        {missedCount > 0 && (
          <div className="flex items-center gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 p-3 rounded-2xl">
            <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
            {missedCount} missed dose{missedCount > 1 ? 's' : ''} — automatic caregiver reminder triggered.
          </div>
        )}
      </div>

      {/* ── Physical 4-box grid ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-600" />
            Physical Compartments ({slots.length})
          </h3>
        </div>

        {slots.length === 0 ? (
          <div className="text-center py-14 text-slate-400 bg-white border border-dashed border-slate-200 rounded-3xl shadow-xs">
            <Pill className="h-10 w-10 mx-auto mb-3 text-slate-300" />
            <p className="text-base font-semibold text-slate-700">No slots configured yet.</p>
            <p className="text-xs text-slate-500 mt-1">Click "Add Slot" or configure via the Prescriptions tab.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
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
      <div className="bg-white border border-slate-200 rounded-3xl p-6 grid grid-cols-1 sm:grid-cols-3 gap-5 text-xs shadow-xs">
        {[
          { icon: User,        color: 'text-blue-600',   bg: 'bg-blue-50 border-blue-100',   label: 'HC-SR04 Ultrasonic (D5)', desc: 'Detects patient presence (15–20 cm) before triggering servo lid opening.' },
          { icon: Fingerprint, color: 'text-emerald-600',bg: 'bg-emerald-50 border-emerald-100',label: 'Push Button Confirm (D4)', desc: 'Physically confirms medicine dose intake and resets active reminder.' },
          { icon: Activity,    color: 'text-purple-600', bg: 'bg-purple-50 border-purple-100', label: '1× SG90 Servo Lid (D13)',   desc: 'Opens lid upon proximity detection at dose time (0° closed, 90° open).' },
        ].map(({ icon: Icon, color, bg, label, desc }) => (
          <div key={label} className="flex items-start gap-3.5">
            <div className={`p-3 rounded-2xl ${bg} border shrink-0`}><Icon className={`h-5 w-5 ${color}`} /></div>
            <div>
              <span className="font-bold text-slate-800 text-sm block font-sans">{label}</span>
              <span className="text-slate-500 text-xs leading-relaxed block mt-1">{desc}</span>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

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
  Trash2,
  Timer,
  RefreshCw,
  Heart,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import { MedicineSlot, MedboxStatus, MedboxDeviceState, VitalState, CardiacSosState } from '../types';

// ─── Props ────────────────────────────────────────────────────────────────────
interface MedicineBoxProps {
  slots: MedicineSlot[];
  lidOpen: boolean;
  medboxStatus: MedboxStatus;
  onMarkTaken: (id: string) => void;
  onMarkMissed: (id: string) => void;
  onResetSlot: (id: string) => void;
  onDeleteSlot?: (id: string) => void;
  onUpdateSlots: (slots: MedicineSlot[]) => void;
  vitals?: VitalState;
  cardiacSos?: CardiacSosState | null;
  onTriggerRemoteOpen?: () => Promise<void> | void;
  onDismissCardiacSos?: () => void;
  onSimulateCardiacSos?: (bpm: number) => void;
}

// ─── Countdown hook ───────────────────────────────────────────────────────────
function useCountdown(scheduledTime?: string, taken?: boolean, missed?: boolean): string {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    if (taken)  { setCountdown('Taken ✓'); return; }
    if (missed) { setCountdown('Missed'); return; }
    if (!scheduledTime || typeof scheduledTime !== 'string' || !scheduledTime.includes(':')) {
      setCountdown('--:--');
      return;
    }

    const tick = () => {
      const now = new Date();
      const parts = scheduledTime.split(':');
      const h = Number(parts[0]) || 0;
      const m = Number(parts[1]) || 0;
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

function formatTime12(time24?: string | null): string {
  if (!time24 || typeof time24 !== 'string' || !time24.includes(':')) {
    return time24 || '--:--';
  }
  const parts = time24.split(':');
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
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
  IDLE:       { label: 'Idle / Ready',          color: 'bg-slate-100 text-slate-700 border-slate-200',         pulse: false },
  REMINDER:   { label: 'Dose Reminder',         color: 'bg-amber-50 text-amber-800 border-amber-300 font-bold', pulse: true  },
  DISPENSING: { label: 'Dispensing Now',        color: 'bg-blue-50 text-blue-700 border-blue-300 font-bold',   pulse: true  },
  CONFIRMED:  { label: 'Dose Taken',            color: 'bg-emerald-50 text-emerald-700 border-emerald-300',   pulse: false },
  MISSED:     { label: 'Dose Missed',           color: 'bg-rose-50 text-rose-700 border-rose-300',             pulse: false },
  SNOOZE:     { label: 'Auto-Reminder Snooze',  color: 'bg-purple-50 text-purple-700 border-purple-300 font-bold', pulse: true },
  UNKNOWN:    { label: 'Standby',               color: 'bg-slate-100 text-slate-500 border-slate-200',         pulse: false },
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
  onDeleteSlot,
}: {
  slot: MedicineSlot;
  espState: MedboxDeviceState;
  onMarkTaken: (id: string) => void;
  onMarkMissed: (id: string) => void;
  onResetSlot: (id: string) => void;
  onDeleteSlot?: (id: string) => void;
}) {
  const [confirmMiss, setConfirmMiss] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const gradient = boxColors[Math.max(0, (slot?.slotNumber || 1) - 1) % boxColors.length];

  // Status badge config
  type SlotStatus = 'TAKEN' | 'MISSED' | 'SNOOZED' | 'DISPENSING' | 'PENDING';
  const status: SlotStatus = slot.taken
    ? 'TAKEN'
    : (slot as any).inSnooze
    ? 'SNOOZED'
    : missed
    ? 'MISSED'
    : isDispensing
    ? 'DISPENSING'
    : 'PENDING';

  const statusLabels: Record<SlotStatus, string> = {
    TAKEN: 'Taken ✓',
    MISSED: (slot as any).completelyMissed ? 'Completely Missed ✗' : 'Missed ✗',
    SNOOZED: `Auto-Reminder ${(slot as any).currentRetry || 1}/${(slot as any).maxRetries || 3}`,
    DISPENSING: 'Open Now',
    PENDING: 'Scheduled',
  };

  const statusStyles: Record<SlotStatus, string> = {
    TAKEN:      'bg-emerald-50 text-emerald-700 border-emerald-200',
    MISSED:     'bg-rose-50 text-rose-700 border-rose-200',
    SNOOZED:    'bg-purple-50 text-purple-700 border-purple-300 ring-2 ring-purple-500/20',
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

        {/* Header: box number + medicine name + status badge + delete toggle button */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`flex items-center justify-center h-12 w-12 rounded-2xl bg-gradient-to-br ${gradient} text-white font-bold text-lg shrink-0 shadow-xs ${slot.taken || missed ? 'opacity-50' : ''}`}>
              {slot.slotNumber}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className={`text-base font-bold font-headline leading-tight truncate ${slot.taken ? 'line-through text-slate-400' : missed ? 'text-rose-700' : 'text-slate-800'}`}>
                {slot.medicineName}
              </h3>
              <span className="text-xs text-slate-500 font-medium block truncate">{slot.dosage}</span>
              {slot.slotNumber === 1 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md mt-1">
                  ⚡ Overlaps Emergency SOS Slot
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border shrink-0 ${statusStyles[status]}`}>
              {statusLabels[status]}
            </span>

            {/* Delete option symbol on top of medicine card with toggle */}
            {confirmDelete ? (
              <div className="flex items-center gap-1 bg-rose-50 border border-rose-200 p-1 rounded-xl shadow-2xs animate-in fade-in zoom-in-95 duration-150">
                <button
                  type="button"
                  onClick={() => {
                    onDeleteSlot?.(slot.id);
                    setConfirmDelete(false);
                  }}
                  title="Confirm delete medicine"
                  className="px-2 py-0.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition shadow-2xs cursor-pointer"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  title="Cancel"
                  className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 text-xs transition cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                title="Delete medicine from this compartment"
                className="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition cursor-pointer shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Time + countdown + timeout + retry badge */}
        <div className="space-y-2 py-2.5 px-3.5 rounded-2xl bg-slate-50 border border-slate-100 text-xs">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 text-slate-800 font-semibold">
              <Clock className="h-4 w-4 text-slate-500" />
              <span>{formatTime12(slot.scheduledTime)}</span>
            </div>
            <span className={`font-semibold text-xs ${
              slot.taken ? 'text-emerald-700' : (slot as any).inSnooze ? 'text-purple-700 font-bold' : missed ? 'text-rose-600' : 'text-blue-700'
            }`}>
              {slot.taken && slot.takenAt
                ? `at ${slot.takenAt}`
                : (slot as any).inSnooze && (slot as any).nextRetryTime
                ? `Retry at ${formatTime12((slot as any).nextRetryTime)}`
                : countdown}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-slate-200/60 text-[10px]">
            <span className="text-blue-700 font-bold bg-blue-50 px-2 py-0.5 rounded-md border border-blue-100 flex items-center gap-1">
              <Timer className="h-3 w-3 text-blue-600" /> {slot.timeoutMinutes || 5}m intake
            </span>
            <span className="text-purple-700 font-bold bg-purple-50 px-2 py-0.5 rounded-md border border-purple-100 flex items-center gap-1">
              <RefreshCw className="h-3 w-3 text-purple-600" /> {slot.retryIntervalMinutes || 5}m retry ({(slot as any).maxRetries || 3}x max)
            </span>
          </div>
        </div>

        {/* Sensor indicators */}
        <div className="flex gap-2 flex-wrap">
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
  const [timeoutMinutes, setTimeoutMinutes] = useState<number>(5);
  const [retryIntervalMinutes, setRetryIntervalMinutes] = useState<number>(5);
  const [maxRetries, setMaxRetries] = useState<number>(3);
  const [box, setBox] = useState<1 | 2 | 3 | 4>(1);
  const [notes, setNotes] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({
      slotNumber: box,
      medicineName: name.trim(),
      dosage: dosage.trim() || '—',
      scheduledTime: time,
      timeoutMinutes,
      retryIntervalMinutes,
      maxRetries,
      notes
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-7 w-full max-w-md shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto custom-scrollbar">
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

          {/* Timeout Window & Auto-Reminder Engine */}
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <label className="font-semibold text-slate-700 flex items-center gap-1.5">
                <Timer className="h-3.5 w-3.5 text-blue-600" /> Intake Timeout Window:
              </label>
              <span className="font-bold text-blue-800 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200">
                {timeoutMinutes} min
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] font-bold text-slate-400">1m</span>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={timeoutMinutes}
                onChange={e => setTimeoutMinutes(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
              <span className="text-[11px] font-bold text-slate-400">10m</span>
            </div>

            {/* Auto-Reminder Retry Interval */}
            <div className="pt-2 border-t border-slate-200/70 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="font-semibold text-slate-700 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-purple-600" /> Auto-Reminder Interval:
                </label>
                <span className="font-bold text-purple-800 bg-purple-50 px-2 py-0.5 rounded-md border border-purple-200">
                  {retryIntervalMinutes} min
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="text-[11px] font-bold text-slate-400">2m</span>
                <input
                  type="range"
                  min="2"
                  max="15"
                  step="1"
                  value={retryIntervalMinutes}
                  onChange={e => setRetryIntervalMinutes(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-purple-600"
                />
                <span className="text-[11px] font-bold text-slate-400">15m</span>
              </div>
            </div>

            {/* Max Retries */}
            <div className="pt-2 border-t border-slate-200/70 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label className="font-semibold text-slate-700 flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5 text-emerald-600" /> Max Reminders:
                </label>
                <span className="font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                  {maxRetries} times
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {[1, 2, 3, 4].map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setMaxRetries(r)}
                    className={`py-1 text-xs font-bold rounded-lg border transition ${
                      maxRetries === r ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-emerald-50'
                    }`}
                  >{r}x</button>
                ))}
              </div>
            </div>

            <p className="text-[10px] text-slate-500 leading-relaxed">
              If not taken within {timeoutMinutes}m, alarm stops &amp; lid stays closed. Re-alarms every {retryIntervalMinutes}m (up to {maxRetries}x) before being completely missed.
            </p>
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

// ─── Designated Emergency Medicine Box Slot Section ──────────────────────────
interface EmergencyMedicineSectionProps {
  lidOpen: boolean;
  medboxStatus: MedboxStatus;
  vitals?: VitalState;
  cardiacSos?: CardiacSosState | null;
  overlappingSlot?: MedicineSlot;
  onTriggerRemoteOpen?: () => Promise<void> | void;
  onDismissCardiacSos?: () => void;
  onSimulateCardiacSos?: (bpm: number) => void;
}

function EmergencyMedicineSection({
  lidOpen,
  medboxStatus,
  vitals,
  cardiacSos,
  overlappingSlot,
  onTriggerRemoteOpen,
  onDismissCardiacSos,
  onSimulateCardiacSos,
}: EmergencyMedicineSectionProps) {
  const currentBpm = vitals?.heartRate !== undefined && vitals.heartRate !== '--'
    ? Number(vitals.heartRate)
    : null;

  const isBpmCritical = currentBpm !== null && Number.isFinite(currentBpm) && (currentBpm <= 45 || currentBpm > 120);
  const isSosActive = Boolean((cardiacSos?.active && !cardiacSos?.dismissed) || isBpmCritical);
  const activeBpm = cardiacSos?.bpm || (currentBpm !== null ? currentBpm : 0);
  const isBradycardia = (cardiacSos?.type === 'bradycardia') || (currentBpm !== null && currentBpm <= 45);

  const [openingLid, setOpeningLid] = useState(false);

  const handleManualOpen = async () => {
    setOpeningLid(true);
    try {
      await onTriggerRemoteOpen?.();
    } finally {
      setTimeout(() => setOpeningLid(false), 2000);
    }
  };

  return (
    <section
      id="emergency-medicine-slot-section"
      className={`rounded-3xl border transition-all duration-300 relative overflow-hidden shadow-xs ${
        isSosActive
          ? 'bg-gradient-to-br from-rose-50 via-white to-amber-50/40 border-rose-300 ring-2 ring-rose-500/20 shadow-md'
          : 'bg-gradient-to-br from-slate-50/70 via-white to-blue-50/20 border-slate-200 hover:border-slate-300'
      }`}
    >
      {/* Top Accent Strip */}
      <div className={`h-2 w-full ${isSosActive ? 'bg-gradient-to-r from-rose-500 via-red-600 to-amber-500 animate-pulse' : 'bg-gradient-to-r from-blue-600 via-indigo-500 to-slate-400'}`} />

      <div className="p-6 sm:p-7 space-y-6">

        {/* ── Section Header ── */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className={`p-3 rounded-2xl shrink-0 ${isSosActive ? 'bg-rose-100 text-rose-600 ring-2 ring-rose-400 animate-pulse' : 'bg-rose-50 text-rose-600 border border-rose-100'}`}>
              <ShieldAlert className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-headline font-bold text-slate-800 tracking-tight">
                  Designated Emergency Medication Box Slot
                </h2>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                  isSosActive
                    ? 'bg-rose-100 text-rose-800 border-rose-300 animate-pulse'
                    : 'bg-slate-100 text-slate-600 border-slate-200'
                }`}>
                  {isSosActive ? '🚨 SOS TRIGGER ACTIVE' : '● Auto-Trigger Armed'}
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                  Thresholds: ≤45 BPM or &gt;120 BPM
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-500 font-medium mt-1">
                Automated hardware servo lid actuation: Opens automatically on critical bradycardia (≤45 BPM) or tachycardia (&gt;120 BPM).
              </p>
            </div>
          </div>

          {/* Quick Actuator Actions */}
          <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
            <button
              onClick={handleManualOpen}
              disabled={openingLid}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-bold transition shadow-xs cursor-pointer ${
                lidOpen
                  ? 'bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200'
                  : 'bg-rose-600 text-white hover:bg-rose-700 active:scale-95'
              }`}
            >
              <Package className="h-4 w-4" />
              {openingLid ? 'Opening Servo...' : lidOpen ? '🔓 Lid Is Open' : 'Open Emergency Lid'}
            </button>

            {isSosActive && (
              <>
                <button
                  onClick={async () => {
                    try {
                      await fetch('/api/hardware/medbox-event', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          event: 'DOSE_TAKEN',
                          box: 1,
                          medicine: 'Emergency Cardiac Dose',
                          dosage: '1 dose',
                          deviceId: 'medbox-01',
                        }),
                      });
                    } catch (e) {
                      console.error('[MEDBOX] Failed to trigger button override:', e);
                    }
                    onDismissCardiacSos?.();
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs text-xs font-bold transition cursor-pointer"
                  title="Simulate or confirm the physical button press on D4"
                >
                  <CheckCircle2 className="h-4 w-4" /> Accept Dose (Button Override)
                </button>

                <button
                  onClick={() => onDismissCardiacSos?.()}
                  className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 text-xs font-semibold transition cursor-pointer"
                >
                  Acknowledge SOS
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Active Alert Banner (conditional) ── */}
        {isSosActive && (
          <div className="p-4 rounded-2xl bg-rose-500 text-white shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3 animate-pulse">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-6 w-6 text-amber-200 shrink-0" />
              <div>
                <span className="font-bold text-sm block">
                  🚨 CARDIAC SOS TRIGGERED: {isBradycardia ? 'Critical Bradycardia (≤45 BPM)' : 'Critical Tachycardia (>120 BPM)'} Detected!
                </span>
                <span className="text-xs text-rose-100 mt-0.5 block">
                  Patient pulse reached {activeBpm > 0 ? `${activeBpm} BPM` : 'critical threshold'}. Medicine Box lid opened automatically. ONLY Slot 1 LED is blinking repeatedly — box closes ONLY after pressing the physical Confirm Button (D4) on the box.
                </span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <span className="inline-block px-3 py-1 bg-white/20 backdrop-blur-xs rounded-xl text-xs font-bold border border-white/30">
                Lid State: {lidOpen ? '🔓 OPEN (90°)' : 'Actuation Dispatched'}
              </span>
            </div>
          </div>
        )}

        {/* ── Hardware Overlap Notice ── */}
        <div className="p-4 rounded-2xl bg-amber-50/80 border border-amber-200 text-slate-700 text-xs space-y-1">
          <div className="flex items-center gap-2 font-bold text-amber-900 text-sm">
            <Zap className="h-4 w-4 text-amber-600" />
            Hardware Compartment Overlap Notice (Limited Physical Sections)
          </div>
          <p className="text-slate-600 leading-relaxed">
            As the hardware medicine box has a limited number of physical compartments (Boxes 1–4),
            <strong className="text-slate-800"> Compartment 1 (Box #1)</strong> is designated as the
            <strong className="text-rose-700"> Overlapping Emergency Medication Slot</strong>. Both daily routine medication
            {overlappingSlot?.medicineName ? ` (${overlappingSlot.medicineName})` : ''} and rapid-response emergency cardiac medications
            are stored in Compartment 1. Upon any cardiac BPM threshold breach, the automated servo lid unlocks Compartment 1 immediately.
          </p>
        </div>

        {/* ── Designated Emergency Slot Grid ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* Compartment 1 Overview Card */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Designated Compartment</span>
                <span className="px-2 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 text-[11px] font-bold rounded-lg">
                  ⚡ Overlapping Slot
                </span>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-rose-500 to-red-600 text-white font-bold text-xl flex items-center justify-center shadow-xs">
                  1
                </div>
                <div>
                  <h4 className="text-base font-bold font-headline text-slate-800">Compartment #1</h4>
                  <span className="text-xs text-slate-500 font-medium">Dual-Assigned Hardware Section</span>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Regular Schedule:</span>
                <span className="font-semibold text-slate-700">{overlappingSlot?.medicineName || 'Scheduled Dose'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Emergency Meds:</span>
                <span className="font-bold text-rose-700">Nitroglycerin / Aspirin / Atropine</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Physical Actuator:</span>
                <span className={`font-semibold ${lidOpen ? 'text-amber-700' : 'text-slate-700'}`}>
                  {lidOpen ? '🔓 90° Servo Open' : '🔒 0° Servo Closed'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">LED Indicator:</span>
                <span className={`font-semibold ${isSosActive ? 'text-rose-600 animate-pulse' : 'text-slate-700'}`}>
                  {isSosActive ? '💡 Only Slot 1 Blinking (4 Hz)' : '○ Standby'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Lid Closure:</span>
                <span className={`font-semibold ${isSosActive ? 'text-amber-700' : 'text-slate-700'}`}>
                  {isSosActive ? '🔒 Closes ONLY on Confirm Button (D4)' : 'Ready'}
                </span>
              </div>
            </div>
          </div>

          {/* Emergency Med 1: High BPM / Tachycardia */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-rose-600">High Pulse Emergency (&gt;120 BPM)</span>
                <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-semibold rounded-lg">Box #1 Slot</span>
              </div>
              <h4 className="text-base font-bold font-headline text-slate-800 mt-2">
                Nitroglycerin (Sorbitrate) 0.5mg + Aspirin 325mg
              </h4>
              <p className="text-xs text-slate-500 font-medium mt-1">
                Sublingual tablet (under tongue) + Chewable Aspirin.
              </p>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Trigger:</span>
                <span className="font-bold text-rose-600">BPM &gt; 120 (Tachycardia)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Clinical Action:</span>
                <span className="font-semibold text-slate-700">Rapid coronary vasodilation</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Instructions:</span>
                <span className="text-slate-600">Dissolve under tongue; sit down.</span>
              </div>
            </div>
          </div>

          {/* Emergency Med 2: Low BPM / Bradycardia */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-600">Low Pulse Emergency (≤45 BPM)</span>
                <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-semibold rounded-lg">Box #1 Slot</span>
              </div>
              <h4 className="text-base font-bold font-headline text-slate-800 mt-2">
                Cardiac Stimulant / Atropine Support
              </h4>
              <p className="text-xs text-slate-500 font-medium mt-1">
                Oral emergency cardiotonic support tablet.
              </p>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Trigger:</span>
                <span className="font-bold text-indigo-600">BPM ≤ 45 (Bradycardia)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Clinical Action:</span>
                <span className="font-semibold text-slate-700">Sinus node pulse restoration</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Instructions:</span>
                <span className="text-slate-600">Take immediately with small sip of water.</span>
              </div>
            </div>
          </div>

        </div>

        {/* ── Live Telemetry & Diagnostic Verification Strip ── */}
        <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-white border border-slate-200 text-blue-600">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <span className="font-bold text-slate-700 block">
                Live Bracelet Pulse Telemetry: {currentBpm !== null ? `${currentBpm} BPM` : 'Standby / Awaiting Packet'}
              </span>
              <span className="text-slate-500 mt-0.5 block">
                Safety bounds: 46–120 BPM. Any reading ≤45 or &gt;120 initiates automatic emergency lid trigger.
              </span>
            </div>
          </div>

          {/* Testing / Simulator controls */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Test Trigger:</span>
            <button
              onClick={() => onSimulateCardiacSos?.(42)}
              className="px-2.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-indigo-700 font-bold transition cursor-pointer"
            >
              Simulate ≤45 BPM (42)
            </button>
            <button
              onClick={() => onSimulateCardiacSos?.(135)}
              className="px-2.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-rose-700 font-bold transition cursor-pointer"
            >
              Simulate &gt;120 BPM (135)
            </button>
            {isSosActive && (
              <button
                onClick={() => onDismissCardiacSos?.()}
                className="px-2.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 font-semibold transition cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>
        </div>

      </div>
    </section>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function MedicineBox({
  slots = [],
  lidOpen = false,
  medboxStatus,
  onMarkTaken,
  onMarkMissed,
  onResetSlot,
  onDeleteSlot,
  onUpdateSlots,
  vitals,
  cardiacSos,
  onTriggerRemoteOpen,
  onDismissCardiacSos,
  onSimulateCardiacSos,
}: MedicineBoxProps) {
  const [showAddForm, setShowAddForm] = useState(false);

  const safeSlots = Array.isArray(slots) ? slots.filter(Boolean) : [];
  const takenCount  = safeSlots.filter(s => s?.taken).length;
  const missedCount = safeSlots.filter(s => (s as any)?.missed).length;
  const pendingCount = Math.max(0, safeSlots.length - takenCount - missedCount);
  const adherencePct = safeSlots.length > 0
    ? Math.round((takenCount / safeSlots.length) * 100)
    : 0;

  const handleAddSlot = (partial: Omit<MedicineSlot, 'id' | 'taken' | 'presenceConfirmed' | 'touchVerified'>) => {
    const newSlot: MedicineSlot = {
      id: `slot-${Date.now()}`,
      taken: false,
      presenceConfirmed: false,
      touchVerified: false,
      ...partial,
    };
    onUpdateSlots([...safeSlots, newSlot]);
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
            <span className="text-slate-500 font-medium">◯ {pendingCount} pending</span>
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
              style={{ width: `${safeSlots.length > 0 ? (missedCount / safeSlots.length) * 100 : 0}%` }}
            />
          )}
        </div>
        {takenCount === safeSlots.length && safeSlots.length > 0 && (
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

      {/* ── Emergency SOS Medicine Slot Section (Designated & Overlapping) ── */}
      <EmergencyMedicineSection
        lidOpen={lidOpen}
        medboxStatus={medboxStatus}
        vitals={vitals}
        cardiacSos={cardiacSos}
        overlappingSlot={safeSlots.find(s => s.slotNumber === 1)}
        onTriggerRemoteOpen={onTriggerRemoteOpen}
        onDismissCardiacSos={onDismissCardiacSos}
        onSimulateCardiacSos={onSimulateCardiacSos}
      />

      {/* ── Physical 4-box grid ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-600" />
            Physical Compartments ({safeSlots.length})
          </h3>
        </div>

        {safeSlots.length === 0 ? (
          <div className="text-center py-14 text-slate-400 bg-white border border-dashed border-slate-200 rounded-3xl shadow-xs">
            <Pill className="h-10 w-10 mx-auto mb-3 text-slate-300" />
            <p className="text-base font-semibold text-slate-700">No slots configured yet.</p>
            <p className="text-xs text-slate-500 mt-1">Click "Add Slot" or configure via the Prescriptions tab.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {safeSlots.map(slot => (
              <BoxCard
                key={slot.id}
                slot={slot}
                espState={medboxStatus.state}
                onMarkTaken={onMarkTaken}
                onMarkMissed={onMarkMissed}
                onResetSlot={onResetSlot}
                onDeleteSlot={onDeleteSlot}
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

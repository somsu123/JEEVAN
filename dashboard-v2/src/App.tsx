import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, User } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Overview from './components/Overview';
import ReportScanner from './components/ReportScanner';
import LiveVitals from './components/LiveVitals';
import FallAlerts from './components/FallAlerts';
import MedicineBox from './components/MedicineBox';
import RxReview from './components/RxReview';
import DoseHistory from './components/DoseHistory';
import { VitalState, ViewType, ScanResult, FallEvent, MedicineSlot, MedboxStatus, MedboxDeviceState } from './types';
import { motion, AnimatePresence } from 'motion/react';

const makeDefaultVitals = (): VitalState => ({
  heartRate: '--', heartRateHistory: [], movementState: 'Unknown',
  bloodLevelSeconds: null, oxygenSpO2: 0, roomPresence: null, fingerPresent: false,
  lastUpdated: '--', lastPacketAt: null, sensorError: false,
});

// ─── DoseEntry → MedicineSlot mapper ──────────────────────────────────────────
// Server returns DoseEntry (time/medicine/boxNumber), frontend needs MedicineSlot
// (scheduledTime/medicineName/slotNumber). This bridges the two shapes.
interface ServerDoseEntry {
  time: string;
  medicine: string;
  dosage: string;
  boxNumber: number;
  taken: boolean;
  takenAt?: string;
  missed?: boolean;
  notes?: string;
}

function mapDosesToSlots(doses: ServerDoseEntry[]): MedicineSlot[] {
  return doses.map((d, i) => ({
    id: `slot-${d.boxNumber}-${d.time}-${i}`,
    slotNumber: d.boxNumber,
    medicineName: d.medicine,
    dosage: d.dosage || '—',
    scheduledTime: d.time,
    taken: d.taken,
    takenAt: d.takenAt,
    missed: d.missed || false,
    presenceConfirmed: d.taken,   // If taken, presence was confirmed
    touchVerified: d.taken,       // If taken, touch was verified
    notes: d.notes,
  }));
}

function mapSlotsToServerDoses(slots: MedicineSlot[]): ServerDoseEntry[] {
  return slots.map(s => ({
    time: s.scheduledTime,
    medicine: s.medicineName,
    dosage: s.dosage,
    boxNumber: s.slotNumber,
    taken: s.taken,
    takenAt: s.takenAt,
    missed: s.missed || false,
    notes: s.notes,
  }));
}

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>('overview');
  const [activeAlert, setActiveAlert] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [hardwareOnline, setHardwareOnline] = useState(false);
  const [espConnected, setEspConnected] = useState(false);
  const previousFallActive = useRef(false);

  const [vitals, setVitals] = useState<VitalState>(makeDefaultVitals());
  const [fallEvents, setFallEvents] = useState<FallEvent[]>([]);
  const [medicineSlots, setMedicineSlots] = useState<MedicineSlot[]>([]);
  const [lidOpen, setLidOpen] = useState(false);
  const [scannedHistory, setScannedHistory] = useState<ScanResult[]>([]);
  const [medboxStatus, setMedboxStatus] = useState<MedboxStatus>({
    online: false, state: 'UNKNOWN', presenceDetected: false, lastSeen: '', nextDoseTime: '', uptime: 0, deviceId: 'medbox-01',
  });
  const [pendingRxCount, setPendingRxCount] = useState(0);
  const [medicineReminder, setMedicineReminder] = useState<{ medicine: string; dosage: string; time: string; message: string } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Poll the vitals proxy while healthy; retry backend failures with jittered backoff.
  useEffect(() => {
    let stopped = false;
    let timeoutId: number | undefined;
    let requestTimeoutId: number | undefined;
    let requestController: AbortController | null = null;
    let retryDelayMs = 500;

    const pollHardware = async () => {
      let nextDelayMs = 400;
      try {
        requestController = new AbortController();
        requestTimeoutId = window.setTimeout(() => requestController?.abort(), 3500);
        const response = await fetch('/api/vitals', {
          cache: 'no-store',
          signal: requestController.signal,
        });
        if (!response.ok) throw new Error(`Vitals endpoint returned ${response.status}`);
        const data = await response.json();
        if (stopped) return;
        if (data._offline) throw new Error('Vitals backend unavailable');

        const packetAt = data.lastPacketAt == null ? NaN : Number(data.lastPacketAt);
        const packetFresh = Boolean(
          data.espConnected && (
            !Number.isFinite(packetAt) ||
            (Date.now() - packetAt >= -10000 && Date.now() - packetAt <= 8000)
          )
        );
        setHardwareOnline(true);
        setEspConnected(packetFresh);
        setVitals(prev => ({
          ...prev,
          ...data,
          heartRate: packetFresh && data.fingerPresent && Number(data.heartRate) > 0 ? Number(data.heartRate) : '--',
          oxygenSpO2: packetFresh && data.fingerPresent ? Number(data.oxygenSpO2) || 0 : 0,
          fingerPresent: packetFresh && Boolean(data.fingerPresent),
          // Use client receipt time for the local stale guard
          lastPacketAt: packetFresh ? Date.now() : prev.lastPacketAt,
          heartRateHistory: packetFresh && Array.isArray(data.heartRateHistory) && data.heartRateHistory.length > 0
            ? data.heartRateHistory.slice(-60)
            : prev.heartRateHistory,
          spo2History: packetFresh && Array.isArray(data.spo2History) && data.spo2History.length > 0
            ? data.spo2History.slice(-60)
            : prev.spo2History,
          lastUpdated: packetFresh ? data.lastUpdated : prev.lastUpdated,
          sensorError: packetFresh && Boolean(data.sensorError),
          movementState: packetFresh ? data.movementState || 'Unknown' : 'Unknown',
          bloodLevelSeconds: packetFresh && Number.isFinite(Number(data.bloodLevelSeconds)) ? Number(data.bloodLevelSeconds) : null,
          roomPresence: packetFresh && typeof data.roomPresence === 'boolean' ? data.roomPresence : null,
        }));
        if (data.isFall && !previousFallActive.current) {
          handleIncomingFall({
            source: data.fallSource === 'bracelet' ? 'bracelet' : 'camera',
            confidence: data.fallConfidence != null && Number.isFinite(Number(data.fallConfidence)) ? Number(data.fallConfidence) : null,
            location: typeof data.location === 'string' && data.location.trim() ? data.location : null,
          });
        }
        previousFallActive.current = Boolean(data.isFall);
        retryDelayMs = 400;
      } catch {
        if (!stopped && retryDelayMs > 2000) {
          setHardwareOnline(false);
          setEspConnected(false);
          setVitals(prev => ({
            ...prev,
            heartRate: '--', oxygenSpO2: 0, fingerPresent: false,
            heartRateHistory: [], spo2History: [], lastPacketAt: null,
            lastUpdated: '--', signalQuality: 'unknown', sensorError: false,
            movementState: 'Unknown', bloodLevelSeconds: null, roomPresence: null,
          }));
        }
        nextDelayMs = Math.round(retryDelayMs * (0.5 + Math.random()));
        retryDelayMs = Math.min(retryDelayMs * 2, 4000);
      } finally {
        if (requestTimeoutId !== undefined) clearTimeout(requestTimeoutId);
        requestTimeoutId = undefined;
        requestController = null;
      }
      if (!stopped) timeoutId = window.setTimeout(pollHardware, nextDelayMs);
    };

    pollHardware();
    return () => {
      stopped = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (requestTimeoutId !== undefined) clearTimeout(requestTimeoutId);
      requestController?.abort();
    };
  }, []);

  useEffect(() => {
    fetch('/api/saved-reports').then(r => r.json()).then(data => {
      if (data && Array.isArray(data.reports)) {
        setScannedHistory(data.reports.map((r: any) => ({ fileName: r.fileName || 'unnamed document', timestamp: r.scanDate || new Date(r.createdAt * 1000).toLocaleString() || '', summary: r.summary || '' })));
      }
    }).catch(() => { });
  }, []);

  // ─── Medbox: Fetch schedule on mount ──────────────────────────────────────
  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/medication/schedule');
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.doses)) {
        setMedicineSlots(mapDosesToSlots(data.doses));
      }
    } catch { /* server may be down */ }
  }, []);

  const fetchMedboxStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/medbox-status');
      if (!res.ok) return;
      const data = await res.json();
      setMedboxStatus({
        online: data.online ?? false,
        state: (data.state || 'UNKNOWN') as MedboxDeviceState,
        presenceDetected: data.presenceDetected ?? false,
        lastSeen: data.lastSeen || '',
        nextDoseTime: data.nextDoseTime || '',
        uptime: data.uptime ?? 0,
        deviceId: data.deviceId || 'medbox-01',
      });
    } catch { /* server may be down */ }
  }, []);

  // Initial fetch + 10s polling fallback for medbox status
  useEffect(() => {
    fetchSchedule();
    fetchMedboxStatus();
    const id = setInterval(fetchMedboxStatus, 10_000);
    return () => clearInterval(id);
  }, [fetchSchedule, fetchMedboxStatus]);

  // ─── Medbox: SSE listener for real-time updates ───────────────────────────
  useEffect(() => {
    const es = new EventSource('/api/events-stream');

    es.addEventListener('medbox_heartbeat', (e) => {
      try {
        const data = JSON.parse(e.data);
        setMedboxStatus({
          online: true,
          state: (data.state || 'UNKNOWN') as MedboxDeviceState,
          presenceDetected: data.presenceDetected ?? false,
          lastSeen: data.lastSeen || new Date().toISOString(),
          nextDoseTime: data.nextDoseTime || '',
          uptime: data.uptime ?? 0,
          deviceId: data.deviceId || 'medbox-01',
        });
      } catch { /* malformed SSE */ }
    });

    es.addEventListener('medbox_offline', () => {
      setMedboxStatus(prev => ({ ...prev, online: false }));
    });

    es.addEventListener('medicine_taken', (e) => {
      try {
        const data = JSON.parse(e.data);
        // Optimistically update the matching slot
        setMedicineSlots(prev => prev.map(s => {
          const boxMatches = s.slotNumber === Number(data.box);
          if (boxMatches && !s.taken) {
            return { ...s, taken: true, takenAt: data.timestamp || new Date().toLocaleTimeString('en-US', { hour12: false }), presenceConfirmed: true, touchVerified: true };
          }
          return s;
        }));
      } catch { /* malformed SSE */ }
    });

    es.addEventListener('medicine_missed', (e) => {
      try {
        const data = JSON.parse(e.data);
        setMedicineSlots(prev => prev.map(s => {
          const boxMatches = s.slotNumber === Number(data.box);
          if (boxMatches && !s.taken) {
            return { ...s, missed: true } as MedicineSlot;
          }
          return s;
        }));
      } catch { /* malformed SSE */ }
    });

    es.addEventListener('schedule_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && Array.isArray(data.doses)) {
          setMedicineSlots(mapDosesToSlots(data.doses));
        }
      } catch { /* malformed SSE — fall back to poll */ fetchSchedule(); }
    });

    // Also pick up lid state from the medicine-state endpoint
    const lidPoll = setInterval(async () => {
      try {
        const res = await fetch('/api/medicine-state');
        if (res.ok) {
          const data = await res.json();
          setLidOpen(data.lidOpen ?? false);
        }
      } catch { /* ignore */ }
    }, 5_000);

    return () => { es.close(); clearInterval(lidPoll); };
  }, [fetchSchedule]);

  // ─── Medbox: Action handlers ──────────────────────────────────────────────
  const handleMarkTaken = useCallback(async (slotId: string) => {
    // Optimistic update
    const takenAt = new Date().toLocaleTimeString('en-US', { hour12: false });
    setMedicineSlots(prev => prev.map(s =>
      s.id === slotId ? { ...s, taken: true, takenAt, presenceConfirmed: true, touchVerified: true } : s
    ));
    try {
      await fetch('/api/medicine-taken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId }),
      });
    } catch { /* server will broadcast SSE on success anyway */ }
  }, []);

  const handleMarkMissed = useCallback(async (slotId: string) => {
    // Optimistic update
    setMedicineSlots(prev => prev.map(s =>
      s.id === slotId ? { ...s, missed: true } as MedicineSlot : s
    ));
    try {
      const slot = medicineSlots.find(s => s.id === slotId);
      await fetch('/api/hardware/medbox-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'DOSE_MISSED',
          box: slot?.slotNumber ?? 1,
          medicine: slot?.medicineName ?? 'Unknown',
          dosage: slot?.dosage ?? '',
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
          deviceId: 'medbox-01',
        }),
      });
    } catch { /* ignore */ }
  }, [medicineSlots]);

  const handleResetSlot = useCallback(async (slotId: string) => {
    // Optimistic update — clear taken/missed state
    setMedicineSlots(prev => prev.map(s =>
      s.id === slotId ? { ...s, taken: false, takenAt: undefined, missed: false, presenceConfirmed: false, touchVerified: false } as MedicineSlot : s
    ));
    // Persist: write the full updated schedule back to the server
    const updatedSlots = medicineSlots.map(s =>
      s.id === slotId ? { ...s, taken: false, takenAt: undefined, missed: false, presenceConfirmed: false, touchVerified: false } as MedicineSlot : s
    );
    try {
      await fetch('/api/medicine-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: updatedSlots }),
      });
    } catch { /* ignore */ }
  }, [medicineSlots]);

  const handleUpdateSlots = useCallback(async (newSlots: MedicineSlot[]) => {
    setMedicineSlots(newSlots);
    try {
      await fetch('/api/medicine-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: newSlots }),
      });
    } catch { /* ignore */ }
  }, []);

  const handleIncomingFall = useCallback((params: { source: FallEvent['source']; confidence: number | null; location: string | null }) => {
    setFallEvents(prev => [{ id: `fall-${Date.now()}`, isoTimestamp: new Date().toISOString(), timestamp: new Date().toLocaleTimeString('en-US'), type: params.confidence == null ? 'Fall Detected' : params.confidence >= 0.85 ? 'Critical Fall' : 'Rapid Descent', source: params.source, location: params.location || 'Unknown location', confidence: params.confidence, status: 'active' }, ...prev]);
    setActiveAlert(true);
  }, []);

  const handleResolveFall = useCallback(async (id: string) => {
    setFallEvents(prev => prev.map(f => f.id === id ? { ...f, status: 'resolved', resolvedAt: new Date().toLocaleTimeString('en-US') } : f));
    try { await fetch(`/api/fall-event/${id}/resolve`, { method: 'PATCH' }); } catch { }
  }, []);

  const handleClearFalls = useCallback(() => setFallEvents(prev => prev.filter(f => f.status === 'active')), []);

  const renderView = () => {
    switch (currentView) {
      case 'overview': return <Overview scannedHistory={scannedHistory} onNavigate={setCurrentView} activeAlert={activeAlert} vitals={vitals} hardwareOnline={hardwareOnline} espConnected={espConnected} />;
      case 'live-vitals': return <LiveVitals vitals={vitals} hardwareOnline={hardwareOnline} espConnected={espConnected} />;
      case 'fall-alerts': return <FallAlerts fallEvents={fallEvents} activeAlert={activeAlert} onResolveEvent={handleResolveFall} onClearAll={handleClearFalls} />;
      case 'medicine': return <MedicineBox slots={medicineSlots} lidOpen={lidOpen} medboxStatus={medboxStatus} onMarkTaken={handleMarkTaken} onMarkMissed={handleMarkMissed} onResetSlot={handleResetSlot} onUpdateSlots={handleUpdateSlots} />;
      case 'report-scanner': return <ReportScanner onAddScanResult={(res) => setScannedHistory(p => [res, ...p])} scannedHistory={scannedHistory} />;
      case 'rx-review': return <RxReview />;
      case 'dose-history': return <DoseHistory />;
      default: return <div className="p-8 text-center text-slate-400">View not found. Return to Overview.</div>;
    }
  };

  const activeFallCount = fallEvents.filter(f => f.status === 'active').length;
  const timeString = currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="flex h-screen overflow-hidden bg-[#030712] font-body text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-300 relative">
      <Sidebar currentView={currentView} onViewChange={setCurrentView} activeAlert={activeAlert} onTriggerSOS={() => setActiveAlert(true)} fallCount={activeFallCount} pendingRxCount={pendingRxCount} />

      <div className="flex-1 flex flex-col min-w-0 relative z-10">
        {/* Floating Top Nav (21st.dev Style) */}
        <header className="h-20 shrink-0 px-8 flex items-center justify-between z-40 bg-gradient-to-b from-[#030712] to-transparent pointer-events-none">
          <div className="flex items-center gap-4 pointer-events-auto">
            <div className="relative group cursor-pointer">
              <div className="h-11 w-11 rounded-2xl bg-slate-800/80 backdrop-blur-md border border-white/10 flex items-center justify-center text-emerald-400 overflow-hidden transition-transform group-hover:scale-105">
                <User className="h-5 w-5" aria-hidden="true" />
              </div>
              <span className={`absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-[3px] border-[#030712] ${espConnected ? 'bg-emerald-500 pulse-emerald' : 'bg-slate-500'}`} />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-bold font-headline text-white tracking-wide">JEEVAN</span>
              <span className="text-xs text-slate-400 font-medium">Care dashboard</span>
            </div>
          </div>

          <div className="flex items-center gap-6 pointer-events-auto">
            <div className="flex items-center gap-3 px-4 py-2 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-md">
              <Activity className="h-4 w-4 text-emerald-400" />
              <div className="flex flex-col text-right">
                <span className="text-xs font-bold text-slate-200 leading-none">{timeString}</span>
                <span className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">
                  {espConnected ? 'Vitals streaming' : hardwareOnline ? 'Waiting for vitals' : 'Sensor offline'}
                </span>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto custom-scrollbar px-8 pb-12 pt-4">
          <div className="max-w-[1400px] mx-auto h-full">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentView}
                initial={{ opacity: 0, y: 15, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -15, filter: 'blur(8px)' }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="h-full"
              >
                {renderView()}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}

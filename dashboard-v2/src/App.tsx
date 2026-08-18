import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Clock,
  User,
  Battery,
  ShieldAlert,
  X,
} from 'lucide-react';
import Sidebar from './components/Sidebar';
import Overview from './components/Overview';
import ReportScanner from './components/ReportScanner';
import LiveVitals from './components/LiveVitals';
import FallAlerts from './components/FallAlerts';
import MedicineBox from './components/MedicineBox';
import RxReview from './components/RxReview';
import DoseHistory from './components/DoseHistory';
import {
  VitalState,
  ViewType,
  ScanResult,
  FallEvent,
  MedicineSlot,
  MedboxStatus,
  MedboxDeviceState,
} from './types';

// ─── Default state factories ──────────────────────────────────────────────────
const makeDefaultVitals = (): VitalState => ({
  heartRate: '--',
  heartRateHistory: [],
  movementState: 'Resting',
  bloodLevelSeconds: 15,
  oxygenSpO2: 98,
  roomPresence: true,
  fingerPresent: false,
  lastUpdated: new Date().toLocaleTimeString('en-US', { hour12: false }),
});

const DEFAULT_SLOTS: MedicineSlot[] = [];

const DEFAULT_SCAN_HISTORY: ScanResult[] = [
  {
    fileName: 'Cardio_EKG_Doctor_Note.png',
    timestamp: '14:30 - May 24, 2026',
    summary: `### Cardiology Consultation Note
* **Heart Rhythm**: Stable Sinus Rhythm at **72 BPM** with isolated Premature Ventricular Contractions (PVCs) resolving during extended resting. No active ischemia.

### Medication Changes & Precautions
1. **Lisinopril Dosage**: Take **10mg once daily** in the morning hours to support cardiovascular health.
2. **Orthostatic Precaution**: Avoid swift standing. If momentary dizziness occurs, sit down immediately to prevent risk of falls.`,
  },
  {
    fileName: 'Arthur_Blood_Lab_Result.png',
    timestamp: '09:15 - May 22, 2026',
    summary: `### Primary Diagnostics Summary
* **Hemoglobin test**: **11.2 g/dL** (Mild Anemia present. Typical range is 13.8–17.2 g/dL. Clinical suggestion: monitor iron intake and check B12 levels).
* **Kidney Profile (BUN/Creatinine)**: Blood Urea Nitrogen (BUN) measured at **28 mg/dL** (Mildly elevated, suggesting slight dehydration or normal age-related decline in filtration. GFR estimated at **58 mL/min/1.73m²**, representing stable Stage 3a Chronic Kidney Disease).
* **Glucose levels**: Fasting blood sugar stands at **98 mg/dL** (Perfect, healthy metabolic regulation).

### Prescribed Care & Daily Actions
1. **Fluid Optimization**: Keep daily clear fluid/water intake at 1.8 liters to aid kidney filtration and reduce BUN levels.
2. **Lab Scheduling**: Routine re-evaluation of blood panel ordered in 3 months to monitor Hemoglobin stability.`,
  },
];

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>('overview');
  const [activeAlert, setActiveAlert] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [hardwareOnline, setHardwareOnline] = useState(false);

  // ── ESP32 connection + finger status ─────────────────────────────────────────
  const [espConnected, setEspConnected] = useState(false);
  const [connectionToast, setConnectionToast] = useState<{
    type: 'connected' | 'disconnected';
    visible: boolean;
  } | null>(null);
  const prevEspConnected = useRef<boolean | null>(null);

  // ── Global State ────────────────────────────────────────────────────────────
  const [vitals, setVitals] = useState<VitalState>(makeDefaultVitals());
  const [fallEvents, setFallEvents] = useState<FallEvent[]>([]);
  const [medicineSlots, setMedicineSlots] = useState<MedicineSlot[]>(DEFAULT_SLOTS);
  const [lidOpen, setLidOpen] = useState(false);
  const [scannedHistory, setScannedHistory] = useState<ScanResult[]>(DEFAULT_SCAN_HISTORY);
  const [medboxStatus, setMedboxStatus] = useState<MedboxStatus>({
    online: false,
    state: 'UNKNOWN' as MedboxDeviceState,
    presenceDetected: false,
    lastSeen: '',
    nextDoseTime: '',
    uptime: 0,
    deviceId: 'medbox-01',
  });

  // ── Rx pipeline: pending changes count (for Sidebar badge) ─────────────────
  const [pendingRxCount, setPendingRxCount] = useState(0);
  useEffect(() => {
    const fetchPendingCount = async () => {
      try {
        const res = await fetch('/api/rx/pending');
        if (res.ok) {
          const data = await res.json();
          setPendingRxCount(data.count || 0);
        }
      } catch { /* offline */ }
    };
    fetchPendingCount();
    const iv = setInterval(fetchPendingCount, 30_000);
    return () => clearInterval(iv);
  }, []);

  // Medicine reminder alert (from server cron)
  const [medicineReminder, setMedicineReminder] = useState<{
    medicine: string; dosage: string; time: string; message: string;
  } | null>(null);


  // ── Clock ticker (no simulation) ────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);



  // ── Poll backend for real hardware data (ESP32 MAX30102 + Vitals) ────────
  useEffect(() => {
    const pollHardware = async () => {
      try {
        const [vitalsRes, bpmHistoryRes] = await Promise.all([
          fetch('/api/vitals').catch(() => null),
          fetch('/api/bpm/history?n=60').catch(() => null),
        ]);

        if (vitalsRes && vitalsRes.ok) {
          const data = await vitalsRes.json();
          if (!data._offline) {
            setHardwareOnline(true);
            setVitals(prev => ({
              ...prev,
              heartRate: data.heartRate ?? prev.heartRate,
              oxygenSpO2: data.oxygenSpO2 ?? prev.oxygenSpO2,
              movementState: data.movementState ?? prev.movementState,
              roomPresence: data.roomPresence ?? prev.roomPresence,
              fingerPresent: data.fingerPresent ?? prev.fingerPresent,
              signalQuality: data.signalQuality ?? prev.signalQuality,
              lastUpdated: new Date().toLocaleTimeString('en-US', { hour12: false }),
            }));

            // If a fall is reported, inject it
            if (data.isFall) {
              handleIncomingFall({
                source: 'camera' as const,
                confidence: 0.92,
                location: 'Living Room',
              });
            }
          }
        }

        if (bpmHistoryRes && bpmHistoryRes.ok) {
          const historyData = await bpmHistoryRes.json();
          if (historyData && Array.isArray(historyData.history) && historyData.history.length > 0) {
            const validEntries = historyData.history.filter((h: any) => h.fingerDetected && h.bpm > 0);
            if (validEntries.length > 0) {
              const bpmTrace = validEntries.map((h: any) => ({
                time: new Date(h.timestamp || Date.now()).toISOString(),
                value: h.bpm,
              }));
              const spo2Trace = validEntries.filter((h: any) => h.spo2 > 0).map((h: any) => ({
                time: new Date(h.timestamp || Date.now()).toISOString(),
                value: h.spo2,
              }));
              setVitals(prev => ({
                ...prev,
                heartRateHistory: bpmTrace.length > 0 ? bpmTrace : prev.heartRateHistory,
                spo2History: spo2Trace.length > 0 ? spo2Trace : prev.spo2History,
              }));
            }
          }
        }
      } catch {
        setHardwareOnline(false);
      }
    };

    pollHardware();
    const interval = setInterval(pollHardware, 1500);
    return () => clearInterval(interval);
  }, []);

  // ── Poll ESP32 connection + finger detection status every 2 s ─────────────────
  useEffect(() => {
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    const pollEsp32Status = async () => {
      try {
        const res = await fetch('/api/esp32/status');
        if (!res.ok) return;
        const data = await res.json();
        const isConnected: boolean = data.espConnected ?? false;
        const fingerDet: boolean   = data.fingerDetected ?? false;

        // Detect transitions to show toast
        if (prevEspConnected.current !== null && prevEspConnected.current !== isConnected) {
          if (toastTimer) clearTimeout(toastTimer);
          setConnectionToast({ type: isConnected ? 'connected' : 'disconnected', visible: true });
          toastTimer = setTimeout(() => setConnectionToast(null), 4500);
        }
        prevEspConnected.current = isConnected;

        setEspConnected(isConnected);
        // Also sync fingerPresent from this fast-poll so it reflects immediately
        setVitals(prev => ({
          ...prev,
          fingerPresent: isConnected ? fingerDet : false,
          signalQuality: isConnected ? (data.signal ?? prev.signalQuality) : 'unknown',
        }));
      } catch {
        // bpm-server itself unreachable — don't change espConnected
      }
    };

    pollEsp32Status();
    const interval = setInterval(pollEsp32Status, 2000);
    return () => {
      clearInterval(interval);
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, []);

  // ── Poll medicine state from Flask ──────────────────────────────────────────
  useEffect(() => {
    const pollMedicine = async () => {
      try {
        const res = await fetch('/api/medicine-state');
        if (res.ok) {
          const data = await res.json();
          setLidOpen(data.lidOpen ?? false);
        }
      } catch { /* Flask offline */ }
    };
    pollMedicine();
    const interval = setInterval(pollMedicine, 5000);
    return () => clearInterval(interval);
  }, []);


  // ── Poll initial medbox status ──────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/medbox-status')
      .then(r => r.json())
      .then(data => setMedboxStatus(prev => ({ ...prev, ...data })))
      .catch(() => {});
  }, []);

  // ── Fetch dynamic medication schedule from MongoDB Atlas on mount ────────────
  useEffect(() => {
    fetch('/api/medication/schedule')
      .then(r => r.json())
      .then(data => {
        if (data && Array.isArray(data.doses)) {
          const updated: MedicineSlot[] = data.doses.map((d: any) => ({
            id: `slot-${d.boxNumber}-${d.time}`,
            slotNumber: d.boxNumber,
            medicineName: d.medicine,
            dosage: d.dosage,
            scheduledTime: d.time,
            taken: d.taken || false,
            presenceConfirmed: d.presenceConfirmed || false,
            touchVerified: d.touchVerified || false,
            notes: d.notes || 'Persisted dynamic schedule',
          }));
          setMedicineSlots(updated);
        }
      })
      .catch((err) => console.error("Failed to load database medicine schedule:", err));
  }, []);

  // ── Fetch saved clinical scanner reports from MongoDB Atlas on mount ─────────
  useEffect(() => {
    fetch('/api/saved-reports')
      .then(r => r.json())
      .then(data => {
        if (data && Array.isArray(data.reports)) {
          const formatted: ScanResult[] = data.reports.map((r: any) => ({
            fileName: r.fileName || 'unnamed document',
            timestamp: r.scanDate || new Date(r.createdAt * 1000).toLocaleString() || '',
            summary: r.summary || ''
          }));
          
          setScannedHistory(prev => {
            const merged = [...formatted];
            DEFAULT_SCAN_HISTORY.forEach(def => {
              if (!merged.some(m => m.fileName === def.fileName)) {
                merged.push(def);
              }
            });
            return merged;
          });
        }
      })
      .catch((err) => console.error("Failed to load saved reports from DB:", err));
  }, []);

  // ── Fetch historical BPM telemetry logs from MongoDB Atlas on mount ─────────
  useEffect(() => {
    fetch('/api/heartrate/history?limit=60')
      .then(r => r.json())
      .then(data => {
        if (data && Array.isArray(data.history)) {
          const formattedHistory = data.history.map((h: any) => ({
            time: new Date(h.timestamp * 1000).toISOString(),
            value: h.bpm
          }));
          setVitals(prev => ({
            ...prev,
            heartRateHistory: formattedHistory
          }));
        }
      })
      .catch((err) => console.error("Failed to load BPM history from DB:", err));
  }, []);

  // ── SSE listener for real-time events ────────────────────────────────────────
  useEffect(() => {
    let evtSource: EventSource | null = null;
    try {
      evtSource = new EventSource('/api/events-stream');

      evtSource.addEventListener('fall_event', (e) => {
        const data = JSON.parse(e.data);
        setFallEvents(prev => {
          const exists = prev.some(f => f.id === data.id);
          if (exists) return prev;
          return [{ ...data, isoTimestamp: data.isoTimestamp || new Date().toISOString() } as FallEvent, ...prev];
        });
        setActiveAlert(true);
      });

      evtSource.addEventListener('fall_resolved', (e) => {
        const { id } = JSON.parse(e.data);
        setFallEvents(prev => prev.map(f => f.id === id ? { ...f, status: 'resolved' as const } : f));
        const stillActive = fallEvents.some(f => f.id !== id && f.status === 'active');
        if (!stillActive) setActiveAlert(false);
      });

      evtSource.addEventListener('medicine_taken', (e) => {
        const data = JSON.parse(e.data) as { box: number; timestamp: string };
        setMedicineSlots(prev => prev.map(s =>
          s.slotNumber === data.box
            ? { ...s, taken: true, takenAt: data.timestamp, touchVerified: true, presenceConfirmed: true }
            : s
        ));
      });

      evtSource.addEventListener('medicine_missed', (e) => {
        const data = JSON.parse(e.data) as { box: number };
        setMedicineSlots(prev => prev.map(s =>
          s.slotNumber === data.box ? { ...s, missed: true } as any : s
        ));
      });

      evtSource.addEventListener('medbox_heartbeat', (e) => {
        const data = JSON.parse(e.data) as MedboxStatus;
        setMedboxStatus(prev => ({ ...prev, ...data }));
      });

      evtSource.addEventListener('medbox_offline', () => {
        setMedboxStatus(prev => ({ ...prev, online: false, state: 'UNKNOWN' as MedboxDeviceState }));
      });

      evtSource.addEventListener('schedule_updated', (e) => {
        const { doses } = JSON.parse(e.data) as { doses: Array<{ boxNumber: number; time: string; medicine: string; dosage: string; taken: boolean }> };
        const updated: MedicineSlot[] = doses.map((d, i) => ({
          id: `slot-${d.boxNumber}`,
          slotNumber: d.boxNumber,
          medicineName: d.medicine,
          dosage: d.dosage,
          scheduledTime: d.time,
          taken: d.taken,
          presenceConfirmed: false,
          touchVerified: false,
        }));
        setMedicineSlots(updated);
      });



      // ── Real-time BPM from Bracelet SSE event ───────────────────────────────
      evtSource.addEventListener('vitals_update', (e) => {
        const data = JSON.parse(e.data) as { bpm: number; fingerPresent?: boolean };
        const now = new Date();
        setHardwareOnline(true);
        setVitals(prev => {
          const newReading = { time: now.toISOString(), value: data.bpm };
          const newHistory = [...prev.heartRateHistory, newReading];
          if (newHistory.length > 60) newHistory.shift(); // keep last 60 points
          return {
            ...prev,
            heartRate: data.bpm > 0 ? data.bpm : '--',
            fingerPresent: data.fingerPresent ?? false,
            heartRateHistory: newHistory,
            lastUpdated: now.toLocaleTimeString('en-US', { hour12: false }),
          };
        });
      });

      evtSource.addEventListener('bracelet_heartbeat', (e) => {
        const data = JSON.parse(e.data) as { online: boolean; bpm?: number; fingerPresent?: boolean };
        setVitals(prev => ({
          ...prev,
          heartRate: data.online ? (data.bpm && data.bpm > 0 ? data.bpm : prev.heartRate) : '--',
          fingerPresent: data.online ? (data.fingerPresent ?? false) : false,
        }));
      });

      evtSource.addEventListener('bracelet_offline', () => {
        setVitals(prev => ({
          ...prev,
          heartRate: '--',
          fingerPresent: false,
        }));
      });



      // ── Medicine reminder from server cron ──────────────────────────────────
      evtSource.addEventListener('medicine_reminder', (e) => {
        const data = JSON.parse(e.data) as { medicine: string; dosage: string; time: string; message: string };
        setMedicineReminder(data);
        // Auto-dismiss after 30 seconds
        setTimeout(() => setMedicineReminder(null), 30_000);
      });

      // medicines_extracted: update slots when scan extracts new medicines
      evtSource.addEventListener('medicines_extracted', (e) => {
        const data = JSON.parse(e.data) as { medicines: Array<{ name: string; dosage: string; times: string[] }> };
        if (!Array.isArray(data.medicines)) return;
        setMedicineSlots(prev => {
          const updated = [...prev];
          data.medicines.forEach((m, i) => {
            const slotIdx = updated.findIndex(s => s.medicineName.toLowerCase() === m.name.toLowerCase());
            const newSlot = {
              id: `scanned-${i}-${Date.now()}`,
              slotNumber: slotIdx >= 0 ? updated[slotIdx].slotNumber : updated.length + i + 1,
              medicineName: m.name,
              dosage: m.dosage || '',
              scheduledTime: m.times?.[0] || '08:00',
              taken: false,
              presenceConfirmed: false,
              touchVerified: false,
              notes: 'From prescription scan',
            };
            if (slotIdx >= 0) { updated[slotIdx] = newSlot; }
            else if (updated.length < 6) { updated.push(newSlot); }
          });
          return updated;
        });
      });



    } catch { /* SSE not available in some envs */ }

    return () => evtSource?.close();
  }, []);

  // ── Fall event handlers ──────────────────────────────────────────────────────
  const handleIncomingFall = useCallback((params: { source: FallEvent['source']; confidence: number; location: string }) => {
    setFallEvents(prev => {
      const now = new Date();
      let type: FallEvent['type'] = 'Stumble Warning';
      if (params.confidence >= 0.85) type = 'Critical Fall';
      else if (params.confidence >= 0.65) type = 'Rapid Descent';

      const event: FallEvent = {
        id: `fall-${Date.now()}`,
        isoTimestamp: now.toISOString(),
        timestamp: now.toLocaleTimeString('en-US', { hour12: false }) + ' — ' +
          now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        type,
        source: params.source,
        location: params.location,
        confidence: params.confidence,
        status: 'active',
      };
      return [event, ...prev];
    });
    setActiveAlert(true);
  }, []);

  const handleResolveFall = useCallback(async (id: string) => {
    setFallEvents(prev => prev.map(f => f.id === id ? {
      ...f,
      status: 'resolved' as const,
      resolvedAt: new Date().toLocaleTimeString('en-US', { hour12: false }),
    } : f));
    try {
      await fetch(`/api/fall-event/${id}/resolve`, { method: 'PATCH' });
    } catch { /* ignore network error */ }
  }, []);

  const handleClearFalls = useCallback(() => {
    setFallEvents(prev => prev.filter(f => f.status === 'active'));
  }, []);

  // ── Medicine handlers ────────────────────────────────────────────────────────
  const handleMarkTaken = useCallback(async (id: string) => {
    setMedicineSlots(prev => prev.map(s => s.id === id ? {
      ...s,
      taken: true,
      takenAt: new Date().toLocaleTimeString('en-US', { hour12: false }),
      touchVerified: true,
      presenceConfirmed: true,
    } : s));
    try {
      await fetch('/api/medicine-taken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId: id, lidOpen: true, touchVerified: true }),
      });
    } catch { /* offline */ }
  }, []);

  const handleMarkMissed = useCallback((id: string) => {
    setMedicineSlots(prev => prev.map(s => s.id === id ? { ...s, missed: true } as any : s));
  }, []);

  const handleResetSlot = useCallback((id: string) => {
    setMedicineSlots(prev => prev.map(s => s.id === id ? {
      ...s, taken: false, takenAt: undefined, touchVerified: false, presenceConfirmed: false, missed: false,
    } as any : s));
  }, []);

  const handleUpdateSlots = useCallback(async (slots: MedicineSlot[]) => {
    setMedicineSlots(slots);
    try {
      await fetch('/api/medicine-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots }),
      });
    } catch { /* offline */ }
  }, []);

  // ── Scan result ──────────────────────────────────────────────────────────────
  const handleAddDocumentScan = useCallback((result: ScanResult) => {
    setScannedHistory(prev => [result, ...prev]);
  }, []);

  // ── SOS ──────────────────────────────────────────────────────────────────────
  const triggerSOSAlert = () => setActiveAlert(true);
  const cancelSOSAlert = () => {
    const hasActive = fallEvents.some(f => f.status === 'active');
    if (!hasActive) setActiveAlert(false);
  };

  // ── Clock formatting ─────────────────────────────────────────────────────────
  const formatTime = () => currentTime.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const formatDate = () => currentTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  // ── View router ──────────────────────────────────────────────────────────────
  const renderView = () => {
    switch (currentView) {
      case 'overview':
        return (
          <Overview
            scannedHistory={scannedHistory}
            onNavigate={setCurrentView}
            activeAlert={activeAlert}
            vitals={vitals}
          />
        );
      case 'live-vitals':
        return <LiveVitals vitals={vitals} hardwareOnline={hardwareOnline} espConnected={espConnected} />;
      case 'fall-alerts':
        return (
          <FallAlerts
            fallEvents={fallEvents}
            activeAlert={activeAlert}
            onResolveEvent={handleResolveFall}
            onClearAll={handleClearFalls}
          />
        );
      case 'medicine':
        return (
          <MedicineBox
            slots={medicineSlots}
            lidOpen={lidOpen}
            medboxStatus={medboxStatus}
            onMarkTaken={handleMarkTaken}
            onMarkMissed={handleMarkMissed}
            onResetSlot={handleResetSlot}
            onUpdateSlots={handleUpdateSlots}
          />
        );

      case 'report-scanner':
        return (
          <ReportScanner
            onAddScanResult={handleAddDocumentScan}
            scannedHistory={scannedHistory}
          />
        );
      case 'rx-review':
        return <RxReview />;

      case 'dose-history':
        return <DoseHistory />;

      default:
        return (
          <div className="p-8 text-center text-slate-400">
            View not found. Return to Overview.
          </div>
        );
    }
  };

  const activeFallCount = fallEvents.filter(f => f.status === 'active').length;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 font-body text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-300">

      {/* Sidebar */}
      <Sidebar
        currentView={currentView}
        onViewChange={setCurrentView}
        activeAlert={activeAlert}
        onTriggerSOS={triggerSOSAlert}
        fallCount={activeFallCount}
        pendingRxCount={pendingRxCount}
      />

      {/* Main stage */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">

        {/* Header */}
        <header className="h-20 border-b border-slate-800/80 bg-slate-900/50 backdrop-blur-xl flex items-center justify-between px-8 z-10 shrink-0">

          {/* Greeting & Patient */}
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="h-10 w-10 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center text-emerald-400">
                <User className="h-5 w-5" />
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 bg-emerald-500 rounded-full border-2 border-slate-900 pulse-emerald" />
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <h4 className="text-sm font-bold font-headline text-slate-100 leading-none">Arthur Pendelton</h4>
                <span className="text-[10px] text-slate-400 font-mono">Age 82</span>
              </div>
              <p className="text-[11px] text-slate-400 font-label mt-0.5">CARDIOLOGY · 360° AI MONITORING</p>
            </div>
          </div>

          {/* Active alert banner */}
          {activeAlert && (
            <div className="hidden lg:flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-red-500/15 border border-red-500/40 animate-pulse">
              <span className="h-2 w-2 bg-red-500 rounded-full pulse-red-dot" />
              <span className="text-xs font-bold text-red-400 font-label uppercase tracking-wider">
                {activeFallCount > 0 ? `${activeFallCount} FALL ALERT${activeFallCount > 1 ? 'S' : ''} ACTIVE` : 'SOS EMERGENCY ACTIVE'}
              </span>
            </div>
          )}

          {/* Clock + status */}
          <div className="flex items-center gap-6 text-right">
            <div className="font-mono text-sm tracking-tight text-slate-200">
              <div className="flex items-center gap-2 justify-end text-emerald-400 font-bold">
                <Clock className="h-4 w-4" />
                <span>{formatTime()}</span>
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5">{formatDate()}</p>
            </div>
            <div className="h-8 border-l border-slate-800" />
            <div className="flex items-center gap-2.5">
              <div className={`h-2.5 w-2.5 rounded-full ${hardwareOnline ? 'bg-emerald-400 pulse-emerald' : 'bg-slate-600'}`} />
              <div className="text-left font-label">
                <span className="text-[9px] text-slate-500 block leading-none tracking-wider">SYSTEM</span>
                <span className={`text-xs font-bold ${hardwareOnline ? 'text-emerald-400' : 'text-slate-400'}`}>
                  {hardwareOnline ? 'ONLINE' : 'SIMULATED'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Battery className="h-5 w-5 text-emerald-400 rotate-90" />
              <div className="text-left font-mono">
                <span className="text-[9px] text-slate-500 block leading-none">BRACELET</span>
                <span className="text-xs text-slate-300 font-bold">92%</span>
              </div>
            </div>
          </div>
        </header>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto bg-slate-950 p-8 custom-scrollbar">
          <div className="max-w-6xl mx-auto space-y-8 pb-12">
            {renderView()}
          </div>
        </main>

        {/* ESP32 Connection/Disconnection Toast */}
        {connectionToast && (
          <div className="fixed top-6 right-6 z-50 max-w-xs w-full" style={{ animation: 'slideIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
            <div className={`rounded-2xl p-4 shadow-2xl backdrop-blur-xl border ${
              connectionToast.type === 'connected'
                ? 'bg-emerald-500/10 border-emerald-500/40'
                : 'bg-rose-500/10 border-rose-500/40'
            }`}>
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-xl shrink-0 ${
                  connectionToast.type === 'connected'
                    ? 'bg-emerald-500/20 border border-emerald-500/30'
                    : 'bg-rose-500/20 border border-rose-500/30'
                }`}>
                  <span className="text-lg">{connectionToast.type === 'connected' ? '🟢' : '🔴'}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-bold uppercase tracking-wider font-mono ${
                    connectionToast.type === 'connected' ? 'text-emerald-300' : 'text-rose-300'
                  }`}>
                    {connectionToast.type === 'connected' ? 'ESP32 Connected' : 'ESP32 Disconnected'}
                  </p>
                  <p className="text-xs text-slate-300 mt-0.5">
                    {connectionToast.type === 'connected'
                      ? 'Vitals sensor is online and streaming data.'
                      : 'Sensor offline — readings paused until reconnected.'}
                  </p>
                </div>
                <button
                  onClick={() => setConnectionToast(null)}
                  className="text-slate-500 hover:text-white shrink-0 text-lg leading-none"
                >×</button>
              </div>
            </div>
          </div>
        )}

        {/* Medicine Reminder Toast Banner */}
        {medicineReminder && (
          <div className="fixed top-6 right-6 z-50 max-w-sm w-full animate-slideIn">
            <div className="bg-amber-500/10 border border-amber-500/40 rounded-2xl p-4 shadow-2xl backdrop-blur-xl">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-amber-500/20 border border-amber-500/30 shrink-0 animate-pulse">
                  <span className="text-lg">💊</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-amber-300 uppercase tracking-wider font-mono">Medicine Reminder</p>
                  <p className="text-sm font-bold text-white mt-0.5">
                    {medicineReminder.medicine}
                    {medicineReminder.dosage && <span className="text-amber-300 font-normal"> · {medicineReminder.dosage}</span>}
                  </p>
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">{medicineReminder.message}</p>
                  <p className="text-[10px] text-amber-500/70 font-mono mt-1">Scheduled: {medicineReminder.time}</p>
                </div>
                <button
                  onClick={() => setMedicineReminder(null)}
                  className="text-slate-500 hover:text-white shrink-0 text-lg leading-none mt-0.5"
                >×</button>
              </div>
            </div>
          </div>
        )}

        {/* Global floating SOS footer */}
        {activeAlert && (
          <div className="absolute bottom-6 left-6 right-6 bg-red-600 border border-red-400 p-4 rounded-xl shadow-2xl flex items-center justify-between text-white animate-pulse z-40 max-w-2xl mx-auto">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/10 rounded-lg animate-bounce">
                <ShieldAlert className="h-5 w-5 text-white" />
              </div>
              <div>
                <h4 className="text-sm font-bold uppercase font-mono">
                  {activeFallCount > 0 ? `FALL DETECTED — ${activeFallCount} ACTIVE ALERT${activeFallCount > 1 ? 'S' : ''}` : 'ACTIVE SOS EMERGENCY'}
                </h4>
                <p className="text-xs text-white/90 font-mono">
                  {activeFallCount > 0
                    ? 'Go to Fall Alerts view to review and resolve events.'
                    : 'EMT notification and caregiver dispatch initiated.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activeFallCount > 0 && (
                <button
                  onClick={() => setCurrentView('fall-alerts')}
                  className="px-3.5 py-1.5 bg-white/15 hover:bg-white/25 text-white font-bold text-[10px] rounded-lg border border-white/20 uppercase font-mono tracking-wider transition"
                >
                  View Alerts
                </button>
              )}
              <button
                onClick={cancelSOSAlert}
                className="p-1.5 bg-slate-950/80 hover:bg-slate-950 text-white rounded-lg border border-white/20 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

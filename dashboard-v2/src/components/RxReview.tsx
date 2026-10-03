import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, AlertTriangle, CheckCircle2, XCircle, Clock, Package,
  FileText, ChevronRight, Loader2, RefreshCw, Eye, EyeOff, ShieldCheck,
  Edit3, ArrowRight, Pill, Sparkles, Check,
} from 'lucide-react';
import { ExtractedMed, Prescription } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt12(hhmm: string): string {
  if (!hhmm || !hhmm.includes(':')) return '08:00 AM';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function relTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function getMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    case 'tif':
    case 'tiff': return 'image/tiff';
    case 'pdf': return 'application/pdf';
    default: return 'image/jpeg';
  }
}

// ─── Confidence badge ─────────────────────────────────────────────────────────
function ConfidenceBadge({ conf }: { conf: 'high' | 'low' }) {
  return conf === 'low' ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-amber-500/20 border border-amber-500/40 text-amber-300">
      <AlertTriangle className="h-2.5 w-2.5" /> VERIFY
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
      <CheckCircle2 className="h-2.5 w-2.5" /> HIGH
    </span>
  );
}

// ─── Drop zone ────────────────────────────────────────────────────────────────
function UploadDropZone({ onFile, uploading }: { onFile: (f: File) => void; uploading: boolean }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const isAccepted = file.type.startsWith('image/') ||
      file.type === 'application/pdf' ||
      /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|pdf)$/i.test(file.name);
    if (isAccepted) onFile(file);
  };

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      className={`relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-10 cursor-pointer transition-all duration-300 ${
        dragging ? 'border-amber-400/70 bg-amber-500/5 scale-[1.01]' : 'border-slate-700 hover:border-amber-500/50 bg-slate-900/40'
      } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.pdf"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
      {uploading ? (
        <>
          <Loader2 className="h-10 w-10 text-amber-400 animate-spin" />
          <div className="text-center">
            <p className="text-sm font-bold text-white">Processing prescription…</p>
            <p className="text-xs text-slate-400 mt-1">Reading document with AI</p>
          </div>
        </>
      ) : (
        <>
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
            <Upload className="h-8 w-8 text-amber-400" />
          </div>
          <div className="text-center">
            <p className="text-sm font-bold text-slate-100">Drop prescription here</p>
            <p className="text-xs text-slate-400 mt-1">or click to browse · JPG, JPEG, PNG, WebP, PDF, BMP</p>
          </div>
          <p className="text-[10px] text-slate-500 font-mono">
            Direct OCR Extraction · Private On-Device Processing
          </p>
        </>
      )}
    </div>
  );
}

// ─── Slot Color Accents ───────────────────────────────────────────────────────
const COMP_COLORS = [
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-indigo-500',
  'from-violet-500 to-purple-500',
  'from-amber-500 to-orange-500',
];
const COMP_TEXT = ['text-emerald-400', 'text-blue-400', 'text-violet-400', 'text-amber-400'];
const COMP_BG   = ['bg-emerald-500/10', 'bg-blue-500/10', 'bg-violet-500/10', 'bg-amber-500/10'];
const COMP_BORDER = ['border-emerald-500/40', 'border-blue-500/40', 'border-violet-500/40', 'border-amber-500/40'];

// ─── Past prescription history item ──────────────────────────────────────────
function PrescriptionHistoryItem({ rx }: { rx: Prescription }) {
  const [expanded, setExpanded] = useState(false);
  const statusColors: Record<string, string> = {
    pending_review: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    applied: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    rejected: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
      <button className="w-full flex items-center justify-between p-4 hover:bg-slate-800/30 transition text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center gap-3">
          <FileText className="h-4 w-4 text-slate-500 shrink-0" />
          <div>
            <p className="text-xs font-bold text-slate-200">
              {rx.fileName}
              {rx.prescriptionNumber && (
                <span className="ml-2 text-[10px] text-amber-400 font-mono font-normal">
                  (Rx #{rx.prescriptionNumber})
                </span>
              )}
            </p>
            <p className="text-[10px] text-slate-500 font-mono">{relTime(rx.uploadedAt)} · {rx.extractedMeds?.length ?? 0} medicines</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold font-mono border ${statusColors[rx.status] || ''}`}>
            {rx.status?.replace('_', ' ').toUpperCase()}
          </span>
          <ChevronRight className={`h-3.5 w-3.5 text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </button>
      {expanded && (rx.extractedMeds?.length ?? 0) > 0 && (
        <div className="border-t border-slate-800 p-4 space-y-2">
          {rx.extractedMeds.map((m, i) => (
            <div key={i} className="flex items-center gap-2 text-xs font-mono flex-wrap">
              <span className="text-slate-500">{i + 1}.</span>
              <span className="text-slate-200 font-bold">{m.name}</span>
              {m.dosage && <span className="text-slate-400">{m.dosage}</span>}
              <span className="text-slate-500">{fmt12(m.suggestedTime)}</span>
              <ConfidenceBadge conf={m.confidence} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function RxReview() {
  const [uploading, setUploading]     = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastUpload, setLastUpload]   = useState<{
    prescriptionId: string;
    extractedMeds: ExtractedMed[];
    ocrText?: string;
    prescriptionNumber?: string | null;
  } | null>(null);
  const [showRawOcr, setShowRawOcr]   = useState(false);
  const [rawOcrText, setRawOcrText]   = useState('');

  // Active schedule state from ESP32 / Server
  const [activeSchedule, setActiveSchedule] = useState<any[]>([]);
  const [prescriptions, setPrescriptions]   = useState<Prescription[]>([]);
  const [loadingSchedule, setLoadingSchedule] = useState(true);
  const [savingSlot, setSavingSlot]         = useState(false);
  const [actionMsg, setActionMsg]           = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ── Manual & Interactive Slot Allocation State ──
  const [selectedSlot, setSelectedSlot]     = useState<number>(0); // 0, 1, 2, 3
  const [medicineName, setMedicineName]     = useState<string>('');
  const [dosage, setDosage]                 = useState<string>('');
  const [scheduleTime, setScheduleTime]     = useState<string>('08:00');
  const [reloadConfirmed, setReloadConfirmed] = useState<boolean>(false);

  const showMsg = useCallback((type: 'success' | 'error', text: string) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 5000);
  }, []);

  // Fetch current live schedule & prescriptions
  const fetchSchedule = useCallback(async () => {
    setLoadingSchedule(true);
    try {
      const [sc, rx] = await Promise.all([
        fetch('/api/esp32/schedule'),
        fetch('/api/rx/prescriptions')
      ]);
      if (sc.ok) {
        const d = await sc.json();
        setActiveSchedule(d.schedule || []);
      }
      if (rx.ok) {
        const d = await rx.json();
        setPrescriptions(d.prescriptions || []);
      }
    } catch { /* offline */ }
    finally { setLoadingSchedule(false); }
  }, []);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  // When selectedSlot changes, prefill form with existing slot info if available
  useEffect(() => {
    const matched = activeSchedule.find(s => Number(s.compartment) === selectedSlot);
    if (matched && matched.label && matched.label !== '(empty)') {
      // Split label if formatted as "Name - Dosage"
      if (matched.label.includes(' - ')) {
        const parts = matched.label.split(' - ');
        setMedicineName(parts[0] || '');
        setDosage(parts[1] || '');
      } else {
        setMedicineName(matched.label);
        setDosage('');
      }
      const hh = String(matched.hour ?? 8).padStart(2, '0');
      const mm = String(matched.minute ?? 0).padStart(2, '0');
      setScheduleTime(`${hh}:${mm}`);
    }
    setReloadConfirmed(false);
  }, [selectedSlot, activeSchedule]);

  // Handle Prescription Upload
  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setLastUpload(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/rx/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileData: base64, mimeType: getMimeType(file), fileName: file.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.ocrText) setRawOcrText(data.ocrText);
        throw new Error(data.error || 'Upload failed');
      }

      setLastUpload(data);
      setRawOcrText(data.ocrText || '');

      // Automatically pre-fill the form with the first extracted medicine
      if (data.extractedMeds && data.extractedMeds.length > 0) {
        const firstMed = data.extractedMeds[0];
        setMedicineName(firstMed.name || '');
        setDosage(firstMed.dosage || '');
        if (firstMed.suggestedTime) {
          setScheduleTime(firstMed.suggestedTime);
        }
        showMsg('success', `✓ Extracted ${data.extractedMeds.length} medicines. Slot form populated.`);
      }

      fetchSchedule();
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [fetchSchedule, showMsg]);

  // Handle clicking an extracted medicine card on the left to populate the slot form
  const handleSelectExtractedMed = (med: ExtractedMed) => {
    setMedicineName(med.name || '');
    setDosage(med.dosage || '');
    if (med.suggestedTime) {
      setScheduleTime(med.suggestedTime);
    }
    setReloadConfirmed(false);
    showMsg('success', `Populated form with "${med.name}". Choose slot & click Set Reminder.`);
  };

  // Submit Slot Schedule to ESP32
  const handleSaveSlot = async () => {
    if (!medicineName.trim()) {
      showMsg('error', 'Please enter a medicine name.');
      return;
    }
    if (!reloadConfirmed) {
      showMsg('error', 'Please check the physical reload confirmation checkbox.');
      return;
    }

    setSavingSlot(true);
    const combinedLabel = dosage.trim() ? `${medicineName.trim()} - ${dosage.trim()}` : medicineName.trim();
    const changeId = `slot-${selectedSlot}-${Date.now()}`;

    try {
      const res = await fetch(`/api/rx/confirm/${changeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reloadConfirmed: true,
          compartment: selectedSlot,
          customTime: scheduleTime,
          proposedLabel: combinedLabel,
          currentLabel: activeSchedule.find(s => Number(s.compartment) === selectedSlot)?.label || '(empty)',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to sync with ESP32');

      showMsg('success', `✅ Slot ${selectedSlot + 1} configured! Lid opened & LED glowing on MedBox.`);
      setReloadConfirmed(false);
      fetchSchedule();
    } catch (err: any) {
      showMsg('error', `❌ ${err.message}`);
    } finally {
      setSavingSlot(false);
    }
  };

  const currentSlotEntry = activeSchedule.find(s => Number(s.compartment) === selectedSlot);
  const c = selectedSlot % 4;

  return (
    <div className="flex flex-col gap-6 relative">
      <div className="orb-emerald -top-40 -right-40 opacity-30" />

      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-100 tracking-tight flex items-center gap-3">
            <Upload className="h-6 w-6 text-amber-400" /> Rx Scan &amp; Review
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Upload a prescription photo · AI extracts medicines · select slot (1–4), customize time &amp; set reminder
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchSchedule}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl glass-card hover:border-amber-500/30 text-xs text-slate-400 hover:text-amber-400 transition-all"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </header>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-mono ${
          actionMsg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'
        }`}>{actionMsg.text}</div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* LEFT COLUMN: Upload Prescription + Extracted Medicines */}
        <div className="space-y-5">
          <div className="glass-card rounded-2xl p-5 space-y-4">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono flex items-center gap-2">
              <Upload className="h-3.5 w-3.5" /> Upload Prescription
            </h2>
            <UploadDropZone onFile={handleFile} uploading={uploading} />
            <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
              <span>Supported formats:</span>
              <span className="text-amber-400/90 font-semibold">JPG · JPEG · PNG · WebP · PDF · BMP</span>
            </div>
            {uploadError && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-red-300">Extraction failed</p>
                  <p className="text-[11px] text-red-400 mt-0.5">{uploadError}</p>
                </div>
              </div>
            )}
          </div>

          {lastUpload && lastUpload.extractedMeds && lastUpload.extractedMeds.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" /> Extracted Medicines ({lastUpload.extractedMeds.length})
                </h2>
                {rawOcrText && (
                  <button onClick={() => setShowRawOcr(v => !v)} className="flex items-center gap-1 text-[10px] font-mono text-slate-500 hover:text-slate-300 transition">
                    {showRawOcr ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {showRawOcr ? 'Hide' : 'Show'} raw text
                  </button>
                )}
              </div>
              {showRawOcr && (
                <pre className="text-[10px] font-mono text-slate-500 bg-slate-900 border border-slate-800 rounded-xl p-3 overflow-auto max-h-32 whitespace-pre-wrap">
                  {rawOcrText}
                </pre>
              )}
              <div className="space-y-3">
                {lastUpload.extractedMeds.map((med, i) => (
                  <div
                    key={i}
                    onClick={() => handleSelectExtractedMed(med)}
                    className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 hover:border-amber-500/40 hover:bg-slate-900 transition-all cursor-pointer group flex items-center justify-between gap-3"
                  >
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white group-hover:text-amber-300 transition">{med.name}</span>
                        {med.dosage && <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">{med.dosage}</span>}
                        <ConfidenceBadge conf={med.confidence} />
                      </div>
                      <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
                        {med.frequency && <span>{med.frequency}</span>}
                        <span className="flex items-center gap-1 text-slate-400">
                          <Clock className="h-3 w-3 text-amber-400" /> {fmt12(med.suggestedTime)}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs font-mono font-bold group-hover:bg-amber-500 group-hover:text-slate-950 transition flex items-center gap-1 shrink-0"
                    >
                      Use in Slot <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Prescription History */}
          {prescriptions.length > 0 && (
            <div className="space-y-3 pt-2">
              <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest font-mono flex items-center gap-2 px-1">
                <FileText className="h-3.5 w-3.5" /> Prescription History ({prescriptions.length})
              </h2>
              <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar pr-1">
                {prescriptions.map(rx => <PrescriptionHistoryItem key={rx.id} rx={rx} />)}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Interactive Medicine Slot & Time Configuration Form */}
        <div className="space-y-5">
          <div className={`glass-card rounded-2xl p-5 space-y-5 border transition-all ${COMP_BORDER[c]}`}>

            {/* Header & Selected Slot Indicator */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl ${COMP_BG[c]} shrink-0`}>
                  <Package className={`h-5 w-5 ${COMP_TEXT[c]}`} />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-white font-headline">
                    Slot {selectedSlot + 1} Configuration
                  </h2>
                  <p className="text-[11px] font-mono text-slate-400">
                    Set medicine details, dosage, and dose time
                  </p>
                </div>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-mono font-bold border ${COMP_BG[c]} ${COMP_TEXT[c]} ${COMP_BORDER[c]}`}>
                SLOT {selectedSlot + 1}
              </span>
            </div>

            {/* 1. Choose Box Slot (1 - 4) */}
            <div className="space-y-2">
              <label className="text-[10px] font-mono text-slate-400 uppercase tracking-widest flex items-center justify-between">
                <span>Select Target Compartment (1 – 4):</span>
                <span className="text-amber-400/80 font-bold font-mono">
                  Currently: {currentSlotEntry?.label ? currentSlotEntry.label : '(Empty)'}
                </span>
              </label>
              <div className="grid grid-cols-4 gap-2">
                {[0, 1, 2, 3].map((slotIdx) => {
                  const isActive = selectedSlot === slotIdx;
                  const slotData = activeSchedule.find(s => Number(s.compartment) === slotIdx);
                  const hasMed = slotData && slotData.label && slotData.label !== '(empty)';
                  return (
                    <button
                      key={slotIdx}
                      type="button"
                      onClick={() => setSelectedSlot(slotIdx)}
                      className={`p-2.5 rounded-xl border text-center transition-all ${
                        isActive
                          ? 'bg-amber-500/15 border-amber-400 text-amber-300 shadow-md shadow-amber-500/10 scale-[1.02]'
                          : 'bg-slate-850/80 border-slate-800 hover:border-slate-700 text-slate-400'
                      }`}
                    >
                      <div className="text-xs font-mono font-bold">Slot {slotIdx + 1}</div>
                      <div className="text-[9px] font-mono truncate mt-0.5 text-slate-500">
                        {hasMed ? slotData.label.split(' - ')[0] : 'Empty'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Medicine Name & Dosage Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <label className="text-[10px] font-mono text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                  <Pill className="h-3 w-3 text-amber-400" /> Medicine Name:
                </label>
                <input
                  type="text"
                  value={medicineName}
                  onChange={(e) => setMedicineName(e.target.value)}
                  placeholder="e.g. Amoxicillin, Metformin, Paracetamol"
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono text-xs focus:border-amber-400 focus:outline-none placeholder:text-slate-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">
                  Dosage:
                </label>
                <input
                  type="text"
                  value={dosage}
                  onChange={(e) => setDosage(e.target.value)}
                  placeholder="e.g. 500mg, 1 tab"
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono text-xs focus:border-amber-400 focus:outline-none placeholder:text-slate-600"
                />
              </div>
            </div>

            {/* 3. Dose Schedule Time */}
            <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-mono text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-amber-400" /> Dose Schedule Time:
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const d = new Date(Date.now() + 1 * 60 * 1000);
                    const hh = String(d.getHours()).padStart(2, '0');
                    const mm = String(d.getMinutes()).padStart(2, '0');
                    setScheduleTime(`${hh}:${mm}`);
                  }}
                  className="text-[10px] font-mono text-amber-400 hover:text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-lg transition"
                >
                  +1 min from now (Test)
                </button>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="px-3.5 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono text-sm focus:border-amber-400 focus:outline-none"
                />
                <span className="text-xs text-amber-300 font-mono font-bold">
                  Alarm set for {fmt12(scheduleTime)}
                </span>
              </div>
            </div>

            {/* 4. Physical Reload Confirmation Checkbox */}
            <div className="space-y-3">
              <label className={`flex items-start gap-3 p-3.5 rounded-xl cursor-pointer transition-all ${
                reloadConfirmed ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-slate-850/60 border border-slate-700'
              }`}>
                <input
                  type="checkbox"
                  checked={reloadConfirmed}
                  onChange={e => setReloadConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-emerald-500 cursor-pointer shrink-0"
                />
                <span className="text-xs text-slate-200 leading-relaxed">
                  <strong className="text-white">I have physically placed</strong>{' '}
                  <span className="text-amber-300 font-mono font-bold">
                    {medicineName.trim() ? `${medicineName.trim()} ${dosage.trim()}` : `Medicine`}
                  </span>{' '}
                  into <strong className="text-white font-mono">Slot {selectedSlot + 1}</strong>. The slot is loaded and ready to dispense.
                </span>
              </label>

              {!reloadConfirmed && (
                <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3 text-slate-600" />
                  Check the reload confirmation box above to enable Set Reminder.
                </p>
              )}
            </div>

            {/* 5. Set Reminder Action Button */}
            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={handleSaveSlot}
                disabled={!reloadConfirmed || savingSlot || !medicineName.trim()}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-bold font-mono transition-all ${
                  reloadConfirmed && medicineName.trim() && !savingSlot
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20 active:scale-95 cursor-pointer'
                    : 'bg-slate-800 text-slate-600 cursor-not-allowed border border-slate-700'
                }`}
              >
                {savingSlot ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Set Reminder for Slot {selectedSlot + 1}
              </button>

              <button
                type="button"
                onClick={() => {
                  setMedicineName('');
                  setDosage('');
                  setReloadConfirmed(false);
                }}
                className="px-4 py-3 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-800 text-xs font-mono text-slate-400 hover:text-white transition"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Active 4-Slot Status Overview */}
          <div className="glass-card rounded-2xl p-5 space-y-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono flex items-center gap-2">
              <Package className="h-3.5 w-3.5" /> All 4 Box Compartments
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {[0, 1, 2, 3].map((slotIdx) => {
                const item = activeSchedule.find(s => Number(s.compartment) === slotIdx);
                const isSelected = selectedSlot === slotIdx;
                const hasItem = item && item.label && item.label !== '(empty)';
                return (
                  <div
                    key={slotIdx}
                    onClick={() => setSelectedSlot(slotIdx)}
                    className={`p-3 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-amber-500 bg-amber-500/10'
                        : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="font-bold text-slate-300">Slot {slotIdx + 1}</span>
                      <span className={`text-[10px] ${hasItem ? 'text-emerald-400' : 'text-slate-600'}`}>
                        {hasItem ? fmt12(`${String(item.hour).padStart(2, '0')}:${String(item.minute).padStart(2, '0')}`) : 'Empty'}
                      </span>
                    </div>
                    <p className="text-xs font-bold text-white truncate mt-1">
                      {hasItem ? item.label : '(empty)'}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}

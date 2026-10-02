import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, AlertTriangle, CheckCircle2, XCircle, Clock, Package,
  FileText, ChevronRight, Loader2, RefreshCw, Eye, EyeOff, ShieldCheck,
} from 'lucide-react';
import { PendingChange, ExtractedMed, Prescription } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function fmtHM(hour: number, minute: number) {
  return fmt12(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
}
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
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
            <p className="text-xs text-slate-400 mt-1">Reading document with local AI</p>
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
            Direct on-device OCR · No hardcoded drugs · 100% private
          </p>
        </>
      )}
    </div>
  );
}

// ─── Extracted medicine card ──────────────────────────────────────────────────
const COMP_COLORS = [
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-indigo-500',
  'from-violet-500 to-purple-500',
  'from-amber-500 to-orange-500',
];

function ExtractedMedCard({ med, index }: { med: ExtractedMed; index: number }) {
  const grad = COMP_COLORS[index % 4];
  return (
    <div className={`rounded-xl border overflow-hidden ${med.confidence === 'low' ? 'bg-amber-950/20 border-amber-500/30' : 'bg-slate-900/50 border-slate-800'}`}>
      <div className={`h-1 w-full bg-gradient-to-r ${grad}`} />
      <div className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className={`h-7 w-7 rounded-lg bg-gradient-to-br ${grad} flex items-center justify-center text-white font-bold text-sm shrink-0`}>{index + 1}</div>
            <div>
              <p className="text-sm font-bold text-white leading-tight">{med.name}</p>
              {med.dosage && <p className="text-[11px] text-slate-400 font-mono">{med.dosage}</p>}
            </div>
          </div>
          <ConfidenceBadge conf={med.confidence} />
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] font-mono">
          {med.frequency && <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{med.frequency}</span>}
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">
            <Clock className="h-2.5 w-2.5" /> {fmt12(med.suggestedTime)}
          </span>
        </div>
        {med.confidence === 'low' && (
          <div className="flex items-start gap-1.5 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-[10px] text-amber-300 leading-relaxed">Low confidence — verify name, dosage and time before confirming.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Pending change row ───────────────────────────────────────────────────────
const COMP_TEXT = ['text-emerald-400', 'text-blue-400', 'text-violet-400', 'text-amber-400'];
const COMP_BG   = ['bg-emerald-500/10', 'bg-blue-500/10', 'bg-violet-500/10', 'bg-amber-500/10'];

function PendingChangeRow({
  change, onConfirm, onReject, confirming, activeSchedule,
}: {
  change: PendingChange;
  onConfirm: (id: string, reloaded: boolean, compartment: number, customTime?: string) => void;
  onReject: (id: string) => void;
  confirming: boolean;
  activeSchedule: any[];
}) {
  const [selectedSlot, setSelectedSlot] = useState<number>(change.compartment);
  const initialTime = `${String(change.proposedHour).padStart(2, '0')}:${String(change.proposedMinute).padStart(2, '0')}`;
  const [customTime, setCustomTime] = useState<string>(initialTime);
  const [reloadChecked, setReloadChecked] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const hasLow = change.extractedMed?.confidence === 'low';
  const c = selectedSlot % 4;

  const matchedSlot = activeSchedule.find(s => s.compartment === selectedSlot);
  const currentLabelForSelectedSlot = matchedSlot ? matchedSlot.label : "(empty)";

  if (change.status === 'confirmed') {
    return (
      <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/20">
        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
        <span className="text-xs text-emerald-300 font-mono flex-1">Slot {selectedSlot + 1} confirmed — <strong>{change.proposedLabel}</strong></span>
        {change.confirmedAt && <span className="text-[10px] text-slate-500 font-mono">{relTime(change.confirmedAt)}</span>}
      </div>
    );
  }
  if (change.status === 'rejected') {
    return (
      <div className="flex items-center gap-3 p-4 rounded-xl bg-red-950/20 border border-red-500/20">
        <XCircle className="h-4 w-4 text-red-400 shrink-0" />
        <span className="text-xs text-red-300 font-mono">Slot {selectedSlot + 1} rejected — no change applied</span>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border overflow-hidden ${hasLow ? 'border-amber-500/40 bg-amber-950/10' : 'border-slate-700 bg-slate-900/50'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-slate-800">
        <div className={`p-2 rounded-xl ${COMP_BG[c]} shrink-0`}>
          <Package className={`h-4 w-4 ${COMP_TEXT[c]}`} />
        </div>
        <div className="flex-1">
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Proposed Box Slot {selectedSlot + 1}</p>
          {hasLow && <p className="text-[10px] text-amber-300 font-mono flex items-center gap-1 mt-0.5"><AlertTriangle className="h-2.5 w-2.5" /> Low-confidence — verify manually</p>}
        </div>
        {hasLow && <ConfidenceBadge conf="low" />}
      </div>
      {/* Diff */}
      <div className="grid grid-cols-2 divide-x divide-slate-800">
        <div className="p-4 space-y-1">
          <p className="text-[9px] font-mono text-slate-600 uppercase tracking-widest">Currently in Slot {selectedSlot + 1}</p>
          <p className="text-sm text-slate-500 line-through decoration-slate-600">{currentLabelForSelectedSlot}</p>
        </div>
        <div className="p-4 space-y-1">
          <p className="text-[9px] font-mono text-amber-500/70 uppercase tracking-widest">Proposed change</p>
          <p className={`text-sm font-bold ${hasLow ? 'text-amber-200' : 'text-white'}`}>{change.proposedLabel}</p>
          <p className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
            <Clock className="h-2.5 w-2.5 text-amber-400" /> {fmt12(customTime)}
          </p>
        </div>
      </div>

      {/* Custom Dose Time Input */}
      <div className="p-4 border-t border-slate-800 space-y-2 bg-slate-950/40">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-mono text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-amber-400" /> Dose Schedule Time (Custom Input):
          </label>
          <button
            type="button"
            onClick={() => {
              const d = new Date(Date.now() + 1 * 60 * 1000);
              const hh = String(d.getHours()).padStart(2, '0');
              const mm = String(d.getMinutes()).padStart(2, '0');
              setCustomTime(`${hh}:${mm}`);
            }}
            className="text-[10px] font-mono text-amber-400 hover:text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-lg transition"
          >
            +1 min from now (Test)
          </button>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="time"
            value={customTime}
            onChange={(e) => setCustomTime(e.target.value)}
            className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono text-sm focus:border-amber-400 focus:outline-none"
          />
          <span className="text-xs text-slate-300 font-mono font-bold">
            Set for {fmt12(customTime)}
          </span>
        </div>
      </div>

      {/* Slot Selection Grid */}
      <div className="p-4 border-t border-slate-800 space-y-1.5 bg-slate-950/20">
        <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Choose Box Slot (1 - 4) to Allocate:</p>
        <div className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((slotIndex) => {
            const isActive = selectedSlot === slotIndex;
            return (
              <button
                key={slotIndex}
                type="button"
                onClick={() => {
                  setSelectedSlot(slotIndex);
                  setReloadChecked(false); // reset reload check when slot changes
                }}
                className={`py-2 px-3 rounded-xl border text-xs font-mono font-bold transition-all ${
                  isActive
                    ? 'bg-amber-500/10 border-amber-500 text-amber-300 shadow shadow-amber-500/10 scale-[1.02]'
                    : 'bg-slate-850 border-slate-800 hover:border-slate-700 text-slate-500 hover:text-slate-400'
                }`}
              >
                Slot {slotIndex + 1}
              </button>
            );
          })}
        </div>
      </div>
      {/* Reload confirmation + actions */}
      <div className="p-4 border-t border-slate-800 space-y-3">
        <label className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-all ${reloadChecked ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-slate-800/60 border border-slate-700'}`}>
          <input type="checkbox" checked={reloadChecked} onChange={e => setReloadChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-emerald-500 cursor-pointer shrink-0" />
          <span className="text-xs text-slate-200 leading-relaxed">
            <strong className="text-white">I have physically reloaded Slot {selectedSlot + 1}</strong>{' '}
            with <span className="text-amber-300 font-mono">{change.proposedLabel}</span>. The slot is ready to dispense.
          </span>
        </label>
        {!reloadChecked && (
          <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1">
            <ShieldCheck className="h-3 w-3 text-slate-600" />
            Confirm is disabled until the reload checkbox above is checked.
          </p>
        )}
        <div className="flex gap-2">
          <button onClick={() => onConfirm(change.id, reloadChecked, selectedSlot, customTime)} disabled={!reloadChecked || confirming}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold font-mono transition-all ${
              reloadChecked && !confirming
                ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20 active:scale-95'
                : 'bg-slate-800 text-slate-600 cursor-not-allowed border border-slate-700'
            }`}>
            {confirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Set Reminder
          </button>
          <button onClick={() => { setRejecting(true); onReject(change.id); }} disabled={rejecting}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-mono text-red-400 hover:text-red-300 bg-red-500/5 hover:bg-red-500/10 border border-red-500/20 transition-all active:scale-95">
            {rejecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

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
            <p className="text-xs font-bold text-slate-200">{rx.fileName}</p>
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

// ─── Main component ───────────────────────────────────────────────────────────
export default function RxReview() {
  const [uploading, setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<{
    prescriptionId: string;
    extractedMeds: ExtractedMed[];
    pendingChanges: any[];
    ocrText?: string;
  } | null>(null);
  const [showRawOcr, setShowRawOcr] = useState(false);
  const [rawOcrText, setRawOcrText] = useState('');

  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [prescriptions, setPrescriptions]   = useState<Prescription[]>([]);
  const [activeSchedule, setActiveSchedule] = useState<any[]>([]);
  const [loadingPending, setLoadingPending] = useState(true);
  const [confirmingId, setConfirmingId]     = useState<string | null>(null);
  const [actionMsg, setActionMsg]           = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showMsg = (type: 'success' | 'error', text: string) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 5000);
  };

  const fetchPending = useCallback(async () => {
    setLoadingPending(true);
    try {
      const [pr, rx, sc] = await Promise.all([
        fetch('/api/rx/pending'),
        fetch('/api/rx/prescriptions'),
        fetch('/api/esp32/schedule')
      ]);
      if (pr.ok) { const d = await pr.json(); setPendingChanges(d.pending || []); }
      if (rx.ok) { const d = await rx.json(); setPrescriptions(d.prescriptions || []); }
      if (sc.ok) { const d = await sc.json(); setActiveSchedule(d.schedule || []); }
    } catch { /* offline */ }
    finally { setLoadingPending(false); }
  }, []);

  useEffect(() => { fetchPending(); }, [fetchPending]);

  // SSE
  useEffect(() => {
    let src: EventSource | null = null;
    try {
      src = new EventSource('/api/events-stream');
      src.addEventListener('rx_confirmed', (e) => {
        const { changeId } = JSON.parse(e.data);
        setPendingChanges(prev => prev.map(c => c.id === changeId ? { ...c, status: 'confirmed' as const } : c));
      });
      src.addEventListener('rx_rejected', (e) => {
        const { changeId } = JSON.parse(e.data);
        setPendingChanges(prev => prev.map(c => c.id === changeId ? { ...c, status: 'rejected' as const } : c));
      });
      src.addEventListener('rx_upload_done', () => { fetchPending(); });
    } catch {}
    return () => src?.close();
  }, [fetchPending]);

  const handleFile = useCallback(async (file: File) => {
    setUploading(true); setUploadError(null); setLastUpload(null);
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
      if (!res.ok) { if (data.ocrText) setRawOcrText(data.ocrText); throw new Error(data.error || 'Upload failed'); }
      setLastUpload(data);
      setRawOcrText(data.ocrText || '');
      setPendingChanges(prev => {
        const ids = new Set(prev.map(c => c.id));
        return [...(data.pendingChanges || []).filter((c: any) => !ids.has(c.id)), ...prev];
      });
      fetchPending();
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally { setUploading(false); }
  }, [fetchPending]);

  const handleConfirm = useCallback(async (changeId: string, reloadConfirmed: boolean, compartment: number, customTime?: string) => {
    if (!reloadConfirmed) return;
    setConfirmingId(changeId);
    try {
      const res = await fetch(`/api/rx/confirm/${changeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reloadConfirmed: true, compartment, customTime }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Confirm failed');
      setPendingChanges(prev => prev.map(c => c.id === changeId ? { ...c, status: 'confirmed' as const, confirmedAt: new Date().toISOString() } : c));
      showMsg('success', '✅ Schedule pushed to ESP32 successfully');
      fetchPending();
    } catch (err: any) {
      showMsg('error', `❌ ${err.message}`);
    } finally { setConfirmingId(null); }
  }, [fetchPending]);

  const handleReject = useCallback(async (changeId: string) => {
    try {
      await fetch(`/api/rx/reject/${changeId}`, { method: 'POST' });
      setPendingChanges(prev => prev.map(c => c.id === changeId ? { ...c, status: 'rejected' as const } : c));
      showMsg('success', 'Change rejected — ESP32 schedule unchanged');
    } catch { showMsg('error', 'Reject failed — try again'); }
  }, []);

  const pendingCount = pendingChanges.filter(c => c.status === 'pending').length;
  const lowConfCount = lastUpload?.extractedMeds.filter(m => m.confidence === 'low').length ?? 0;

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
            Upload a prescription photo · AI extracts medicines · you confirm before anything reaches the box
          </p>
        </div>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs font-bold text-amber-300 font-mono animate-pulse">
              <AlertTriangle className="h-3.5 w-3.5" /> {pendingCount} pending review
            </div>
          )}
          <button onClick={fetchPending} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl glass-card hover:border-amber-500/30 text-xs text-slate-400 hover:text-amber-400 transition-all">
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

        {/* LEFT: Upload + Extraction */}
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

          {lowConfCount > 0 && (
            <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-amber-300">Verify {lowConfCount} low-confidence reading{lowConfCount > 1 ? 's' : ''}</p>
                <p className="text-xs text-amber-400/80 mt-1">
                  Medicines highlighted in amber could not be read with high confidence. Check the original prescription before confirming.
                </p>
              </div>
            </div>
          )}

          {lastUpload && lastUpload.extractedMeds.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">
                  Extracted Medicines ({lastUpload.extractedMeds.length})
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {lastUpload.extractedMeds.map((med, i) => <ExtractedMedCard key={i} med={med} index={i} />)}
              </div>
            </div>
          )}

          {lastUpload && lastUpload.extractedMeds.length === 0 && (
            <div className="text-center py-8 rounded-2xl border border-dashed border-slate-800 text-slate-500">
              <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-mono">No medicines could be extracted.</p>
              <p className="text-xs mt-1">Try a clearer photo with better lighting.</p>
            </div>
          )}
        </div>

        {/* RIGHT: Pending Changes + History */}
        <div className="space-y-5">
          <div className="glass-card rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono flex items-center gap-2">
                <Package className="h-3.5 w-3.5" /> Proposed Schedule Changes
              </h2>
              {pendingCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-amber-500/20 border border-amber-500/30 text-amber-300">
                  {pendingCount} pending
                </span>
              )}
            </div>

            {loadingPending ? (
              <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 text-slate-600 animate-spin" /></div>
            ) : pendingChanges.length === 0 ? (
              <div className="text-center py-8 rounded-xl border border-dashed border-slate-800 text-slate-500">
                <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
                <p className="text-sm font-mono">No pending changes</p>
                <p className="text-xs mt-1 text-slate-600">Upload a prescription to get started</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start gap-2 p-3 rounded-xl bg-slate-800/60 border border-slate-700">
                  <ShieldCheck className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    <span className="text-slate-200 font-bold">No change reaches the ESP32 automatically.</span>{' '}
                    For each compartment, check the reload box and click Confirm — only then is the schedule pushed to the device.
                  </p>
                </div>
                {pendingChanges.map(change => (
                  <PendingChangeRow key={change.id} change={change} onConfirm={handleConfirm} onReject={handleReject} confirming={confirmingId === change.id} activeSchedule={activeSchedule} />
                ))}
              </div>
            )}
          </div>

          {prescriptions.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest font-mono flex items-center gap-2 px-1">
                <FileText className="h-3.5 w-3.5" /> Prescription History ({prescriptions.length})
              </h2>
              <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                {prescriptions.map(rx => <PrescriptionHistoryItem key={rx.id} rx={rx} />)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

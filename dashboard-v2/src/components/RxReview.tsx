import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, AlertTriangle, CheckCircle2, XCircle, Clock, Package,
  FileText, ChevronRight, Loader2, RefreshCw, Eye, EyeOff, ShieldCheck,
  ArrowRight, Pill, Sparkles, Timer,
} from 'lucide-react';
import { ExtractedMed, Prescription } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────
// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt12(hhmm?: string | null): string {
  if (!hhmm || !hhmm.includes(':')) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (isNaN(h)) return '';
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
    <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-semibold bg-amber-50 border border-amber-300 text-amber-800">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> Verify
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 border border-emerald-300 text-emerald-700">
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> High
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
      className={`relative flex flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed p-8 cursor-pointer transition-all duration-300 ${
        dragging
          ? 'border-blue-500 bg-blue-50/50 scale-[1.01]'
          : 'border-slate-200 hover:border-blue-400 bg-slate-50/50 hover:bg-blue-50/20'
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
          <Loader2 className="h-10 w-10 text-blue-600 animate-spin" />
          <div className="text-center">
            <p className="text-base font-bold text-slate-800">Processing prescription…</p>
            <p className="text-xs text-slate-500 mt-1 font-medium">Reading document with AI vision model</p>
          </div>
        </>
      ) : (
        <>
          <div className="p-4 rounded-3xl bg-blue-50 border border-blue-100 text-blue-600 shadow-xs">
            <Upload className="h-8 w-8" />
          </div>
          <div className="text-center">
            <p className="text-base font-bold text-slate-800">Drop prescription photo or PDF here</p>
            <p className="text-xs text-slate-500 mt-1 font-medium">or click to browse from device (JPG, PNG, WebP, PDF)</p>
          </div>
          <p className="text-xs text-slate-400 font-medium">
            Local OCR Extraction · Zero Cloud Transmission
          </p>
        </>
      )}
    </div>
  );
}

// ─── Slot Color Accents ───────────────────────────────────────────────────────
const COMP_TEXT = ['text-emerald-700', 'text-blue-700', 'text-purple-700', 'text-amber-800'];
const COMP_BG   = ['bg-emerald-50', 'bg-blue-50', 'bg-purple-50', 'bg-amber-50'];
const COMP_BORDER = ['border-emerald-300', 'border-blue-300', 'border-purple-300', 'border-amber-300'];

// ─── Past prescription history item ──────────────────────────────────────────
function PrescriptionHistoryItem({ rx }: { rx: Prescription }) {
  const [expanded, setExpanded] = useState(false);
  const statusColors: Record<string, string> = {
    pending_review: 'bg-amber-50 text-amber-800 border-amber-300',
    applied: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    rejected: 'bg-rose-50 text-rose-700 border-rose-300',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
      <button className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition text-left cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2.5 rounded-xl bg-slate-100 text-slate-600 shrink-0">
            <FileText className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800 truncate">
              {rx.fileName}
              {rx.prescriptionNumber && (
                <span className="ml-2 text-xs text-blue-700 font-semibold">
                  (Rx #{rx.prescriptionNumber})
                </span>
              )}
            </p>
            <p className="text-xs text-slate-500 font-medium mt-0.5">{relTime(rx.uploadedAt)} · {rx.extractedMeds?.length ?? 0} medicines</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${statusColors[rx.status] || ''}`}>
            {rx.status?.replace('_', ' ').toUpperCase()}
          </span>
          <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </button>
      {expanded && (rx.extractedMeds?.length ?? 0) > 0 && (
        <div className="border-t border-slate-100 p-4 bg-slate-50/50 space-y-2.5">
          {rx.extractedMeds.map((m, i) => (
            <div key={i} className="flex items-center gap-2 text-xs flex-wrap bg-white p-3 rounded-xl border border-slate-200">
              <span className="text-slate-400 font-bold">{i + 1}.</span>
              <span className="text-slate-800 font-bold">{m.name}</span>
              {m.dosage && <span className="text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md font-medium">{m.dosage}</span>}
              {m.suggestedTime && <span className="text-slate-500">{fmt12(m.suggestedTime)}</span>}
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
  const [searchTerm, setSearchTerm]   = useState('');

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
  const [scheduleTime, setScheduleTime]     = useState<string>('');
  const [timeoutMinutes, setTimeoutMinutes] = useState<number>(5);
  const [reloadConfirmed, setReloadConfirmed] = useState<boolean>(false);

  const showMsg = useCallback((type: 'success' | 'error', text: string) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 6000);
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
      setTimeoutMinutes(Number(matched.timeoutMinutes) || 5);
    } else {
      setMedicineName('');
      setDosage('');
      setScheduleTime('');
      setTimeoutMinutes(5);
    }
    setReloadConfirmed(false);
  }, [selectedSlot, activeSchedule]);

  // Handle Prescription Upload
  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setLastUpload(null);
    setSearchTerm('');
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
        setScheduleTime(firstMed.suggestedTime || '');
        showMsg('success', `✓ Successfully extracted ${data.extractedMeds.length} medicines! Select any medicine below to configure its slot.`);
      }

      fetchSchedule();
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [fetchSchedule, showMsg]);

  // Assign a specific extracted medicine into a specific slot (or current selected slot)
  const handleAssignToSlot = (med: ExtractedMed, targetSlot?: number) => {
    const slotToUse = targetSlot !== undefined ? targetSlot : selectedSlot;
    setSelectedSlot(slotToUse);
    setMedicineName(med.name || '');
    setDosage(med.dosage || '');
    setScheduleTime(med.suggestedTime || '');
    setReloadConfirmed(false);
    showMsg('success', `Populated "${med.name}" into Slot ${slotToUse + 1}. Check physical reload box and click Set Reminder.`);
  };

  // Submit Slot Schedule to ESP32 / Server
  const handleSaveSlot = async () => {
    if (!medicineName.trim()) {
      showMsg('error', 'Please enter a medicine name.');
      return;
    }
    if (!scheduleTime.trim()) {
      showMsg('error', 'Please select or enter a dose alarm time.');
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
          timeoutMinutes: timeoutMinutes,
          proposedLabel: combinedLabel,
          currentLabel: activeSchedule.find(s => Number(s.compartment) === selectedSlot)?.label || '(empty)',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to sync with ESP32');

      showMsg('success', `✅ Slot ${selectedSlot + 1} updated to "${combinedLabel}" at ${fmt12(scheduleTime)} (Timeout: ${timeoutMinutes}m)!`);
      setReloadConfirmed(false);
      fetchSchedule();
    } catch (err: any) {
      showMsg('error', `❌ ${err.message}`);
    } finally {
      setSavingSlot(false);
    }
  };

  // Clear a slot
  const handleClearSlot = async (slotIdx: number) => {
    const changeId = `clear-${slotIdx}-${Date.now()}`;
    try {
      const res = await fetch(`/api/rx/confirm/${changeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reloadConfirmed: true,
          compartment: slotIdx,
          customTime: "08:00",
          proposedLabel: "(empty)",
          currentLabel: activeSchedule.find(s => Number(s.compartment) === slotIdx)?.label || '(empty)',
        }),
      });
      if (res.ok) {
        showMsg('success', `Cleared Slot ${slotIdx + 1}`);
        if (selectedSlot === slotIdx) {
          setMedicineName('');
          setDosage('');
          setScheduleTime('');
          setTimeoutMinutes(5);
          setReloadConfirmed(false);
        }
        fetchSchedule();
      }
    } catch (e: any) {
      showMsg('error', `Failed to clear slot: ${e.message}`);
    }
  };

  // Check if a medicine is currently in any slot
  const getAssignedSlots = (medName: string) => {
    if (!medName) return [];
    const cleanMed = medName.toLowerCase().trim();
    return activeSchedule
      .map((s, idx) => ({ ...s, slotIndex: idx }))
      .filter(s => s.label && s.label !== '(empty)' && s.label.toLowerCase().includes(cleanMed));
  };

  const currentSlotEntry = activeSchedule.find(s => Number(s.compartment) === selectedSlot);
  const c = selectedSlot % 4;

  // Filtered extracted medicines
  const filteredMeds = (lastUpload?.extractedMeds || []).filter(m => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase().trim();
    return m.name.toLowerCase().includes(term) || (m.dosage && m.dosage.toLowerCase().includes(term)) || (m.frequency && m.frequency.toLowerCase().includes(term));
  });

  return (
    <div className="flex flex-col gap-6 relative">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-800 tracking-tight flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
              <Upload className="h-6 w-6" />
            </div>
            Prescription Scanner &amp; Medication Review
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            Upload prescription document · AI extracts all medicines individually · assign to Slots 1–4 with custom dose alarms and timeout window
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchSchedule}
            className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-xs cursor-pointer"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </header>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-2xl border text-sm font-medium animate-in fade-in slide-in-from-top duration-300 ${
          actionMsg.type === 'success' ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-rose-50 border-rose-300 text-rose-800'
        }`}>{actionMsg.text}</div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* LEFT COLUMN: Upload Prescription + Extracted Medicines */}
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-4 shadow-xs">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <Upload className="h-4 w-4 text-blue-600" /> Upload Prescription Document
            </h2>
            <UploadDropZone onFile={handleFile} uploading={uploading} />
            <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
              <span>Supported formats:</span>
              <span className="text-blue-700 font-semibold">JPG · JPEG · PNG · WebP · PDF · BMP</span>
            </div>
            {uploadError && (
              <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-rose-50 border border-rose-200">
                <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-rose-800">Extraction failed</p>
                  <p className="text-xs text-rose-700 mt-0.5">{uploadError}</p>
                </div>
              </div>
            )}
          </div>

          {lastUpload && lastUpload.extractedMeds && lastUpload.extractedMeds.length > 0 && (
            <div className="space-y-3.5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-blue-600" /> Extracted Medicines ({lastUpload.extractedMeds.length})
                </h2>
                <div className="flex items-center gap-3">
                  {rawOcrText && (
                    <button onClick={() => setShowRawOcr(v => !v)} className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700 transition cursor-pointer">
                      {showRawOcr ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {showRawOcr ? 'Hide raw text' : 'Raw text'}
                    </button>
                  )}
                </div>
              </div>

              {/* Search & Filter bar for extracted medicines */}
              {lastUpload.extractedMeds.length > 3 && (
                <div className="relative">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    placeholder={`Filter among ${lastUpload.extractedMeds.length} medicines...`}
                    className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:border-blue-500 focus:outline-none transition"
                  />
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      className="absolute right-3 top-2.5 text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}

              {showRawOcr && (
                <pre className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-2xl p-4 overflow-auto max-h-36 whitespace-pre-wrap font-mono">
                  {rawOcrText}
                </pre>
              )}

              <div className="space-y-3 max-h-[540px] overflow-y-auto custom-scrollbar pr-1">
                {filteredMeds.map((med, i) => {
                  const assigned = getAssignedSlots(med.name);
                  const isAssigned = assigned.length > 0;

                  return (
                    <div
                      key={i}
                      className={`p-4 sm:p-5 rounded-2xl border transition-all ${
                        isAssigned
                          ? 'border-emerald-300 bg-emerald-50/20'
                          : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50/10'
                      } shadow-2xs`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold text-slate-400">{i + 1}.</span>
                            <span className="text-base font-bold text-slate-800">{med.name}</span>
                            {med.dosage && (
                              <span className="text-xs text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md font-bold">
                                {med.dosage}
                              </span>
                            )}
                            <ConfidenceBadge conf={med.confidence} />
                            {isAssigned && (
                              <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                                {assigned.map(a => `Slot ${a.slotIndex + 1}`).join(', ')}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-3 text-xs text-slate-500 font-medium flex-wrap">
                            {med.frequency && (
                              <span className="bg-slate-50 px-2 py-0.5 rounded border border-slate-100 text-slate-600">
                                {med.frequency}
                              </span>
                            )}
                            {med.suggestedTime && (
                              <span className="flex items-center gap-1 text-blue-700 font-semibold bg-blue-50/80 px-2 py-0.5 rounded border border-blue-100">
                                <Clock className="h-3 w-3 text-blue-600" /> Time: {fmt12(med.suggestedTime)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Quick Assign Buttons on Card */}
                      <div className="mt-3.5 pt-3 border-t border-slate-100 flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-semibold text-slate-400 mr-1">Assign to:</span>
                          {[0, 1, 2, 3].map((slotIdx) => (
                            <button
                              key={slotIdx}
                              type="button"
                              onClick={() => handleAssignToSlot(med, slotIdx)}
                              className={`px-2.5 py-1 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                                selectedSlot === slotIdx
                                  ? 'bg-blue-600 text-white border-blue-600 shadow-2xs'
                                  : 'bg-slate-50 hover:bg-blue-50 text-slate-700 hover:text-blue-700 border-slate-200'
                              }`}
                            >
                              Slot {slotIdx + 1}
                            </button>
                          ))}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleAssignToSlot(med, selectedSlot)}
                          className="px-3 py-1.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white hover:border-blue-600 text-xs font-bold transition flex items-center gap-1 shrink-0 cursor-pointer"
                        >
                          Use in Slot {selectedSlot + 1} <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Prescription History */}
          {prescriptions.length > 0 && (
            <div className="space-y-3 pt-2">
              <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2 px-1">
                <FileText className="h-4 w-4 text-slate-500" /> Prescription History ({prescriptions.length})
              </h2>
              <div className="space-y-2.5 max-h-64 overflow-y-auto custom-scrollbar pr-1">
                {prescriptions.map(rx => <PrescriptionHistoryItem key={rx.id} rx={rx} />)}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Interactive Medicine Slot & Time Configuration Form */}
        <div className="space-y-5">
          <div className="bg-white rounded-3xl p-6 sm:p-7 space-y-5 border border-slate-200 shadow-xs">

            {/* Header & Selected Slot Indicator */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-2xl ${COMP_BG[c]} border ${COMP_BORDER[c]} shrink-0`}>
                  <Package className={`h-5 w-5 ${COMP_TEXT[c]}`} />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-800 font-headline">
                    Slot {selectedSlot + 1} Configuration
                  </h2>
                  <p className="text-xs text-slate-500 font-medium">
                    Select compartment, medicine name, dosage, dose alarm time, and timeout window
                  </p>
                </div>
              </div>
              <span className={`px-3 py-1 rounded-full text-xs font-bold border ${COMP_BG[c]} ${COMP_TEXT[c]} ${COMP_BORDER[c]}`}>
                SLOT {selectedSlot + 1}
              </span>
            </div>

            {/* 1. Choose Box Slot (1 - 4) */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
                <span>Select Target Compartment (1 – 4):</span>
                <span className="text-blue-700 font-bold text-xs truncate max-w-[200px]">
                  Current: {currentSlotEntry?.label ? currentSlotEntry.label : '(Empty)'}
                </span>
              </label>
              <div className="grid grid-cols-4 gap-2.5">
                {[0, 1, 2, 3].map((slotIdx) => {
                  const isActive = selectedSlot === slotIdx;
                  const slotData = activeSchedule.find(s => Number(s.compartment) === slotIdx);
                  const hasMed = slotData && slotData.label && slotData.label !== '(empty)';
                  return (
                    <button
                      key={slotIdx}
                      type="button"
                      onClick={() => setSelectedSlot(slotIdx)}
                      className={`p-3 rounded-2xl border text-center transition-all cursor-pointer ${
                        isActive
                          ? 'bg-blue-600 text-white border-blue-600 shadow-xs scale-[1.02]'
                          : 'bg-slate-50 border-slate-200 hover:bg-slate-100 text-slate-700'
                      }`}
                    >
                      <div className="text-xs font-bold">Slot {slotIdx + 1}</div>
                      <div className={`text-xs truncate mt-0.5 font-medium ${isActive ? 'text-blue-100' : 'text-slate-500'}`}>
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
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider flex items-center gap-1.5">
                  <Pill className="h-3.5 w-3.5 text-blue-600" /> Medicine Name:
                </label>
                <input
                  type="text"
                  value={medicineName}
                  onChange={(e) => setMedicineName(e.target.value)}
                  placeholder="e.g. Albuterol, Metformin, Paracetamol"
                  className="w-full px-4 py-3 rounded-2xl bg-white border border-slate-200 text-slate-800 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none placeholder:text-slate-400 transition"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  Dosage:
                </label>
                <input
                  type="text"
                  value={dosage}
                  onChange={(e) => setDosage(e.target.value)}
                  placeholder="e.g. 500mg, 1 tab"
                  className="w-full px-4 py-3 rounded-2xl bg-white border border-slate-200 text-slate-800 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none placeholder:text-slate-400 transition"
                />
              </div>
            </div>

            {/* 3. Dose Schedule Time + Presets */}
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="h-4 w-4 text-blue-600" /> Dose Schedule Alarm Time:
                </label>
                {scheduleTime ? (
                  <span className="text-xs text-blue-800 font-bold bg-blue-50 px-2.5 py-0.5 rounded-full border border-blue-200">
                    Alarm: {fmt12(scheduleTime)}
                  </span>
                ) : (
                  <span className="text-xs text-slate-500 font-medium bg-slate-100 px-2.5 py-0.5 rounded-full border border-slate-200">
                    No time set
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="px-4 py-2.5 rounded-2xl bg-white border border-slate-200 text-slate-800 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition shadow-2xs"
                />

                {/* Quick Presets */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setScheduleTime("08:00")}
                    className="px-2.5 py-1 rounded-xl bg-white hover:bg-blue-50 border border-slate-200 text-xs font-semibold text-slate-700 hover:text-blue-700 transition cursor-pointer"
                  >
                    Morning (8 AM)
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleTime("13:00")}
                    className="px-2.5 py-1 rounded-xl bg-white hover:bg-blue-50 border border-slate-200 text-xs font-semibold text-slate-700 hover:text-blue-700 transition cursor-pointer"
                  >
                    Noon (1 PM)
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleTime("18:00")}
                    className="px-2.5 py-1 rounded-xl bg-white hover:bg-blue-50 border border-slate-200 text-xs font-semibold text-slate-700 hover:text-blue-700 transition cursor-pointer"
                  >
                    Evening (6 PM)
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleTime("21:00")}
                    className="px-2.5 py-1 rounded-xl bg-white hover:bg-blue-50 border border-slate-200 text-xs font-semibold text-slate-700 hover:text-blue-700 transition cursor-pointer"
                  >
                    Night (9 PM)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const d = new Date(Date.now() + 1 * 60 * 1000);
                      const hh = String(d.getHours()).padStart(2, '0');
                      const mm = String(d.getMinutes()).padStart(2, '0');
                      setScheduleTime(`${hh}:${mm}`);
                    }}
                    className="px-2.5 py-1 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-300 text-xs font-bold text-amber-800 transition cursor-pointer"
                  >
                    +1m (Test)
                  </button>
                </div>
              </div>
            </div>

            {/* 3b. Dose Timeout Timer (1 to 10 min) */}
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider flex items-center gap-1.5">
                  <Timer className="h-4 w-4 text-blue-600" /> Dose Intake Timeout Window:
                </label>
                <span className="text-xs text-blue-800 font-bold bg-blue-50 px-2.5 py-0.5 rounded-full border border-blue-200">
                  Timeout: {timeoutMinutes} min
                </span>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2.5 flex-1">
                  <span className="text-xs font-bold text-slate-400 shrink-0">1m</span>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={timeoutMinutes}
                    onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <span className="text-xs font-bold text-slate-400 shrink-0">10m</span>
                </div>

                {/* Quick Presets */}
                <div className="flex items-center gap-1 shrink-0">
                  {[1, 2, 3, 5, 10].map((mins) => (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => setTimeoutMinutes(mins)}
                      className={`px-2 py-1 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                        timeoutMinutes === mins
                          ? 'bg-blue-600 text-white border-blue-600 shadow-2xs'
                          : 'bg-white hover:bg-blue-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {mins}m
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-[11px] text-slate-500 font-medium">
                ⏱ If patient does not open lid &amp; take dose within <strong>{timeoutMinutes} minute{timeoutMinutes > 1 ? 's' : ''}</strong> of alarm, it will be automatically marked as <strong>Missed</strong>.
              </p>
            </div>

            {/* 4. Physical Reload Confirmation Checkbox */}
            <div className="space-y-3">
              <label className={`flex items-start gap-3 p-4 rounded-2xl cursor-pointer transition-all ${
                reloadConfirmed ? 'bg-emerald-50 border border-emerald-300' : 'bg-slate-50 border border-slate-200 hover:bg-slate-100/70'
              }`}>
                <input
                  type="checkbox"
                  checked={reloadConfirmed}
                  onChange={e => setReloadConfirmed(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-emerald-600 cursor-pointer shrink-0 rounded"
                />
                <span className="text-xs text-slate-700 leading-relaxed font-medium">
                  <strong className="text-slate-800 font-bold">I have physically placed</strong>{' '}
                  <span className="text-blue-700 font-bold">
                    {medicineName.trim() ? `${medicineName.trim()} ${dosage.trim()}` : `Medicine`}
                  </span>{' '}
                  into <strong className="text-slate-800">Slot {selectedSlot + 1}</strong>. The slot is loaded and ready to dispense.
                </span>
              </label>

              {!reloadConfirmed && (
                <p className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-slate-400" />
                  Check the reload confirmation box above to enable Set Reminder.
                </p>
              )}
            </div>

            {/* 5. Set Reminder Action Button */}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={handleSaveSlot}
                disabled={!reloadConfirmed || savingSlot || !medicineName.trim() || !scheduleTime.trim()}
                className={`flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl text-sm font-bold transition-all ${
                  reloadConfirmed && medicineName.trim() && scheduleTime.trim() && !savingSlot
                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm active:scale-95 cursor-pointer'
                    : 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
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
                  setScheduleTime('');
                  setReloadConfirmed(false);
                }}
                className="px-5 py-3.5 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-slate-700 transition cursor-pointer"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Active 4-Slot Status Overview */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-3 shadow-xs">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <Package className="h-4 w-4 text-blue-600" /> All 4 Box Compartments
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((slotIdx) => {
                const item = activeSchedule.find(s => Number(s.compartment) === slotIdx);
                const isSelected = selectedSlot === slotIdx;
                const hasItem = item && item.label && item.label !== '(empty)';
                return (
                  <div
                    key={slotIdx}
                    onClick={() => setSelectedSlot(slotIdx)}
                    className={`p-3.5 rounded-2xl border transition-all cursor-pointer relative group ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50/60 ring-2 ring-blue-500/20 shadow-xs'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-800">Slot {slotIdx + 1}</span>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-semibold ${hasItem ? 'text-emerald-700' : 'text-slate-400'}`}>
                          {hasItem ? fmt12(`${String(item.hour).padStart(2, '0')}:${String(item.minute).padStart(2, '0')}`) : 'Empty'}
                        </span>
                        {hasItem && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleClearSlot(slotIdx);
                            }}
                            title="Clear this slot"
                            className="text-slate-400 hover:text-rose-600 transition text-xs font-bold px-1"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs font-bold text-slate-700 truncate mt-1">
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

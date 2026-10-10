import React, { useState, useRef, useCallback } from 'react';
import {
  FileText,
  Upload,
  CheckCircle,
  Activity,
  AlertCircle,
  ChevronRight,
  Sparkles,
  Eye,
  FileCheck,
  Pill,
  Clock,
  Sun,
  Moon,
  Utensils,
  AlertTriangle,
  ShieldCheck,
  Loader2,
  RotateCcw,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { ScanResult } from '../types';

interface ReportScannerProps {
  onAddScanResult: (result: ScanResult) => void;
  scannedHistory: ScanResult[];
}

interface RxMedTimings {
  morning: boolean | null;
  afternoon: boolean | null;
  night: boolean | null;
  before_food: boolean | null;
  after_food: boolean | null;
  duration_days: number | null;
}

interface RxExtractedMed {
  name_as_written: string;
  normalized_name: string;
  form: string;
  strength: string | null;
  dosage: string | null;
  frequency_raw: string;
  timings: RxMedTimings;
  source_line: number | null;
  confidence: number | null;
  confidence_reason: string;
  illegible_fields: string[];
  suggestedTime: string | null;
  name: string;
  frequency: string;
  purpose?: string;
}

interface RxScanOutput {
  handwriting_quality?: string;
  language_detected?: string;
  medicines: RxExtractedMed[];
  metrics?: any[];
  uncertain_items?: string[];
  error?: string;
  overview?: string;
  actions?: string[];
  disclaimer?: string;
}

function MetricCard({ metric, index }: { metric: any; index: number }) {
  const grad = GRAD_COLORS[index % GRAD_COLORS.length];
  const isConcerning = metric.status === "CONCERNING";
  const isElevated = metric.status === "ELEVATED";

  return (
    <div className={`rounded-3xl border overflow-hidden transition-all shadow-xs ${
      isConcerning ? 'border-rose-300 bg-rose-50/40'
        : isElevated ? 'border-amber-300 bg-amber-50/40'
        : 'border-slate-200 bg-white hover:border-slate-300'
    }`}>
      <div className={`h-1.5 w-full bg-gradient-to-r ${grad}`} />
      <div className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`h-10 w-10 rounded-2xl bg-gradient-to-br ${grad} text-white flex items-center justify-center text-base shrink-0 shadow-xs`}>
              🔬
            </div>
            <div className="min-w-0">
              <p className="text-base font-bold text-slate-800 leading-tight truncate">{metric.name}</p>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Lab Result</span>
          <p className="text-lg font-bold text-blue-700">{metric.value}</p>
        </div>
        
        {metric.interpretation && (
          <p className="text-xs text-slate-600 leading-relaxed border-l-2 border-slate-200 pl-3 italic">{metric.interpretation}</p>
        )}
      </div>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="text-xs text-slate-400 font-medium">Unavailable</span>;
  }
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? 'bg-emerald-500' : value >= 0.6 ? 'bg-amber-500' : 'bg-rose-500';
  const textColor = value >= 0.8 ? 'text-emerald-700' : value >= 0.6 ? 'text-amber-800' : 'text-rose-700';
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1 h-2 bg-slate-100 border border-slate-200/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-bold w-10 text-right ${textColor}`}>{pct}%</span>
    </div>
  );
}

function TimingPill({ label, icon: Icon, active }: { label: string; icon: any; active: boolean | null }) {
  if (active === null) return null;
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-semibold border transition-all ${
      active
        ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
        : 'bg-slate-50 border-slate-200 text-slate-400 opacity-60'
    }`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

const FORM_ICONS: Record<string, string> = {
  tablet: '💊', capsule: '💊', syrup: '🧴', injection: '💉',
  cream: '🧴', drops: '💧', sachet: '📦', unknown: '💊',
};
const GRAD_COLORS = [
  'from-blue-600 to-indigo-600',
  'from-emerald-600 to-teal-600',
  'from-violet-600 to-purple-600',
  'from-amber-600 to-orange-500',
  'from-sky-600 to-blue-500',
];

function MedCard({ med, index }: { med: RxExtractedMed; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const grad = GRAD_COLORS[index % GRAD_COLORS.length];
  const isLowConf = med.confidence != null && med.confidence < 0.6;
  const hasMidConf = med.confidence != null && med.confidence >= 0.6 && med.confidence < 0.8;
  const timings = med.timings || {};

  return (
    <div className={`rounded-3xl border overflow-hidden transition-all shadow-xs ${
      isLowConf ? 'border-rose-300 bg-rose-50/30'
        : hasMidConf ? 'border-amber-300 bg-amber-50/30'
        : 'border-slate-200 bg-white hover:border-slate-300'
    }`}>
      <div className={`h-1.5 w-full bg-gradient-to-r ${grad}`} />
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`h-11 w-11 rounded-2xl bg-gradient-to-br ${grad} text-white flex items-center justify-center text-base shrink-0 shadow-xs`}>
              {FORM_ICONS[med.form] || '💊'}
            </div>
            <div className="min-w-0">
              <p className="text-base font-bold text-slate-800 leading-tight truncate">{med.normalized_name || med.name}</p>
              {med.name_as_written && med.name_as_written !== med.normalized_name && (
                <p className="text-xs text-slate-500 italic truncate mt-0.5">As written: "{med.name_as_written}"</p>
              )}
            </div>
          </div>
          <div className="shrink-0">
            {isLowConf && (
              <span className="flex items-center gap-1.5 text-xs font-bold bg-rose-50 border border-rose-300 text-rose-700 px-3 py-1 rounded-full">
                <AlertTriangle className="h-3.5 w-3.5 text-rose-600" /> Verify
              </span>
            )}
            {hasMidConf && (
              <span className="flex items-center gap-1.5 text-xs font-bold bg-amber-50 border border-amber-300 text-amber-800 px-3 py-1 rounded-full">
                <AlertCircle className="h-3.5 w-3.5 text-amber-600" /> Check
              </span>
            )}
            {med.confidence != null && !isLowConf && !hasMidConf && (
              <span className="flex items-center gap-1.5 text-xs font-bold bg-emerald-50 border border-emerald-300 text-emerald-700 px-3 py-1 rounded-full">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-600" /> High
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 text-xs">
          {med.strength && (
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
              <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-0.5">Strength</p>
              <p className="text-slate-800 font-bold text-sm">{med.strength}</p>
            </div>
          )}
          {med.form && med.form !== 'unknown' && (
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
              <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-0.5">Form</p>
              <p className="text-slate-800 font-bold text-sm capitalize">{med.form}</p>
            </div>
          )}
          {med.frequency_raw && (
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
              <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-0.5">Frequency</p>
              <p className="text-slate-800 font-bold text-sm">{med.frequency_raw}</p>
            </div>
          )}
          {med.dosage && (
            <div className="bg-slate-50 rounded-2xl p-3 border border-slate-100">
              <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-0.5">Dose</p>
              <p className="text-slate-800 font-bold text-sm">{med.dosage}</p>
            </div>
          )}
        </div>

        {(timings.morning !== null || timings.afternoon !== null || timings.night !== null) && (
          <div className="flex flex-wrap gap-2 pt-1">
            <TimingPill label="Morning" icon={Sun} active={timings.morning} />
            <TimingPill label="Afternoon" icon={Activity} active={timings.afternoon} />
            <TimingPill label="Night" icon={Moon} active={timings.night} />
            {timings.before_food && <TimingPill label="Before food" icon={Utensils} active={timings.before_food} />}
            {timings.after_food && <TimingPill label="After food" icon={Utensils} active={timings.after_food} />}
          </div>
        )}

        {timings.duration_days != null && (
          <div className="flex items-center gap-1.5 text-xs text-slate-700 font-medium">
            <Clock className="h-4 w-4 text-blue-600" />
            Duration: <span className="text-blue-800 font-bold">{timings.duration_days} days</span>
          </div>
        )}

        {med.purpose && (
          <p className="text-xs text-slate-600 leading-relaxed italic border-l-2 border-blue-400 pl-3 bg-blue-50/30 py-1.5 rounded-r-xl">{med.purpose}</p>
        )}

        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">OCR Confidence</span>
            <button onClick={() => setExpanded(e => !e)} className="text-xs font-semibold text-blue-700 hover:text-blue-800 flex items-center gap-1 transition cursor-pointer">
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {expanded ? 'Less' : 'Details'}
            </button>
          </div>
          <ConfidenceBar value={med.confidence} />
          {med.confidence_reason && <p className="text-xs text-slate-500 italic">{med.confidence_reason}</p>}
        </div>

        {expanded && (
          <div className="border-t border-slate-100 pt-3 space-y-2.5">
            {med.illegible_fields && med.illegible_fields.length > 0 && (
              <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200">
                <p className="text-xs font-bold text-amber-900 uppercase tracking-wider mb-1.5">Illegible fields — verify manually:</p>
                <div className="flex flex-wrap gap-1.5">
                  {med.illegible_fields.map((f, i) => (
                    <span key={i} className="px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-xs text-amber-900 font-semibold">{f}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 text-xs text-slate-500">
              {med.source_line != null && <><span>Line {med.source_line}</span><span>·</span></>}
              {med.form && <span className="capitalize">{med.form}</span>}
              {med.suggestedTime && <><span>·</span><span>⏰ {med.suggestedTime}</span></>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UncertainItems({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="p-5 rounded-3xl bg-amber-50 border border-amber-300 shadow-xs">
      <p className="text-xs font-bold text-amber-900 uppercase tracking-wider mb-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600" /> Unclassified text — verify with original ({items.length})
      </p>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <p key={i} className="text-xs text-amber-950 italic leading-relaxed">"{item}"</p>
        ))}
      </div>
    </div>
  );
}

function QualityBadge({ quality }: { quality?: string }) {
  const map: Record<string, { color: string; label: string }> = {
    legible: { color: 'text-emerald-700 bg-emerald-50 border-emerald-300', label: '✓ Legible' },
    unknown: { color: 'text-slate-600 bg-slate-100 border-slate-200', label: 'Unavailable' },
    moderate: { color: 'text-amber-800 bg-amber-50 border-amber-300', label: '~ Moderate' },
    difficult: { color: 'text-rose-700 bg-rose-50 border-rose-300', label: '✗ Difficult' },
    mixed: { color: 'text-blue-700 bg-blue-50 border-blue-300', label: '≈ Mixed' },
  };
  const q = map[quality || 'unknown'] || map['unknown'];
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${q.color}`}>
      Handwriting: {q.label}
    </span>
  );
}

function LegacyMarkdownView({ text }: { text: string }) {
  const parseBold = (str: string) => {
    const parts = str.split(/\*\*([^*]+)\*\*/g);
    return parts.map((p, i) =>
      i % 2 === 1 ? <strong key={i} className="font-bold text-blue-700">{p}</strong> : p
    );
  };
  return (
    <div className="space-y-3">
      {text.split('\n').map((line, i) => {
        const t = line.trim();
        if (t.startsWith('###')) return <h4 key={i} className="text-xs font-bold text-blue-700 mt-4 mb-1 uppercase tracking-wider">{t.replace('###', '').trim()}</h4>;
        if (t.startsWith('##')) return <h3 key={i} className="text-sm font-bold text-slate-800 mt-4 border-b border-slate-200 pb-1 mb-2">{t.replace('##', '').trim()}</h3>;
        if (t.startsWith('* ') || t.startsWith('- ')) return <li key={i} className="text-sm text-slate-700 ml-4 list-disc pl-1 mb-1 leading-relaxed">{parseBold(t.substring(2))}</li>;
        if (/^\d+\.\s/.test(t)) {
          const num = t.match(/^\d+/)?.[0] || '1';
          return <div key={i} className="flex gap-2 text-sm text-slate-700 ml-2 mb-1"><span className="text-blue-700 font-bold">{num}.</span><div>{parseBold(t.replace(/^\d+\.\s/, ''))}</div></div>;
        }
        if (!t) return <div key={i} className="h-2" />;
        return <p key={i} className="text-sm text-slate-700 leading-relaxed">{parseBold(t)}</p>;
      })}
    </div>
  );
}

export default function ReportScanner({ onAddScanResult, scannedHistory }: ReportScannerProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<ScanResult | null>(null);
  const [activeRxData, setActiveRxData] = useState<RxScanOutput | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const LOADING_MSGS = [
    'Scanning document with local AI vision...',
    'Decoding medical notes and lab metrics...',
    'Running medication database check...',
    'Validating clinical dosage intervals...',
    'Building structured report synthesis...',
  ];

  const processDocumentAnalysis = useCallback(async (
    fileBase64: string, nameOfFile: string, mime: string, promptText?: string
  ) => {
    setLoading(true);
    setErrorMessage(null);
    setActiveRxData(null);

    let msgIdx = 0;
    setLoadingMessage(LOADING_MSGS[0]);
    const msgInterval = setInterval(() => {
      msgIdx = (msgIdx + 1) % LOADING_MSGS.length;
      setLoadingMessage(LOADING_MSGS[msgIdx]);
    }, 2000);

    try {
      const response = await fetch('/api/scan-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileData: fileBase64, mimeType: mime, fileName: nameOfFile, promptText }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Gateway connection failed.');

      let rxData: RxScanOutput | null = null;
      if (data.medicines && Array.isArray(data.medicines)) {
        rxData = {
          medicines: data.medicines as RxExtractedMed[],
          handwriting_quality: data.handwriting_quality,
          language_detected: data.language_detected,
          uncertain_items: data.uncertain_items || [],
          overview: data.overview,
          actions: data.actions,
          disclaimer: data.disclaimer,
        };
      }

      const newResult: ScanResult = {
        fileName: nameOfFile,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }) + ' - ' + new Date().toLocaleDateString(),
        summary: data.summary || '',
      };

      onAddScanResult(newResult);
      setActiveReport(newResult);
      setActiveRxData(rxData);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Internal error during document analysis.');
    } finally {
      clearInterval(msgInterval);
      setLoading(false);
    }
  }, [onAddScanResult]);

  const triggerFileRead = useCallback((file: File) => {
    setSelectedFile(file);
    setErrorMessage(null);
    const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|tiff?|heic)$/i.test(file.name);
    if (isImage) {
      const reader = new FileReader();
      reader.onload = (e) => setFilePreview(e.target?.result as string);
      reader.readAsDataURL(file);
    } else { setFilePreview(null); }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      const mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'image/jpeg');
      processDocumentAnalysis(base64, file.name, mime);
    };
    reader.readAsDataURL(file);
  }, [processDocumentAnalysis]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) triggerFileRead(file);
  };

  const clearScanner = () => {
    setActiveReport(null); setActiveRxData(null);
    setSelectedFile(null); setFilePreview(null); setErrorMessage(null);
  };

  const hasStructuredData = Boolean(activeRxData && ((activeRxData.medicines?.length ?? 0) > 0 || (activeRxData.metrics?.length ?? 0) > 0 || activeRxData.uncertain_items?.length));

  return (
    <div className="flex flex-col gap-6 relative">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-800 tracking-tight flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-50 text-blue-600 border border-blue-100">
              <FileText className="h-6 w-6" />
            </div>
            AI Clinical Document Scanner
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            Upload clinical reports, doctor notes, or charts. Local AI extracts prescribed medicines and dosage guidance.
          </p>
        </div>
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 px-4 py-2 rounded-full shadow-2xs">
          <Sparkles className="h-4 w-4 text-blue-600" />
          <span className="text-xs font-bold text-blue-800 uppercase tracking-wider">Local AI Vision</span>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-5">
          {/* Upload zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`p-6 bg-white border rounded-3xl flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-300 group relative py-9 shadow-xs ${
              dragging
                ? 'border-blue-500 bg-blue-50/50 scale-[1.01]'
                : 'border-slate-200 hover:border-blue-400 hover:bg-blue-50/20'
            }`}
          >
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.pdf" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) triggerFileRead(f); }} />
            {filePreview ? (
              <div className="w-full mb-3 relative">
                <img src={filePreview} alt="Preview" className="rounded-2xl max-h-32 object-contain mx-auto border border-slate-200 shadow-xs" />
                <button onClick={e => { e.stopPropagation(); clearScanner(); }} className="absolute top-1 right-1 p-1.5 rounded-xl bg-white/95 text-slate-600 hover:text-slate-900 border border-slate-200 shadow-xs">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="p-4 bg-blue-50 rounded-2xl border border-blue-100 text-blue-600 group-hover:scale-105 transition mb-3 shadow-xs">
                <Upload className="h-7 w-7" />
              </div>
            )}
            <h3 className="text-base font-bold font-headline text-slate-800">Drag &amp; Drop Patient Records</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-xs leading-relaxed font-medium">Supports clinical photo scans, prescription notes, and reports (JPEG, PNG, or PDF)</p>
            <span className="mt-4 px-4 py-2.5 bg-blue-50 hover:bg-blue-600 hover:text-white border border-blue-200 rounded-2xl text-xs font-bold text-blue-700 transition-all shadow-2xs">Choose Local File</span>
          </div>

          {/* History */}
          <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 pb-2.5 mb-3">
              Extraction Records Registry
            </h3>
            {scannedHistory.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400 font-medium">No documents analysed today.</div>
            ) : (
              <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                {scannedHistory.map((scan, idx) => {
                  const isActive = activeReport?.fileName === scan.fileName;
                  return (
                    <div key={idx} onClick={() => { setActiveReport(scan); setActiveRxData(null); }}
                      className={`p-3 rounded-2xl border cursor-pointer transition flex justify-between items-center ${
                        isActive
                          ? 'bg-blue-50 border-blue-300 text-blue-900 shadow-xs'
                          : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100/80'
                      }`}>
                      <div className="truncate flex-1 pr-2">
                        <p className="text-xs font-bold truncate leading-snug">{scan.fileName}</p>
                        <span className="text-xs text-slate-400 mt-0.5 block">{scan.timestamp}</span>
                      </div>
                      <Eye className="h-4 w-4 text-slate-400 shrink-0" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT */}
        <div className="lg:col-span-2">
          {loading ? (
            <div className="h-full min-h-[480px] bg-white border border-slate-200 rounded-3xl flex flex-col items-center justify-center text-center p-8 space-y-6 shadow-xs">
              <div className="relative">
                <div className="h-16 w-16 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" />
                <Sparkles className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-5 w-5 text-blue-600 animate-pulse" />
              </div>
              <div className="space-y-2 max-w-md">
                <h3 className="text-base font-bold font-headline text-slate-800">Optical Extraction In Progress</h3>
                <p className="text-sm text-blue-700 font-semibold animate-pulse">{loadingMessage}</p>
              </div>
              <div className="text-xs text-slate-400 max-w-sm">Handwriting decode · pharmacist lexicon check · anti-hallucination guard</div>
            </div>

          ) : errorMessage ? (
            <div className="bg-rose-50/20 border border-rose-200 rounded-3xl p-8 text-center min-h-[400px] flex flex-col items-center justify-center space-y-4 shadow-xs">
              <div className="p-3.5 rounded-2xl bg-rose-50 text-rose-600 border border-rose-200 shadow-xs"><AlertCircle className="h-8 w-8" /></div>
              <h3 className="text-base font-bold font-headline text-slate-800">Document Analysis Failed</h3>
              <p className="text-xs text-rose-700 leading-relaxed max-w-sm">{errorMessage}</p>
              <button onClick={clearScanner} className="mt-2 flex items-center gap-2 text-xs font-bold text-blue-700 bg-blue-50 px-4 py-2.5 rounded-2xl border border-blue-200 hover:bg-blue-100 transition shadow-2xs cursor-pointer">
                <RotateCcw className="h-3.5 w-3.5" /> Reset and try again
              </button>
            </div>

          ) : hasStructuredData ? (
            <div className="bg-white rounded-3xl overflow-hidden flex flex-col shadow-xs border border-slate-200">
              <div className="p-4 bg-slate-50/80 border-b border-slate-200 flex justify-between items-center px-6">
                <div className="flex gap-3 items-center">
                  <div className="p-2 bg-blue-50 text-blue-600 rounded-2xl border border-blue-100 shadow-xs"><FileCheck className="h-5 w-5" /></div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-800 font-headline">{activeReport?.fileName}</h3>
                    <p className="text-xs text-slate-400">Scanned: {activeReport?.timestamp}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {activeRxData?.handwriting_quality && <QualityBadge quality={activeRxData.handwriting_quality} />}
                  <button onClick={clearScanner} className="px-3.5 py-1.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-100 text-xs text-slate-700 font-semibold transition shadow-2xs cursor-pointer">Clear</button>
                </div>
              </div>

              <div className="p-6 space-y-5 overflow-y-auto max-h-[600px] custom-scrollbar">
                {/* Stats */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-slate-50 rounded-2xl border border-slate-200 p-3.5 text-center">
                    <p className="text-2xl font-bold text-blue-700 font-headline">{activeRxData!.medicines?.length || activeRxData!.metrics?.length || 0}</p>
                    <p className="text-xs text-slate-500 mt-0.5 font-medium">Medicines extracted</p>
                  </div>
                  <div className="bg-slate-50 rounded-2xl border border-slate-200 p-3.5 text-center">
                    <p className="text-2xl font-bold text-emerald-700 font-headline">{activeRxData!.medicines?.filter(m => (m.confidence ?? 0) >= 0.8).length || activeRxData!.metrics?.filter(m => m.status === 'NORMAL').length || 0}</p>
                    <p className="text-xs text-slate-500 mt-0.5 font-medium">High confidence</p>
                  </div>
                  <div className="bg-slate-50 rounded-2xl border border-slate-200 p-3.5 text-center">
                    <p className="text-2xl font-bold text-amber-700 font-headline">{(activeRxData!.medicines?.filter(m => (m.confidence ?? 0) < 0.8).length || activeRxData!.metrics?.filter(m => m.status !== 'NORMAL').length || 0) + (activeRxData!.uncertain_items?.length || 0)}</p>
                    <p className="text-xs text-slate-500 mt-0.5 font-medium">Need review</p>
                  </div>
                </div>

                {(activeRxData!.medicines || []).some(m => (m.confidence ?? 0) < 0.6) && (
                  <div className="flex items-start gap-3 p-4 rounded-2xl bg-rose-50 border border-rose-200">
                    <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-rose-800">Low-confidence readings detected</p>
                      <p className="text-xs text-rose-700 mt-1">Check the original prescription before confirming these medicines.</p>
                    </div>
                  </div>
                )}

                {activeRxData!.metrics && activeRxData!.metrics.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Activity className="h-4 w-4 text-blue-600" /> Clinical Metrics
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      {activeRxData!.metrics.map((metric, i) => <MetricCard key={i} metric={metric} index={i} />)}
                    </div>
                  </div>
                )}
                {activeRxData!.medicines && activeRxData!.medicines.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Pill className="h-4 w-4 text-blue-600" /> Extracted Medicines
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      {activeRxData!.medicines.map((med, i) => <MedCard key={i} med={med} index={i} />)}
                    </div>
                  </div>
                )}

                <UncertainItems items={activeRxData!.uncertain_items || []} />

                <div className="flex items-start gap-3 p-4 rounded-2xl bg-slate-50 border border-slate-200">
                  <ShieldCheck className="h-5 w-5 text-slate-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-slate-600 leading-relaxed">
                    All extraction performed locally on this device. Always confirm with your prescribing physician before modifying dosage.
                  </p>
                </div>

                {activeReport?.summary && (
                  <div className="border-t border-slate-200 pt-4">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-blue-600" /> AI Clinical Summary
                    </h4>
                    <div className="border-l-2 border-blue-400 pl-4"><LegacyMarkdownView text={activeReport.summary} /></div>
                  </div>
                )}
              </div>
            </div>

          ) : activeReport ? (
            <div className="bg-white rounded-3xl overflow-hidden flex flex-col shadow-xs border border-slate-200">
              <div className="p-4 bg-slate-50/80 border-b border-slate-200 flex justify-between items-center px-6">
                <div className="flex gap-3 items-center">
                  <div className="p-2 bg-blue-50 text-blue-600 rounded-2xl border border-blue-100 shadow-xs"><FileCheck className="h-5 w-5" /></div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-800 font-headline">{activeReport.fileName}</h3>
                    <p className="text-xs text-slate-400">Scanned: {activeReport.timestamp}</p>
                  </div>
                </div>
                <button onClick={clearScanner} className="px-3.5 py-1.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-100 text-xs text-slate-700 font-semibold transition shadow-2xs cursor-pointer">Clear</button>
              </div>
              <div className="p-6 space-y-4 overflow-y-auto max-h-[600px] custom-scrollbar">
                <div className="flex items-center gap-2 text-xs text-blue-700 font-bold uppercase tracking-wider">
                  <Sparkles className="h-4 w-4" /><span>AI Clinical Directives</span>
                </div>
                <div className="space-y-2 border-l-2 border-blue-400 pl-4 py-1">
                  <LegacyMarkdownView text={activeReport.summary} />
                </div>
              </div>
            </div>

          ) : (
            <div className="bg-white border-2 border-dashed border-slate-200 rounded-3xl p-8 text-center min-h-[480px] flex flex-col items-center justify-center space-y-4 shadow-xs">
              <div className="relative">
                <div className="h-20 w-20 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center">
                  <FileText className="h-10 w-10 text-blue-500" />
                </div>
                <div className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-white border border-blue-200 flex items-center justify-center shadow-xs">
                  <Sparkles className="h-4 w-4 text-blue-600" />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-bold font-headline text-slate-800">Document Readout Deck</h3>
                <p className="text-xs text-slate-500 max-w-sm leading-relaxed font-medium">Select a document from the registry on the left, or upload a medical note photo to let Local AI extract comprehensive parameters instantly.</p>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-4 w-full max-w-xs">
                {['Local Vision', 'Confidence Check', 'Dose Timings'].map((f, i) => (
                  <div key={i} className="text-center p-3 rounded-2xl bg-slate-50 border border-slate-200">
                    <p className="text-xs text-blue-700 font-bold">{f}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
  FileSpreadsheet,
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
  source_line: number;
  confidence: number;
  confidence_reason: string;
  illegible_fields: string[];
  suggestedTime: string;
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

const SAMPLE_REPORTS = [
  {
    name: "Cardio_Prescription_Arthur.png",
    type: "Cardiology Prescription",
    mimeType: "image/png",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    promptText: "PRESCRIPTION DETAILS:\nPatient: Arthur Campbell, Age: 78\nDiagnosis: Hypertension & Hyperlipidemia\nRx:\n1. Lisinopril 10mg - Take 1 tablet OD (Once daily in the morning at 08:00) for blood pressure control.\n2. Atorvastatin 20mg - Take 1 tablet HS (Bedtime at 21:00) with water for cholesterol.\n3. Aspirin 75mg - Take 1 tablet OD (Morning with food at 08:00) as antiplatelet therapy.\nSpecial Instructions: Monitor blood pressure weekly.",
  },
  {
    name: "Diabetic_Care_Prescription.png",
    type: "Endocrinology / Diabetes",
    mimeType: "image/png",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    promptText: "PRESCRIPTION DETAILS:\nPatient: Arthur Campbell, Age: 78\nDiagnosis: Type 2 Diabetes Mellitus\nRx:\n1. Metformin 500mg - Take 1 tablet BD (Twice daily at 08:00 and 20:00 with meals) for glucose control.\n2. Glimepiride 1mg - Take 1 tablet OD (Morning before breakfast at 08:00).\n3. Vitamin D3 60,000 IU - Take 1 capsule weekly with milk.\nSpecial Instructions: Check fasting blood glucose regularly.",
  }
];


function MetricCard({ metric, index }: { metric: any; index: number }) {
  const grad = GRAD_COLORS[index % GRAD_COLORS.length];
  const isConcerning = metric.status === "CONCERNING";
  const isElevated = metric.status === "ELEVATED";

  return (
    <div className={`rounded-2xl border overflow-hidden transition-all ${
      isConcerning ? 'border-red-500/40 bg-red-950/10'
        : isElevated ? 'border-amber-500/30 bg-amber-950/5'
        : 'border-slate-700/60 bg-slate-900/50'
    }`}>
      <div className={`h-0.5 w-full bg-gradient-to-r ${grad}`} />
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className={`h-8 w-8 rounded-xl bg-gradient-to-br ${grad} flex items-center justify-center text-sm shrink-0`}>
              🔬
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-white leading-tight truncate">{metric.name}</p>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wide">Result</span>
          </div>
          <p className="text-sm font-bold text-emerald-400">{metric.value}</p>
        </div>
        
        {metric.interpretation && (
          <p className="text-[9px] text-slate-500 font-mono italic">{metric.interpretation}</p>
        )}
      </div>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? 'bg-emerald-500' : value >= 0.6 ? 'bg-amber-400' : 'bg-red-400';
  const textColor = value >= 0.8 ? 'text-emerald-400' : value >= 0.6 ? 'text-amber-400' : 'text-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] font-mono font-bold w-8 text-right ${textColor}`}>{pct}%</span>
    </div>
  );
}

function TimingPill({ label, icon: Icon, active }: { label: string; icon: any; active: boolean | null }) {
  if (active === null) return null;
  return (
    <div className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-mono font-semibold border transition-all ${
      active
        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
        : 'bg-slate-800/60 border-slate-700 text-slate-600 opacity-50'
    }`}>
      <Icon className="h-2.5 w-2.5" />
      {label}
    </div>
  );
}

const FORM_ICONS: Record<string, string> = {
  tablet: '💊', capsule: '💊', syrup: '🧴', injection: '💉',
  cream: '🧴', drops: '💧', sachet: '📦', unknown: '💊',
};
const GRAD_COLORS = [
  'from-emerald-500 to-teal-500',
  'from-indigo-500 to-violet-500',
  'from-amber-500 to-orange-400',
  'from-rose-500 to-pink-500',
  'from-sky-500 to-cyan-400',
];

function MedCard({ med, index }: { med: RxExtractedMed; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const grad = GRAD_COLORS[index % GRAD_COLORS.length];
  const isLowConf = med.confidence < 0.6;
  const hasMidConf = med.confidence >= 0.6 && med.confidence < 0.8;
  const timings = med.timings || {};

  return (
    <div className={`rounded-2xl border overflow-hidden transition-all ${
      isLowConf ? 'border-red-500/40 bg-red-950/10'
        : hasMidConf ? 'border-amber-500/30 bg-amber-950/5'
        : 'border-slate-700/60 bg-slate-900/50'
    }`}>
      <div className={`h-0.5 w-full bg-gradient-to-r ${grad}`} />
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className={`h-8 w-8 rounded-xl bg-gradient-to-br ${grad} flex items-center justify-center text-sm shrink-0`}>
              {FORM_ICONS[med.form] || '💊'}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-white leading-tight truncate">{med.normalized_name || med.name}</p>
              {med.name_as_written && med.name_as_written !== med.normalized_name && (
                <p className="text-[10px] text-slate-500 font-mono italic truncate">as written: "{med.name_as_written}"</p>
              )}
            </div>
          </div>
          <div className="shrink-0">
            {isLowConf && (
              <span className="flex items-center gap-1 text-[9px] font-bold font-mono bg-red-500/20 border border-red-500/30 text-red-300 px-2 py-0.5 rounded-full">
                <AlertTriangle className="h-2.5 w-2.5" /> VERIFY
              </span>
            )}
            {hasMidConf && (
              <span className="flex items-center gap-1 text-[9px] font-bold font-mono bg-amber-500/20 border border-amber-500/30 text-amber-300 px-2 py-0.5 rounded-full">
                <AlertCircle className="h-2.5 w-2.5" /> CHECK
              </span>
            )}
            {!isLowConf && !hasMidConf && (
              <span className="flex items-center gap-1 text-[9px] font-bold font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 px-2 py-0.5 rounded-full">
                <CheckCircle className="h-2.5 w-2.5" /> CLEAR
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          {med.strength && (
            <div className="bg-slate-800/60 rounded-lg p-2 border border-slate-700/60">
              <p className="text-slate-500 font-mono text-[9px] uppercase tracking-wide mb-0.5">Strength</p>
              <p className="text-white font-bold font-mono">{med.strength}</p>
            </div>
          )}
          {med.form && med.form !== 'unknown' && (
            <div className="bg-slate-800/60 rounded-lg p-2 border border-slate-700/60">
              <p className="text-slate-500 font-mono text-[9px] uppercase tracking-wide mb-0.5">Form</p>
              <p className="text-white font-bold capitalize">{med.form}</p>
            </div>
          )}
          {med.frequency_raw && (
            <div className="bg-slate-800/60 rounded-lg p-2 border border-slate-700/60">
              <p className="text-slate-500 font-mono text-[9px] uppercase tracking-wide mb-0.5">Frequency</p>
              <p className="text-white font-bold font-mono">{med.frequency_raw}</p>
            </div>
          )}
          {med.dosage && (
            <div className="bg-slate-800/60 rounded-lg p-2 border border-slate-700/60">
              <p className="text-slate-500 font-mono text-[9px] uppercase tracking-wide mb-0.5">Dose</p>
              <p className="text-white font-bold">{med.dosage}</p>
            </div>
          )}
        </div>

        {(timings.morning !== null || timings.afternoon !== null || timings.night !== null) && (
          <div className="flex flex-wrap gap-1.5">
            <TimingPill label="Morning" icon={Sun} active={timings.morning} />
            <TimingPill label="Afternoon" icon={Activity} active={timings.afternoon} />
            <TimingPill label="Night" icon={Moon} active={timings.night} />
            {timings.before_food && <TimingPill label="Before food" icon={Utensils} active={timings.before_food} />}
            {timings.after_food && <TimingPill label="After food" icon={Utensils} active={timings.after_food} />}
          </div>
        )}

        {timings.duration_days != null && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
            <Clock className="h-3 w-3 text-indigo-400" />
            Duration: <span className="text-indigo-300 font-bold">{timings.duration_days} days</span>
          </div>
        )}

        {med.purpose && (
          <p className="text-[11px] text-slate-400 leading-relaxed italic border-l-2 border-slate-700 pl-2">{med.purpose}</p>
        )}

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wide">OCR Confidence</span>
            <button onClick={() => setExpanded(e => !e)} className="text-[9px] text-slate-500 hover:text-slate-300 flex items-center gap-0.5 transition">
              {expanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
              {expanded ? 'Less' : 'Details'}
            </button>
          </div>
          <ConfidenceBar value={med.confidence} />
          {med.confidence_reason && <p className="text-[9px] text-slate-500 font-mono italic">{med.confidence_reason}</p>}
        </div>

        {expanded && (
          <div className="border-t border-slate-800 pt-3 space-y-2">
            {med.illegible_fields && med.illegible_fields.length > 0 && (
              <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-[9px] font-mono text-amber-400 uppercase tracking-wide mb-1">Illegible fields — verify manually:</p>
                <div className="flex flex-wrap gap-1">
                  {med.illegible_fields.map((f, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[9px] text-amber-300 font-mono">{f}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 text-[9px] font-mono text-slate-500">
              <span>Line {med.source_line}</span>
              <span>·</span>
              <span className="capitalize">{med.form}</span>
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
    <div className="p-3 rounded-xl bg-amber-900/20 border border-amber-500/20">
      <p className="text-[10px] font-mono text-amber-400 uppercase tracking-wide mb-2 flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> Unclassified text — verify with original ({items.length})
      </p>
      <div className="space-y-1">
        {items.map((item, i) => (
          <p key={i} className="text-[10px] text-amber-200/70 font-mono italic leading-relaxed">"{item}"</p>
        ))}
      </div>
    </div>
  );
}

function QualityBadge({ quality }: { quality?: string }) {
  const map: Record<string, { color: string; label: string }> = {
    legible: { color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', label: '✓ Legible' },
    moderate: { color: 'text-amber-400 bg-amber-500/10 border-amber-500/30', label: '~ Moderate' },
    difficult: { color: 'text-red-400 bg-red-500/10 border-red-500/30', label: '✗ Difficult' },
    mixed: { color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/30', label: '≈ Mixed' },
  };
  const q = map[quality || 'legible'] || map['legible'];
  return (
    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold font-mono border ${q.color}`}>
      Handwriting: {q.label}
    </span>
  );
}

function LegacyMarkdownView({ text }: { text: string }) {
  const parseBold = (str: string) => {
    const parts = str.split(/\*\*([^*]+)\*\*/g);
    return parts.map((p, i) =>
      i % 2 === 1 ? <strong key={i} className="font-bold text-emerald-400">{p}</strong> : p
    );
  };
  return (
    <div className="space-y-2">
      {text.split('\n').map((line, i) => {
        const t = line.trim();
        if (t.startsWith('###')) return <h4 key={i} className="text-xs font-bold text-emerald-400 mt-4 mb-1 uppercase tracking-wider">{t.replace('###', '').trim()}</h4>;
        if (t.startsWith('##')) return <h3 key={i} className="text-sm font-bold text-emerald-300 mt-4 border-b border-slate-800 pb-1 mb-2">{t.replace('##', '').trim()}</h3>;
        if (t.startsWith('* ') || t.startsWith('- ')) return <li key={i} className="text-xs text-slate-300 ml-4 list-disc pl-1 mb-1 leading-relaxed">{parseBold(t.substring(2))}</li>;
        if (/^\d+\.\s/.test(t)) {
          const num = t.match(/^\d+/)?.[0] || '1';
          return <div key={i} className="flex gap-2 text-xs text-slate-300 ml-2 mb-1"><span className="text-emerald-400 font-bold font-mono">{num}.</span><div>{parseBold(t.replace(/^\d+\.\s/, ''))}</div></div>;
        }
        if (!t) return <div key={i} className="h-2" />;
        return <p key={i} className="text-xs text-slate-300 leading-relaxed">{parseBold(t)}</p>;
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
    'Scanning handwriting with local AI vision...',
    'Decoding glyphs letter by letter...',
    'Running pharmacist lexicon check...',
    'Cross-checking frequency patterns...',
    'Validating extracted medicines...',
    'Building structured output...',
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

  const hasStructuredData = activeRxData && (activeRxData.medicines?.length > 0 || activeRxData.metrics?.length > 0 || activeRxData.uncertain_items?.length);

  return (
    <div className="flex flex-col gap-6 relative">
      <div className="orb-indigo -top-32 -right-32" />

      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-bold text-slate-100 tracking-tight flex items-center gap-3">
            <FileText className="text-indigo-400 h-6 w-6" /> AI Clinical Scanner
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Upload clinical reports, doctor notes, or charts. Local AI extracts prescribed medicines and patient-friendly dosage guidance.
          </p>
        </div>
        <div className="flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/30 px-3.5 py-1.5 rounded-full">
          <Sparkles className="h-4 w-4 text-indigo-400 animate-pulse" />
          <span className="text-xs font-bold font-label text-indigo-300 uppercase tracking-wider">Powered by Local AI</span>
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
            className={`p-6 glass-card rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-300 group relative py-10 ${dragging ? 'border-indigo-400/70 bg-indigo-500/5 scale-[1.01]' : 'hover:border-indigo-500/40'}`}
          >
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.pdf" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) triggerFileRead(f); }} />
            {filePreview ? (
              <div className="w-full mb-3 relative">
                <img src={filePreview} alt="Preview" className="rounded-xl max-h-32 object-contain mx-auto border border-slate-700" />
                <button onClick={e => { e.stopPropagation(); clearScanner(); }} className="absolute top-1 right-1 p-1 rounded-lg bg-slate-900/80 text-slate-400 hover:text-white">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div className="p-3 bg-indigo-500/10 rounded-2xl border border-indigo-500/20 text-indigo-400 group-hover:scale-110 transition mb-4">
                <Upload className="h-6 w-6" />
              </div>
            )}
            <h3 className="text-sm font-semibold font-headline text-slate-200">Drag & Drop Patient Records</h3>
            <p className="text-[11px] text-slate-400 mt-1 max-w-xs leading-relaxed">Supports clinical photo scans, prescription notes, and reports (JPEG, PNG, or PDF up to 10MB)</p>
            <span className="mt-4 px-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 rounded-xl text-xs font-label font-bold text-indigo-400 transition-all">Choose Local File</span>
            <div className="absolute inset-3 border border-dashed border-slate-700/60 rounded-xl pointer-events-none group-hover:border-indigo-500/30 transition" />
          </div>


          {/* History */}
          <div className="glass-card rounded-2xl p-5">
            <h3 className="text-xs font-bold text-white uppercase tracking-widest font-label border-b border-slate-800 pb-2 mb-3">Extraction Records Registry</h3>
            {scannedHistory.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-500 font-mono">No documents analysed today.</div>
            ) : (
              <div className="space-y-2 max-h-44 overflow-y-auto pr-1 custom-scrollbar">
                {scannedHistory.map((scan, idx) => {
                  const isActive = activeReport?.fileName === scan.fileName;
                  return (
                    <div key={idx} onClick={() => { setActiveReport(scan); setActiveRxData(null); }}
                      className={`p-2.5 rounded-xl border cursor-pointer transition flex justify-between items-center ${isActive ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300' : 'bg-slate-950/60 border-slate-900 text-slate-400 hover:border-slate-800'}`}>
                      <div className="truncate flex-1 pr-2">
                        <p className="text-xs font-bold truncate leading-snug">{scan.fileName}</p>
                        <span className="text-[9px] text-slate-500 font-mono">{scan.timestamp}</span>
                      </div>
                      <Eye className="h-3.5 w-3.5 text-slate-500 shrink-0" />
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
            <div className="h-full min-h-[500px] glass-card rounded-2xl flex flex-col items-center justify-center text-center p-8 space-y-6">
              <div className="relative">
                <div className="h-16 w-16 rounded-full border-4 border-indigo-500/20 border-t-indigo-500 animate-spin" />
                <Sparkles className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-5 w-5 text-indigo-400 animate-pulse" />
              </div>
              <div className="space-y-2 max-w-md">
                <h3 className="text-base font-bold font-headline text-white">Optical Extraction In Progress</h3>
                <p className="text-xs text-slate-400 font-mono animate-pulse">{loadingMessage}</p>
              </div>
              <div className="text-[10px] text-slate-600 font-mono tracking-wider max-w-sm">6-step handwriting decode · pharmacist lexicon check · anti-hallucination guard</div>
            </div>

          ) : errorMessage ? (
            <div className="glass-card border-rose-950/40 rounded-2xl p-8 text-center min-h-[400px] flex flex-col items-center justify-center space-y-4">
              <div className="p-3 rounded-full bg-red-500/10 text-red-500 border border-red-500/30"><AlertCircle className="h-8 w-8" /></div>
              <h3 className="text-base font-bold font-headline text-white">Document Analysis Failed</h3>
              <p className="text-xs text-rose-300 leading-relaxed max-w-sm font-mono">{errorMessage}</p>
              <button onClick={clearScanner} className="mt-2 flex items-center gap-2 text-xs font-semibold font-label text-indigo-400 bg-indigo-500/10 px-4 py-2 rounded-xl border border-indigo-500/20 hover:bg-indigo-500/20 transition">
                <RotateCcw className="h-3.5 w-3.5" /> Reset and try again
              </button>
            </div>

          ) : hasStructuredData ? (
            <div className="glass-card rounded-2xl overflow-hidden flex flex-col shadow-2xl">
              <div className="p-4 bg-slate-950/80 border-b border-slate-800/80 flex justify-between items-center px-6">
                <div className="flex gap-3 items-center">
                  <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20"><FileCheck className="h-4 w-4" /></div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-200 font-headline">{activeReport?.fileName}</h3>
                    <p className="text-[10px] text-slate-500 font-mono">SCANNED: {activeReport?.timestamp}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {activeRxData?.handwriting_quality && <QualityBadge quality={activeRxData.handwriting_quality} />}
                  <button onClick={clearScanner} className="px-3 py-1.5 rounded-lg glass-card hover:border-slate-600 font-mono text-[9px] text-slate-400 font-semibold transition">Clear</button>
                </div>
              </div>

              <div className="p-6 space-y-5 overflow-y-auto max-h-[600px] custom-scrollbar">
                {/* Stats */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-slate-900/60 rounded-xl border border-slate-800 p-3 text-center">
                    <p className="text-2xl font-bold text-indigo-400 font-headline">{activeRxData!.medicines?.length || activeRxData!.metrics?.length || 0}</p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">Medicines extracted</p>
                  </div>
                  <div className="bg-slate-900/60 rounded-xl border border-slate-800 p-3 text-center">
                    <p className="text-2xl font-bold text-emerald-400 font-headline">{activeRxData!.medicines?.filter(m => m.confidence >= 0.8).length || activeRxData!.metrics?.filter(m => m.status === 'NORMAL').length || 0}</p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">High confidence</p>
                  </div>
                  <div className="bg-slate-900/60 rounded-xl border border-slate-800 p-3 text-center">
                    <p className="text-2xl font-bold text-amber-400 font-headline">{(activeRxData!.medicines?.filter(m => m.confidence < 0.8).length || activeRxData!.metrics?.filter(m => m.status !== 'NORMAL').length || 0) + (activeRxData!.uncertain_items?.length || 0)}</p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">Need review</p>
                  </div>
                </div>

                {(activeRxData!.medicines || []).some(m => m.confidence < 0.6) && (
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-red-500/10 border border-red-500/30">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-red-300">Low-confidence readings detected</p>
                      <p className="text-[11px] text-red-400/80 mt-1">Check the original prescription before confirming these medicines.</p>
                    </div>
                  </div>
                )}

                {activeRxData!.metrics && activeRxData!.metrics.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-2">
                      <Activity className="h-3.5 w-3.5 text-indigo-400" /> Clinical Metrics
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {activeRxData!.metrics.map((metric, i) => <MetricCard key={i} metric={metric} index={i} />)}
                    </div>
                  </div>
                )}
                {activeRxData!.medicines && activeRxData!.medicines.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-2">
                      <Pill className="h-3.5 w-3.5 text-indigo-400" /> Extracted Medicines
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {activeRxData!.medicines.map((med, i) => <MedCard key={i} med={med} index={i} />)}
                    </div>
                  </div>
                )}

                <UncertainItems items={activeRxData!.uncertain_items || []} />

                <div className="flex items-start gap-2 p-3 rounded-xl bg-slate-900/60 border border-slate-800">
                  <ShieldCheck className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                  <p className="text-[10px] text-slate-500 font-mono leading-relaxed">
                    All extraction performed locally on this device. No prescription data transmitted. Always confirm with your prescribing physician before modifying dosage.
                  </p>
                </div>

                {activeReport?.summary && (
                  <div className="border-t border-slate-800 pt-4">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono mb-2 flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-indigo-400" /> AI Clinical Summary
                    </h4>
                    <div className="border-l-2 border-indigo-500/20 pl-4"><LegacyMarkdownView text={activeReport.summary} /></div>
                  </div>
                )}
              </div>
            </div>

          ) : activeReport ? (
            <div className="glass-card rounded-2xl overflow-hidden flex flex-col shadow-2xl">
              <div className="p-4 bg-slate-950/80 border-b border-slate-800/80 flex justify-between items-center px-6">
                <div className="flex gap-3 items-center">
                  <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20"><FileCheck className="h-4 w-4" /></div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-200 font-headline">{activeReport.fileName}</h3>
                    <p className="text-[10px] text-slate-500 font-mono">SCANNED: {activeReport.timestamp}</p>
                  </div>
                </div>
                <button onClick={clearScanner} className="px-3 py-1.5 rounded-lg glass-card hover:border-slate-600 font-mono text-[9px] text-slate-400 font-semibold transition">Clear Scanner</button>
              </div>
              <div className="p-6 space-y-4 overflow-y-auto max-h-[600px] custom-scrollbar">
                <div className="flex items-center gap-2 text-xs text-indigo-400 font-bold uppercase tracking-wider font-label">
                  <Sparkles className="h-4 w-4 fill-indigo-400" /><span>AI Clinical Directives</span>
                </div>
                <div className="space-y-2 border-l-2 border-indigo-500/20 pl-4 py-1">
                  <LegacyMarkdownView text={activeReport.summary} />
                </div>
              </div>
            </div>

          ) : (
            <div className="glass-card border-2 border-dashed border-slate-800/80 rounded-2xl p-8 text-center min-h-[500px] flex flex-col items-center justify-center space-y-4">
              <div className="relative">
                <div className="h-20 w-20 rounded-full bg-indigo-500/5 border border-indigo-500/10 flex items-center justify-center">
                  <FileText className="h-10 w-10 text-slate-600" />
                </div>
                <div className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                  <Sparkles className="h-4 w-4 text-indigo-500" />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-bold font-headline text-slate-300">Active Scan Readout Pane</h3>
                <p className="text-xs text-slate-500 max-w-sm leading-relaxed">Select a document preset on the side deck, or upload a medical note photo to let Local AI extract comprehensive geriatric parameters instantly.</p>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-4 w-full max-w-xs">
                {['6-step OCR', 'Confidence', 'Timings'].map((f, i) => (
                  <div key={i} className="text-center p-3 rounded-xl bg-slate-900/40 border border-slate-800">
                    <p className="text-[10px] font-mono text-indigo-400 font-bold">{f}</p>
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

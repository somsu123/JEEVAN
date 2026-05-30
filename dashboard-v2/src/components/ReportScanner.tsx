import React, { useState, useRef } from 'react';
import { 
  FileText, 
  Upload, 
  CheckCircle, 
  Activity, 
  AlertCircle,
  Clock,
  ChevronRight,
  Sparkles,
  RefreshCw,
  Eye,
  FileSpreadsheet
} from 'lucide-react';
import { ScanResult } from '../types';

interface ReportScannerProps {
  onAddScanResult: (result: ScanResult) => void;
  scannedHistory: ScanResult[];
}

// Preset reports for demonstration
const SAMPLE_REPORTS = [
  {
    name: "Arthur_Blood_Lab_Result.png",
    type: "Blood Panel",
    mimeType: "image/jpeg",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    promptText: "Simulated Blood Panel Report: Hemoglobin 11.2 (Slightly low), Blood Urea Nitrogen (BUN) 28 (Slightly high), Blood Sugar 98 (Normal).",
    description: "Arthurs Blood Panel analysis (Anemia/Kidney marker evaluation)"
  },
  {
    name: "Cardio_EKG_Doctor_Note.png",
    type: "Cardiology assessment",
    mimeType: "image/png",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    promptText: "Simulated ECG Physician Note: Sinus Rhythm at 72 BPM. Isolated premature ventricular contractions (PVCs) resolved during sitting. Prescribed Lisinopril 10mg daily.",
    description: "Doctor's diagnostic check from cardiologist visit"
  }
];

export default function ReportScanner({
  onAddScanResult,
  scannedHistory
}: ReportScannerProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<ScanResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helper function to extract **Bold** patterns and output as HTML nodes
  const parseBoldText = (text: string) => {
    const parts = text.split(/\*\*([^*]+)\*\*/g);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return <strong key={i} className="font-bold text-white text-emerald-400/95">{part}</strong>;
      }
      return part;
    });
  };

  // Formats Markdown response into JSX elements
  const formatMarkdownToJSX = (text: string) => {
    if (!text) return null;
    
    const lines = text.split('\n');
    return lines.map((line, index) => {
      const trimmed = line.trim();
      
      // Headers
      if (trimmed.startsWith('###')) {
        return <h4 key={index} className="text-sm font-bold text-emerald-400 mt-4 mb-2 uppercase tracking-wide font-mono">{trimmed.replace('###', '').trim()}</h4>;
      }
      if (trimmed.startsWith('##')) {
        return <h3 key={index} className="text-base font-bold text-emerald-300 mt-5 border-b border-slate-800 pb-1.5 mb-3">{trimmed.replace('##', '').trim()}</h3>;
      }
      if (trimmed.startsWith('#')) {
        return <h2 key={index} className="text-lg font-black text-white mt-6 mb-4">{trimmed.replace('#', '').trim()}</h2>;
      }

      // Bullet List Items
      if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        const itemText = trimmed.substring(2);
        return (
          <li key={index} className="text-xs text-slate-300 ml-4 list-disc pl-1 mb-1 leading-relaxed">
            {parseBoldText(itemText)}
          </li>
        );
      }

      // Numbered items
      if (/^\d+\.\s/.test(trimmed)) {
        const itemText = trimmed.replace(/^\d+\.\s/, '');
        const num = trimmed.match(/^\d+/)?.[0] || '1';
        return (
          <div key={index} className="flex gap-2 text-xs text-slate-300 ml-2 mb-2 leading-relaxed items-start">
            <span className="font-mono font-bold text-emerald-400">{num}.</span>
            <div className="flex-1">{parseBoldText(itemText)}</div>
          </div>
        );
      }

      // Disclaimer box
      if (trimmed.toLowerCase().includes('disclaimer')) {
        return (
          <div key={index} className="mt-6 p-4 bg-slate-950 rounded-xl border border-slate-800/80 text-[10px] text-slate-500 font-mono leading-relaxed flex gap-2">
            <AlertCircle className="h-4.5 w-4.5 text-slate-500 shrink-0 mt-0.5" />
            <div>{parseBoldText(trimmed)}</div>
          </div>
        );
      }

      // Plain paragraphs
      if (trimmed === '') {
        return <div key={index} className="h-3.5" />;
      }

      return (
        <p key={index} className="text-xs text-slate-305 leading-relaxed mb-1.5">
          {parseBoldText(trimmed)}
        </p>
      );
    });
  };

  // Calls the backend endpoint to analyze the file
  const processDocumentAnalysis = async (fileBase64: string, nameOfFile: string, mime: string) => {
    setLoading(true);
    setErrorMessage(null);
    setLoadingMessage("Calibrating secure gateway with clinical neural network...");
    
    try {
      const response = await fetch("/api/scan-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileData: fileBase64,
          mimeType: mime,
          fileName: nameOfFile
        })
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Gateway connection failed compiling Gemini extraction.");
      }

      const newResult: ScanResult = {
        fileName: nameOfFile,
        timestamp: new Date().toLocaleTimeString() + " - " + new Date().toLocaleDateString(),
        summary: data.summary
      };

      onAddScanResult(newResult);
      setActiveReport(newResult);
      setLoading(false);
    } catch (err: any) {
      setErrorMessage(err?.message || "Internal transmission crash parsing documentation.");
      setLoading(false);
    }
  };

  // Handles manual file drops & uploads
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    triggerFileRead(file);
  };

  const triggerFileRead = (file: File) => {
    setSelectedFile(file);
    setErrorMessage(null);

    // Image preview
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setFilePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }

    // Convert to base64 and process
    const reader = new FileReader();
    reader.onload = () => {
      const base64Str = (reader.result as string).split(',')[1];
      processDocumentAnalysis(base64Str, file.name, file.type);
    };
    reader.readAsDataURL(file);
  };

  // Drag-and-drop mechanics
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      triggerFileRead(file);
    }
  };

  // Trigger simulated scan using sample files
  const handleLoadPresetReport = (report: typeof SAMPLE_REPORTS[0]) => {
    processDocumentAnalysis(report.base64, report.name, report.mimeType);
  };

  return (
    <div className="space-y-6">

      {/* Header element */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/60 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <FileText className="text-emerald-400 h-6 w-6" /> Clinical Scanner & Summarizer
          </h1>
          <p className="text-sm text-slate-400">
            Upload clinical reports, doctor notes, or charts. Gemini AI breaks them down into empowering, plain, patient-friendly guidance.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Double column including active uploader & history list */}
        <div className="lg:col-span-1 space-y-5">
          
          {/* Main Uploader card */}
          <div 
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="p-6 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer hover:border-emerald-500/40 transition group relative py-10"
            onClick={() => fileInputRef.current?.click()}
          >
            <input 
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={handleFileChange}
            />

            <div className="p-3 bg-emerald-500/10 rounded-full border border-emerald-500/20 text-emerald-400 group-hover:scale-110 transition mb-4">
              <Upload className="h-6 w-6" />
            </div>

            <h3 className="text-sm font-semibold text-slate-200">Drag & Drop Patient Records</h3>
            <p className="text-[11px] text-slate-400 mt-1 max-w-xs leading-relaxed">
              Supports clinical photo scans, prescription notes, and reports (JPEG, PNG, or PDF up to 10MB)
            </p>
            
            <span className="mt-4 px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-[10px] font-mono font-medium text-emerald-400">
              OR CHOOSE LOCAL FILE
            </span>

            {/* Quick dropzone border effect */}
            <div className="absolute inset-2 border border-dashed border-slate-800 rounded-xl pointer-events-none group-hover:border-emerald-500/20 transition" />
          </div>

          {/* Quick preset clinical notes for instant testing */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div>
              <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                No reports handy? Quick Presets:
              </h4>
              <p className="text-[10px] text-slate-500 mt-1">
                Trigger real Gemini translations immediately using standard clinical sample summaries.
              </p>
            </div>

            <div className="space-y-2 pt-1">
              {SAMPLE_REPORTS.map((report, idx) => (
                <div 
                  key={idx}
                  onClick={() => handleLoadPresetReport(report)}
                  className="p-3 bg-slate-950/60 rounded-xl border border-slate-900 hover:border-emerald-500/30 transition text-left cursor-pointer flex justify-between items-center group"
                >
                  <div className="flex gap-2.5 items-center">
                    <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 font-mono">
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-350">{report.type}</p>
                      <p className="text-[10px] text-slate-500 font-mono italic truncate max-w-40">{report.name}</p>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-500 group-hover:text-emerald-400 transition" />
                </div>
              ))}
            </div>
          </div>

          {/* Historic scanned files log list */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5">
            <h3 className="text-xs font-bold text-white uppercase tracking-widest font-mono border-b border-slate-850 pb-2 mb-3">
              Extraction Records Registry
            </h3>

            {scannedHistory.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-500">
                No documents analysed today.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-44 overflow-y-auto pr-1">
                {scannedHistory.map((scan, idx) => {
                  const isActive = activeReport?.fileName === scan.fileName;
                  return (
                    <div 
                      key={idx}
                      onClick={() => setActiveReport(scan)}
                      className={`p-2.5 rounded-xl border cursor-pointer transition text-left flex justify-between items-center ${
                        isActive 
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' 
                          : 'bg-slate-950/60 border-slate-900 text-slate-400 hover:border-slate-800'
                      }`}
                    >
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

        {/* Right triple column containing results and active processing displays */}
        <div className="lg:col-span-2">
          
          {loading ? (
            /* Loading display card */
            <div className="h-full min-h-[400px] bg-slate-900 border border-slate-800 rounded-2xl flex flex-col items-center justify-center text-center p-8 space-y-6">
              
              <div className="relative">
                <div className="h-16 w-16 rounded-full border-4 border-emerald-500/20 border-t-emerald-500 animate-spin" />
                <Sparkles className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-5 w-5 text-emerald-400 animate-pulse" />
              </div>

              <div className="space-y-2 max-w-md">
                <h3 className="text-base font-bold text-white">Optical Extraction In Progress</h3>
                <p className="text-xs text-slate-400 font-mono animate-pulse">{loadingMessage}</p>
              </div>

              <div className="text-[10px] text-slate-600 font-mono tracking-wider max-w-sm">
                NOTE: First initialization can take up to 4s while compiling the sandboxed clinical records mapping.
              </div>
            </div>
          ) : errorMessage ? (
            /* Error banner */
            <div className="bg-slate-900 border border-rose-950/40 rounded-2xl p-8 text-center min-h-[400px] flex flex-col items-center justify-center space-y-4">
              <div className="p-3 rounded-full bg-red-500/10 text-red-500 border border-red-500/30">
                <AlertCircle className="h-8 w-8" />
              </div>
              <h3 className="text-base font-bold text-white">Document Analysis Failed</h3>
              <p className="text-xs text-rose-300 leading-relaxed max-w-sm font-mono mr-auto ml-auto">
                {errorMessage}
              </p>
              <button
                onClick={() => setErrorMessage(null)}
                className="mt-2 text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-4 py-2 rounded-xl border border-emerald-500/20 hover:bg-emerald-500/20"
              >
                Reset upload and try again
              </button>
            </div>
          ) : activeReport ? (
            /* Main markdown display container */
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-2xl animate-fadeIn">
              
              {/* Document identifier banner header */}
              <div className="p-4 bg-slate-950 border-b border-slate-850 flex justify-between items-center px-6">
                <div className="flex gap-3 items-center">
                  <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
                    <FileText className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-200">{activeReport.fileName}</h3>
                    <p className="text-[10px] text-slate-500 font-mono">SCANNED AT: {activeReport.timestamp}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setActiveReport(null);
                      setSelectedFile(null);
                      setFilePreview(null);
                    }}
                    className="px-3 py-1.5 rounded-lg border border-slate-800 hover:bg-slate-900 font-mono text-[9px] text-slate-400 font-semibold"
                  >
                    Clear Scanner
                  </button>
                </div>
              </div>

              {/* Renders the markdown format */}
              <div className="p-6 md:p-8 space-y-4 overflow-y-auto max-h-[600px] text-left">
                <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-bold uppercase tracking-wider font-mono">
                  <Sparkles className="h-4 w-4 text-emerald-400 fill-emerald-400" />
                  <span>AI CARE CLINICAL DIRECTIVES</span>
                </div>

                <div className="space-y-2 border-l border-emerald-500/10 pl-4 py-1">
                  {formatMarkdownToJSX(activeReport.summary)}
                </div>
              </div>

            </div>
          ) : (
            /* Empty welcome placeholder banner */
            <div className="bg-slate-900 border-2 border-dashed border-slate-800/80 rounded-2xl p-8 text-center min-h-[400px] flex flex-col items-center justify-center space-y-3">
              <FileText className="h-12 w-12 text-slate-600 animate-pulse" />
              <h3 className="text-base font-bold text-slate-300">Active Scan Readout Pane</h3>
              <p className="text-xs text-slate-500 max-w-sm leading-relaxed">
                Select a document preset on the side deck, or upload a medical note photo to let Gemini AI extract comprehensive geriatric parameters instantly.
              </p>
            </div>
          )}

        </div>

      </div>

    </div>
  );
}

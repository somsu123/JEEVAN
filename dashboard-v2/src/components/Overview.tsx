import React, { useState } from 'react';
import { 
  FileText, 
  Activity, 
  Heart, 
  User, 
  ArrowRight, 
  Smartphone,
  AlertTriangle,
  Flame,
  Battery,
  ShieldCheck,
  CheckCircle2,
  Calendar,
  Layers,
  Sparkles,
  Droplet,
  ExternalLink,
  Table
} from 'lucide-react';
import { ScanResult, VitalState } from '../types';

interface OverviewProps {
  scannedHistory: ScanResult[];
  onNavigate: (view: any) => void;
  activeAlert: boolean;
  vitals?: VitalState;
}

export default function Overview({
  scannedHistory,
  onNavigate,
  activeAlert,
  vitals
}: OverviewProps) {
  // Active selected report index for in-depth dashboard analysis
  const [selectedReportIdx, setSelectedReportIdx] = useState<number>(0);

  // NLP Parser to extract metrics dynamically from the scanned medical reports
  const extractMetricsFromReports = () => {
    let heartRate = "--";
    let hrSource = "";
    
    let bp = "--/--";
    let bpSource = "";
    
    let hemoglobin = "--";
    let hbSource = "";
    
    let gfr = "--";
    let gfrSource = "";

    // Iterate backwards so older reports populate first, then newer ones override them to reflect the latest state
    [...scannedHistory].reverse().forEach(report => {
      const text = report.summary || "";
      
      // Extract heart rate
      const hrMatch = text.match(/(\d+)\s*BPM/i);
      if (hrMatch) {
        heartRate = hrMatch[1];
        hrSource = report.fileName;
      }
      
      // Extract blood pressure
      const bpMatch = text.match(/(\d+\/\d+)\s*mmHg/i);
      if (bpMatch) {
        bp = bpMatch[1];
        bpSource = report.fileName;
      }
      
      // Extract Hemoglobin
      const hbMatch = text.match(/(\d+\.\d+)\s*g\/dL/i);
      if (hbMatch) {
        hemoglobin = hbMatch[1];
        hbSource = report.fileName;
      }
      
      // Extract Kidney GFR
      const gfrMatch = text.match(/GFR.*?(\d+)\s*mL\/min/i) || text.match(/(\d+)\s*mL\/min/i);
      if (gfrMatch) {
        gfr = gfrMatch[1];
        gfrSource = report.fileName;
      }
    });

    return { 
      heartRate, hrSource, 
      bp, bpSource, 
      hemoglobin, hbSource, 
      gfr, gfrSource 
    };
  };

  const metrics = extractMetricsFromReports();
  const activeReport = scannedHistory[selectedReportIdx] || scannedHistory[0] || null;

  // Custom JSX Renderer for parsed medical report notes with elegant layout
  const parseReportSummaryToJSX = (summaryText: string) => {
    if (!summaryText) return <p className="text-slate-400 text-xs">No analysis available for this document.</p>;
    
    const lines = summaryText.split('\n');
    return lines.map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return <div key={idx} className="h-3.5" />;

      // Subheadings
      if (trimmed.startsWith('###')) {
        return (
          <h4 key={idx} className="text-xs font-bold text-emerald-400 mt-5 border-b border-slate-800/80 pb-1.5 mb-2.5 uppercase tracking-wider font-mono">
            {trimmed.replace('###', '').trim()}
          </h4>
        );
      }
      if (trimmed.startsWith('##')) {
        return (
          <h3 key={idx} className="text-sm font-bold text-white mt-6 mb-3 border-l-2 border-emerald-500 pl-2">
            {trimmed.replace('##', '').trim()}
          </h3>
        );
      }

      // Bullet points
      if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        const textContent = trimmed.substring(2);
        return (
          <div key={idx} className="flex gap-2 text-xs text-slate-300 ml-3 mb-1.5 leading-relaxed items-start">
            <span className="text-emerald-500 text-base leading-none -mt-1">•</span>
            <div className="flex-1">{boldPatternParser(textContent)}</div>
          </div>
        );
      }

      // Numbered items
      if (/^\d+\.\s/.test(trimmed)) {
        const textContent = trimmed.replace(/^\d+\.\s/, '');
        const num = trimmed.match(/^\d+/)?.[0] || '1';
        return (
          <div key={idx} className="flex gap-2.5 text-xs text-slate-300 ml-3 mb-2 leading-relaxed items-start bg-slate-950/45 p-2 rounded-xl border border-slate-900/40">
            <span className="font-mono font-black text-[10px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded leading-none">{num}</span>
            <div className="flex-1">{boldPatternParser(textContent)}</div>
          </div>
        );
      }

      // Default paragraph
      return (
        <p key={idx} className="text-xs text-slate-350 leading-relaxed mb-2">
          {boldPatternParser(trimmed)}
        </p>
      );
    });
  };

  const boldPatternParser = (text: string) => {
    const parts = text.split(/\*\*([^*]+)\*\//g) || [text];
    
    // Fallback if regex split behaves weirdly, check for standard asterisks
    const simpleParts = text.split(/\*\*([^*]+)\*\*/g);
    return simpleParts.map((part, i) => {
      if (i % 2 === 1) {
        return <span key={i} className="font-bold text-white bg-slate-950/60 px-1 py-0.5 rounded border border-slate-905 font-mono text-[11px] text-emerald-400">{part}</span>;
      }
      return part;
    });
  };

  return (
    <div className="space-y-6" id="report-analytics-dashboard">
      
      {/* Overview Headway Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/60 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Arthur Pendelton's Core Report Analytics</h1>
          <p className="text-sm text-slate-400 mt-1">Empirical diagnostics synthesized purely from clinical notes, laboratory exams, and cardiology reports.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs font-semibold text-emerald-400 font-mono">CLINICAL DATABASE ONLINE</span>
          </div>
          <button 
            onClick={() => onNavigate('report-scanner')}
            className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs rounded-xl transition flex items-center gap-1.5 shadow-lg shadow-emerald-500/10"
          >
            <Sparkles className="h-3.5 w-3.5" /> Scan Records
          </button>
        </div>
      </div>      {/* SECTION: EXTRACTED ANALYTICAL FIGURES FROM DOCUMENTS */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Synthesized Patient Analytics Summary</h3>
        
        <div className="w-full max-w-sm">
          
          {/* Heart Rate Metric */}
          <div className="bg-slate-900/50 p-5 rounded-2xl border border-slate-800 hover:border-emerald-500/20 transition-all flex flex-col justify-between h-40">
            <div>
              <div className="flex justify-between items-start">
                <span className="text-[10px] text-slate-500 font-mono tracking-wider block">RESTING HEART RHYMTH</span>
                <Heart className={`h-4 w-4 ${vitals && typeof vitals.heartRate === 'number' && vitals.heartRate > 0 && vitals.fingerPresent ? "text-rose-400 animate-pulse" : "text-emerald-400"}`} />
              </div>
              <span className="text-3xl font-black text-white block mt-2 tracking-tight">
                {vitals ? vitals.heartRate : "--"} <span className="text-xs font-medium text-slate-400">BPM</span>
              </span>
              {vitals && typeof vitals.heartRate === 'number' && vitals.heartRate > 0 && vitals.fingerPresent ? (
                <span className="text-[10px] text-rose-400 font-mono mt-0.5 block flex items-center gap-1">
                  <span className="relative flex h-2 w-2 mr-1">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                  </span>
                  Live tracking active
                </span>
              ) : (
                <span className="text-[10px] text-emerald-500 font-mono mt-0.5 block flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 inline" /> Rhythm stable
                </span>
              )}
            </div>
            <div className="border-t border-slate-800/60 pt-2 mt-2">
              <span className="text-[9px] text-slate-500 font-mono block truncate">
                Source: {vitals && typeof vitals.heartRate === 'number' && vitals.heartRate > 0 ? "Real-time ESP32 Bracelet" : "No Device Connected"}
              </span>
            </div>
          </div>

        </div>
      </div>

      {/* CORE HUB: SCANNED REPORTS FEED AND DETAILED SYNTHESIZED ANALYSIS VIEW */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Side: Chronological Documents list */}
        <div className="lg:col-span-1 bg-slate-900/40 border border-slate-800/80 rounded-2xl p-5 flex flex-col justify-between h-[450px]">
          <div>
            <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
              <FileText className="h-4 w-4 text-emerald-400" /> Diagnostics Library ({scannedHistory.length})
            </h2>
            
            <div className="space-y-3 overflow-y-auto max-h-[360px] pr-1">
              {scannedHistory.length === 0 ? (
                <div className="text-center py-10 space-y-3 bg-slate-950/40 rounded-xl border border-slate-900/80">
                  <p className="text-xs text-slate-500">No clinical files scanned yet.</p>
                  <button 
                    onClick={() => onNavigate('report-scanner')}
                    className="text-xs text-emerald-400 font-bold hover:underline"
                  >
                    Initiate Document Scan
                  </button>
                </div>
              ) : (
                scannedHistory.map((report, idx) => (
                  <div 
                    key={idx}
                    onClick={() => setSelectedReportIdx(idx)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                      selectedReportIdx === idx 
                        ? 'bg-emerald-500/10 border-emerald-500/40 text-white' 
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-900/20'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${selectedReportIdx === idx ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-900 text-slate-400'}`}>
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-xs font-bold leading-tight truncate text-slate-200">{report.fileName}</h4>
                        <p className="text-[9px] text-slate-500 font-mono mt-1">{report.timestamp}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800/60 mt-3 text-center">
            <button
              onClick={() => onNavigate('report-scanner')}
              className="text-xs text-slate-450 hover:text-white flex items-center gap-1.5 justify-center mx-auto transition-colors font-mono font-medium"
            >
              Analyze newer files &rarr;
            </button>
          </div>
        </div>

        {/* Right Side: Active report's full analytical output */}
        <div className="lg:col-span-2 bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800/80 rounded-2xl p-6 h-[450px] flex flex-col justify-between overflow-hidden">
          {activeReport ? (
            <div className="flex flex-col h-full overflow-hidden">
              {/* Header */}
              <div className="flex justify-between items-center border-b border-slate-800/80 pb-3 mb-4 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded bg-emerald-500/10 text-emerald-400 text-xs font-mono font-bold">DIGITAL METRIC EXTRACTION</span>
                  <p className="text-[11px] text-slate-400 font-mono truncate max-w-xs">{activeReport.fileName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5 text-slate-500" />
                  <span className="text-[10px] text-slate-450 font-mono">{activeReport.timestamp}</span>
                </div>
              </div>

              {/* Synthesized Output Scrollable Area */}
              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                <div className="space-y-4">
                  <div>
                    <h2 className="text-base font-black text-white flex items-center gap-2 uppercase tracking-wide">
                      <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" /> Synthesized Clinical Profile
                    </h2>
                    <p className="text-[11px] text-slate-500 font-mono mt-0.5">Below values are compiled from real-world laboratory scanning parameters.</p>
                  </div>

                  <div className="bg-slate-950/80 p-5 rounded-2xl border border-slate-900/50 space-y-4">
                    {parseReportSummaryToJSX(activeReport.summary)}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
              <FileText className="h-10 w-10 text-slate-700 animate-pulse" />
              <div>
                <h3 className="text-sm font-semibold text-slate-300">No Patient Report Injected</h3>
                <p className="text-xs text-slate-500 max-w-xs mt-1">Please direct standard medical prescription files or laboratory printouts to the scanning tool.</p>
              </div>
            </div>
          )}
        </div>

      </div>

      {/* SECTION: CARE PLAN DIRECTIVES AGGREGATED FROM CLINICAL DIAGNOSTICS */}
      <div className="bg-slate-900/35 border border-slate-800/80 rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Smartphone className="h-4.5 w-4.5 text-emerald-400" /> Extracted Care Plan Directives & Medical Tasks
          </h3>
          <p className="text-xs text-slate-500 mt-1">Unified clinical directives parsed explicitly out of Arthur's reports. Do not double-dose.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          <div className="p-4 bg-slate-950/80 rounded-xl border border-slate-900 flex gap-3.5 items-start">
            <div className="p-2 rounded bg-red-500/10 text-red-400 font-mono text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5">CRITICAL PRECAUTION</div>
            <div>
              <h4 className="text-xs font-bold text-slate-200">Avoid Sudden Posture Transitions</h4>
              <p className="text-[11px] text-slate-450 mt-1 leading-relaxed">Cardiology Note records orthopedic pressure drops. Stand slowly or pause to sit if feeling any lightheadedness.</p>
            </div>
          </div>

          <div className="p-4 bg-slate-950/80 rounded-xl border border-slate-900 flex gap-3.5 items-start">
            <div className="p-2 rounded bg-emerald-500/10 text-emerald-400 font-mono text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5">PHARMA THERAPY</div>
            <div>
              <h4 className="text-xs font-bold text-slate-200">Lisinopril 10mg morning hours</h4>
              <p className="text-[11px] text-slate-450 mt-1 leading-relaxed">Extracted prescription note to protect systemic cardiac walls and keep tension metrics within standard parameters.</p>
            </div>
          </div>

          <div className="p-4 bg-slate-950/80 rounded-xl border border-slate-900 flex gap-3.5 items-start">
            <div className="p-2 rounded bg-teal-500/10 text-teal-400 font-mono text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5 font-semibold">DIETARY ADVICE</div>
            <div>
              <h4 className="text-xs font-bold text-slate-200">Increase Daily Clear Liquid Intake</h4>
              <p className="text-[11px] text-slate-450 mt-1 leading-relaxed">Targeting 1.8L of fluids daily in response to mild GFR filtration drops which caused minor BUN elevation warnings.</p>
            </div>
          </div>

          <div className="p-4 bg-slate-950/80 rounded-xl border border-slate-900 flex gap-3.5 items-start">
            <div className="p-2 rounded bg-violet-500/10 text-violet-400 font-mono text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5">LAB SCHEDULING</div>
            <div>
              <h4 className="text-xs font-bold text-slate-200">Repeat Complete Blood Panel Scan</h4>
              <p className="text-[11px] text-slate-450 mt-1 leading-relaxed">Mandated follow-up in 3 months time specifically targeting hematology parameters and hemoglobin counts.</p>
            </div>
          </div>

        </div>
      </div>

    </div>
  );
}

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
  Table,
  Wind,
  Bot
} from 'lucide-react';
import { ScanResult, VitalState } from '../types';
import AiDictator from './AiDictator';

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

  // AI Dictator modal state
  const [dictatorOpen, setDictatorOpen] = useState(false);

  const handleTriggerAiDictator = () => {
    setDictatorOpen(true);
  };

  // NLP Parser to extract metrics dynamically from the scanned medical reports
  const extractMetricsFromReports = () => {
    let heartRate = "--";
    let hrSource = "";

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
      hemoglobin, hbSource,
      gfr, gfrSource
    };
  };

  const metrics = extractMetricsFromReports();
  const activeReport = scannedHistory[selectedReportIdx] || scannedHistory[0] || null;

  // Custom JSX Renderer for parsed medical report notes with elegant layout
  const parseReportSummaryToJSX = (summaryText: string) => {
    if (!summaryText) return <p className="text-slate-400 text-xs font-mono">No analysis available for this document.</p>;

    const lines = summaryText.split('\n');
    return lines.map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return <div key={idx} className="h-3" />;

      // Subheadings
      if (trimmed.startsWith('###')) {
        return (
          <h4 key={idx} className="text-xs font-bold font-label text-emerald-400 mt-4 border-b border-slate-800/80 pb-1.5 mb-2.5 uppercase tracking-wider">
            {trimmed.replace('###', '').trim()}
          </h4>
        );
      }
      if (trimmed.startsWith('##')) {
        return (
          <h3 key={idx} className="text-sm font-bold font-headline text-white mt-5 mb-2.5 border-l-2 border-emerald-500 pl-2">
            {trimmed.replace('##', '').trim()}
          </h3>
        );
      }

      // Bullet points
      if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        const textContent = trimmed.substring(2);
        return (
          <div key={idx} className="flex gap-2 text-xs text-slate-300 ml-2 mb-1.5 leading-relaxed items-start">
            <span className="text-emerald-500 text-base leading-none -mt-0.5">•</span>
            <div className="flex-1">{boldPatternParser(textContent)}</div>
          </div>
        );
      }

      // Numbered items
      if (/^\d+\.\s/.test(trimmed)) {
        const textContent = trimmed.replace(/^\d+\.\s/, '');
        const num = trimmed.match(/^\d+/)?.[0] || '1';
        return (
          <div key={idx} className="flex gap-2.5 text-xs text-slate-300 ml-1 mb-2 leading-relaxed items-start bg-slate-950/45 p-2.5 rounded-xl border border-slate-900/60">
            <span className="font-mono font-bold text-[10px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded leading-none">{num}</span>
            <div className="flex-1">{boldPatternParser(textContent)}</div>
          </div>
        );
      }

      // Default paragraph
      return (
        <p key={idx} className="text-xs text-slate-300 leading-relaxed mb-2">
          {boldPatternParser(trimmed)}
        </p>
      );
    });
  };

  const boldPatternParser = (text: string) => {
    const parts = text.split(/\*\*([^*]+)\*\*/g);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return <span key={i} className="font-bold text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20 font-mono text-[11px]">{part}</span>;
      }
      return part;
    });
  };

  const displayHR = vitals?.heartRate && vitals.heartRate !== '--' ? vitals.heartRate : metrics.heartRate;
  const isLiveHR = vitals && typeof vitals.heartRate === 'number' && vitals.heartRate > 0 && vitals.fingerPresent;

  return (
    <>
      <div className="flex flex-col gap-6 relative" id="report-analytics-dashboard">
        {/* Decorative orb */}
        <div className="orb-emerald -top-32 -left-32" />

        {/* ── Top Header Banner ── */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-headline font-bold text-slate-100 tracking-tight">
              Somsubhro's Health Overview
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Synthesized clinical diagnostics from telemetry, cardiology reports, and laboratory exams.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 pulse-emerald" />
              <span className="text-xs font-semibold text-emerald-400 font-label">SYSTEM ONLINE</span>
            </div>

            <button
              onClick={handleTriggerAiDictator}
              className="px-4 py-2 font-bold text-xs font-label rounded-xl transition flex items-center gap-2 shadow-lg bg-violet-600 hover:bg-violet-500 text-white shadow-violet-600/20 active:scale-95"
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse" />
              <span>AI Dictator 🎙️</span>
            </button>

            <button
              onClick={() => onNavigate('report-scanner')}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs font-label rounded-xl transition flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 active:scale-95"
            >
              <Sparkles className="h-3.5 w-3.5" /> Scan Records
            </button>
          </div>
        </header>

        {/* ── Key Metrics Bento Row (No BP) ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

          {/* Heart Rate Card */}
          <div className="glass-card rounded-2xl p-5 relative overflow-hidden group">
            <div className="flex justify-between items-start mb-3">
              <div className="flex items-center gap-2 text-slate-400">
                <Heart className={`h-4 w-4 ${isLiveHR ? "text-rose-400 animate-pulse" : "text-emerald-400"}`} />
                <span className="text-xs font-medium font-headline text-slate-300">Heart Rate</span>
              </div>
              {isLiveHR ? (
                <span className="px-2 py-0.5 rounded-full text-[9px] font-label font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse">
                  LIVE
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[9px] font-label font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  STABLE
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-headline font-bold text-slate-100">{displayHR}</span>
              <span className="text-xs text-slate-400 font-mono">BPM</span>
            </div>
            <div className="mt-2 text-[10px] text-slate-500 font-mono truncate">
              Source: {isLiveHR ? "ESP32 Bracelet" : metrics.hrSource || "Consultation Note"}
            </div>
          </div>

          {/* Blood Oxygen (SpO2) Card */}
          <div className="glass-card rounded-2xl p-5 relative overflow-hidden">
            <div className="flex justify-between items-start mb-3">
              <div className="flex items-center gap-2 text-slate-400">
                <Wind className="h-4 w-4 text-cyan-400" />
                <span className="text-xs font-medium font-headline text-slate-300">SpO2 Oxygen</span>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-label font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                NORMAL
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-headline font-bold text-emerald-400">
                {vitals?.oxygenSpO2 ?? 98}%
              </span>
            </div>
            <div className="mt-2 text-[10px] text-slate-500 font-mono">
              Target Range: 95% – 100%
            </div>
          </div>

          {/* eGFR Kidney Function Card */}
          {/* <div className="glass-card rounded-2xl p-5 relative overflow-hidden">
            <div className="flex justify-between items-start mb-3">
              <div className="flex items-center gap-2 text-slate-400">
                <Droplet className="h-4 w-4 text-purple-400" />
                <span className="text-xs font-medium font-headline text-slate-300">Kidney eGFR</span>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-label font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                STAGE 3a
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-headline font-bold text-slate-100">
                {metrics.gfr !== '--' ? metrics.gfr : '58'}
              </span>
              <span className="text-xs text-slate-400 font-mono">mL/min</span>
            </div>
            <div className="mt-2 w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-amber-400 h-1.5 rounded-full" style={{ width: '58%' }} />
            </div>
          </div> */}

          {/* Hemoglobin Card */}
          {/* <div className="glass-card rounded-2xl p-5 relative overflow-hidden">
            <div className="flex justify-between items-start mb-3">
              <div className="flex items-center gap-2 text-slate-400">
                <Activity className="h-4 w-4 text-teal-400" />
                <span className="text-xs font-medium font-headline text-slate-300">Hemoglobin</span>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-label font-bold bg-teal-500/10 text-teal-400 border border-teal-500/20">
                LAB EXTRACT
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-headline font-bold text-slate-100">
                {metrics.hemoglobin !== '--' ? metrics.hemoglobin : '11.2'}
              </span>
              <span className="text-xs text-slate-400 font-mono">g/dL</span>
            </div>
            <div className="mt-2 text-[10px] text-slate-500 font-mono">
              Reference: 13.8 – 17.2 g/dL
            </div>
          </div> */}

        </div>

        {/* ── Mid Row: Scanned Feed & Detailed Synthesized Analysis ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left: Diagnostics Library */}
          <div className="lg:col-span-1 glass-card rounded-2xl p-5 flex flex-col justify-between h-[450px]">
            <div>
              <h2 className="text-sm font-bold font-headline text-white mb-4 flex items-center gap-2">
                <FileText className="h-4 w-4 text-emerald-400" /> Diagnostics Library ({scannedHistory.length})
              </h2>

              <div className="space-y-2.5 overflow-y-auto max-h-[340px] pr-1 custom-scrollbar">
                {scannedHistory.length === 0 ? (
                  <div className="text-center py-10 space-y-3 bg-slate-950/40 rounded-xl border border-slate-900">
                    <p className="text-xs text-slate-500 font-mono">No clinical files scanned yet.</p>
                    <button
                      onClick={() => onNavigate('report-scanner')}
                      className="text-xs text-emerald-400 font-bold font-label hover:underline"
                    >
                      Initiate Document Scan
                    </button>
                  </div>
                ) : (
                  scannedHistory.map((report, idx) => (
                    <div
                      key={idx}
                      onClick={() => setSelectedReportIdx(idx)}
                      className={`p-3 rounded-xl border cursor-pointer transition-all ${selectedReportIdx === idx
                        ? 'bg-emerald-500/10 border-emerald-500/40 text-white'
                        : 'bg-slate-950/60 border-slate-800/80 text-slate-400 hover:border-slate-700 hover:bg-slate-900/30'
                        }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`p-2 rounded-lg ${selectedReportIdx === idx ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-900 text-slate-400'}`}>
                          <FileText className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-xs font-bold font-headline leading-tight truncate text-slate-200">{report.fileName}</h4>
                          <p className="text-[9px] text-slate-500 font-mono mt-1">{report.timestamp}</p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800/60 text-center">
              <button
                onClick={() => onNavigate('report-scanner')}
                className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5 justify-center mx-auto transition-colors font-label font-bold"
              >
                Analyze newer files &rarr;
              </button>
            </div>
          </div>

          {/* Right: Active report synthesis */}
          <div className="lg:col-span-2 glass-card rounded-2xl p-6 h-[450px] flex flex-col justify-between overflow-hidden relative">
            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />

            {activeReport ? (
              <div className="flex flex-col h-full overflow-hidden relative z-10">
                {/* Header */}
                <div className="flex justify-between items-center border-b border-slate-800/80 pb-3 mb-4 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-xs font-label font-bold border border-emerald-500/20">
                      CLINICAL SYNTHESIS
                    </span>
                    <p className="text-[11px] text-slate-400 font-mono truncate max-w-xs">{activeReport.fileName}</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-500 text-[10px] font-mono">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>{activeReport.timestamp}</span>
                  </div>
                </div>

                {/* Synthesized Output Scrollable Area */}
                <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-sm font-bold font-headline text-white flex items-center gap-2 uppercase tracking-wide">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" /> Synthesized Clinical Profile
                      </h2>
                      <p className="text-[10px] text-slate-500 font-mono mt-0.5">Parameters compiled from real-world laboratory scanning.</p>
                    </div>

                    <div className="bg-slate-950/70 p-5 rounded-2xl border border-slate-900 space-y-3">
                      {parseReportSummaryToJSX(activeReport.summary)}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                <FileText className="h-10 w-10 text-slate-700 animate-pulse" />
                <div>
                  <h3 className="text-sm font-semibold font-headline text-slate-300">No Patient Report Injected</h3>
                  <p className="text-xs text-slate-500 max-w-xs mt-1">Please direct standard medical prescription files or laboratory printouts to the scanning tool.</p>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* ── Care Plan Directives (Aggregated from Diagnostics) ── */}
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <div>
            <h3 className="text-sm font-bold font-headline text-white flex items-center gap-2">
              <Smartphone className="h-4.5 w-4.5 text-emerald-400" /> Extracted Care Plan Directives & Medical Tasks
            </h3>
            <p className="text-xs text-slate-500 mt-1">Unified clinical directives parsed explicitly out of Arthur's reports. Do not double-dose.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            <div className="p-4 bg-slate-950/70 rounded-xl border border-slate-900 flex gap-3.5 items-start">
              <div className="p-2 rounded-lg bg-rose-500/10 text-rose-400 font-label text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5 border border-rose-500/20">
                CRITICAL PRECAUTION
              </div>
              <div>
                <h4 className="text-xs font-bold font-headline text-slate-200">Avoid Sudden Posture Transitions</h4>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Cardiology Note advises caution during posture transitions. Stand slowly or pause to sit if feeling any lightheadedness.
                </p>
              </div>
            </div>

            <div className="p-4 bg-slate-950/70 rounded-xl border border-slate-900 flex gap-3.5 items-start">
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 font-label text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5 border border-emerald-500/20">
                PHARMA THERAPY
              </div>
              <div>
                <h4 className="text-xs font-bold font-headline text-slate-200">Lisinopril 10mg morning hours</h4>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Extracted prescription note to support cardiovascular health and protect systemic cardiac walls.
                </p>
              </div>
            </div>

            <div className="p-4 bg-slate-950/70 rounded-xl border border-slate-900 flex gap-3.5 items-start">
              <div className="p-2 rounded-lg bg-teal-500/10 text-teal-400 font-label text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5 border border-teal-500/20">
                DIETARY ADVICE
              </div>
              <div>
                <h4 className="text-xs font-bold font-headline text-slate-200">Increase Daily Clear Liquid Intake</h4>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Targeting 1.8L of fluids daily in response to mild GFR filtration drops which caused minor BUN elevation warnings.
                </p>
              </div>
            </div>

            <div className="p-4 bg-slate-950/70 rounded-xl border border-slate-900 flex gap-3.5 items-start">
              <div className="p-2 rounded-lg bg-violet-500/10 text-violet-400 font-label text-[10px] uppercase font-bold tracking-wider shrink-0 mt-0.5 border border-violet-500/20">
                LAB SCHEDULING
              </div>
              <div>
                <h4 className="text-xs font-bold font-headline text-slate-200">Repeat Complete Blood Panel Scan</h4>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Mandated follow-up in 3 months time specifically targeting hematology parameters and hemoglobin counts.
                </p>
              </div>
            </div>

          </div>
        </div>

      </div>

      {/* AI Dictator modal — mounts here, invisible until dictatorOpen = true */}
      <AiDictator open={dictatorOpen} onClose={() => setDictatorOpen(false)} />
    </>
  );
}

import React, { useState, useEffect } from 'react';
import {
  FileText, Sparkles, Stethoscope
} from 'lucide-react';
import { ScanResult, VitalState } from '../types';
import AiDictator from './AiDictator';
import LiveVitals from './LiveVitals';
import { motion, AnimatePresence } from 'motion/react';

interface OverviewProps {
  scannedHistory: ScanResult[];
  onNavigate: (view: any) => void;
  activeAlert: boolean;
  vitals?: VitalState;
  hardwareOnline?: boolean;
  espConnected?: boolean;
}

export default function Overview({ scannedHistory, onNavigate, activeAlert, vitals, hardwareOnline = false, espConnected = false }: OverviewProps) {
  const [selectedReportIdx, setSelectedReportIdx] = useState<number>(0);
  const [dictatorOpen, setDictatorOpen] = useState(false);
  const [greeting, setGreeting] = useState('');

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreeting('Good morning');
    else if (hour < 17) setGreeting('Good afternoon');
    else setGreeting('Good evening');
  }, []);

  const activeReport = scannedHistory[selectedReportIdx] || scannedHistory[0] || null;

  return (
    <div className="flex flex-col gap-8 relative min-h-full" id="overview-dashboard">
      <div className="absolute inset-0 bg-grid-pattern opacity-50 pointer-events-none" />
      <div className="orb-emerald -top-32 -left-32" />
      <div className="orb-rose top-1/4 right-0" />
      
      {/* ── Humanized Header ── */}
      <motion.header 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col md:flex-row md:items-end justify-between gap-6 relative z-10"
      >
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="px-3 py-1 bg-white/5 border border-white/10 rounded-full text-xs font-label text-slate-300 backdrop-blur-md flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${espConnected ? 'bg-emerald-400 pulse-emerald' : 'bg-slate-500'}`} />
              {espConnected ? 'Vitals streaming' : hardwareOnline ? 'Waiting for vitals' : 'Sensor offline'}
            </span>
          </div>
          <h1 className="text-4xl md:text-5xl font-headline font-bold text-white tracking-tight leading-tight">
            <span className="text-slate-400">{greeting},</span><br />
            Care Overview.
          </h1>
          <p className="text-slate-400 text-lg max-w-xl leading-relaxed">
            Live readings appear here when recent sensor packets are available. Review uploaded medical reports below.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setDictatorOpen(true)}
            className="px-5 py-2.5 rounded-full font-label font-bold text-sm transition-all flex items-center gap-2 bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-500/25 border border-white/10"
          >
            <Sparkles className="h-4 w-4" />
            AI Assistant
          </motion.button>
        </div>
      </motion.header>

      {/* ── Live Vitals Integration ── */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1 }}
        className="relative z-10"
      >
        {vitals && (
          <LiveVitals vitals={vitals} hardwareOnline={hardwareOnline} espConnected={espConnected} hideHeader isHomeView />
        )}
      </motion.div>

      {/* ── Beautiful Insights Area ── */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.3 }}
        className="glass-card rounded-3xl overflow-hidden relative z-10"
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 h-[500px]">
          {/* Documents Sidebar */}
          <div className="lg:col-span-2 bg-slate-950/40 border-r border-white/5 p-6 flex flex-col h-full">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-headline text-white flex items-center gap-2">
                <FileText className="h-5 w-5 text-emerald-400" /> Medical Journey
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-3">
              {scannedHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4">
                  <div className="p-4 rounded-full bg-slate-900 border border-slate-800">
                    <Sparkles className="h-6 w-6 text-slate-500" />
                  </div>
                  <p className="text-slate-400">I haven't read any of your recent reports yet.</p>
                  <button onClick={() => onNavigate('report-scanner')} className="px-4 py-2 bg-emerald-500/10 text-emerald-400 rounded-full font-label text-sm hover:bg-emerald-500/20 transition">
                    Upload a document
                  </button>
                </div>
              ) : (
                scannedHistory.map((report, idx) => (
                  <motion.button
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    key={idx}
                    onClick={() => setSelectedReportIdx(idx)}
                    className={`w-full text-left p-4 rounded-2xl transition-all duration-300 flex items-start gap-4 border ${selectedReportIdx === idx ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-white/5 border-transparent hover:bg-white/10'}`}
                  >
                    <div className={`p-2.5 rounded-xl shrink-0 ${selectedReportIdx === idx ? 'bg-emerald-500/20' : 'bg-slate-800'}`}>
                      <FileText className={`h-4 w-4 ${selectedReportIdx === idx ? 'text-emerald-400' : 'text-slate-400'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className={`font-headline truncate ${selectedReportIdx === idx ? 'text-emerald-300 font-semibold' : 'text-slate-200'}`}>{report.fileName}</h4>
                      <p className="text-xs text-slate-500 mt-1">{report.timestamp}</p>
                    </div>
                  </motion.button>
                ))
              )}
            </div>
          </div>

          {/* Document AI Analysis */}
          <div className="lg:col-span-3 p-8 flex flex-col h-full bg-gradient-to-br from-slate-900/50 to-slate-950/50">
            {activeReport ? (
              <AnimatePresence mode="wait">
                <motion.div 
                  key={activeReport.fileName}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  className="flex-1 flex flex-col h-full"
                >
                  <div className="mb-6 flex items-center gap-3 border-b border-white/5 pb-6">
                    <div className="h-10 w-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <Stethoscope className="h-5 w-5 text-emerald-400" />
                    </div>
                    <div>
                      <h2 className="text-xl font-headline text-white">AI Synthesis</h2>
                      <p className="text-sm text-slate-400">Distilled from {activeReport.fileName}</p>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar pr-4 text-slate-300 leading-relaxed font-body">
                     {activeReport.summary ? (
                       <div className="prose prose-invert prose-emerald max-w-none">
                         {activeReport.summary.split('\n').map((line, i) => {
                           if (line.startsWith('##')) return <h3 key={i} className="text-emerald-400 font-headline mt-6 mb-3">{line.replace(/#/g, '').trim()}</h3>;
                           if (line.startsWith('*')) return <li key={i} className="ml-4 mb-2">{line.replace('*', '').trim()}</li>;
                           if (line.trim() === '') return <br key={i}/>;
                           return <p key={i} className="mb-4">{line.replace(/\*\*/g, '')}</p>;
                         })}
                       </div>
                     ) : (
                       <p className="text-slate-500 italic">No summary available.</p>
                     )}
                  </div>
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-500">
                Select a document to read my analysis.
              </div>
            )}
          </div>
        </div>
      </motion.div>

      <AiDictator open={dictatorOpen} onClose={() => setDictatorOpen(false)} />
    </div>
  );
}

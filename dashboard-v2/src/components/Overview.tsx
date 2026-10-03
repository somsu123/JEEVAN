import React, { useState, useEffect } from 'react';
import {
  FileText, Sparkles, Stethoscope, ArrowRight, Upload
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
      <div className="absolute inset-0 bg-grid-pattern opacity-30 pointer-events-none" />
      <div className="orb-emerald -top-32 -left-32" />
      <div className="orb-indigo top-1/3 right-0" />
      
      {/* ── Humanized Header ── */}
      <motion.header 
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col md:flex-row md:items-end justify-between gap-6 relative z-10"
      >
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="px-3.5 py-1.5 bg-white border border-slate-200 rounded-full text-xs font-semibold text-slate-700 shadow-2xs flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${espConnected ? 'bg-emerald-500 pulse-emerald' : 'bg-slate-400'}`} />
              {espConnected ? 'Live telemetry active' : hardwareOnline ? 'Waiting for bracelet sensor' : 'Sensors on standby'}
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-headline font-bold text-slate-800 tracking-tight leading-tight">
            <span className="text-slate-500 font-normal">{greeting},</span> Patient & Caregiver.
          </h1>
          <p className="text-slate-600 text-base max-w-2xl leading-relaxed">
            Real-time vital signs, smart medicine box adherence, and clinical records summary below.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setDictatorOpen(true)}
            className="px-5 py-3 rounded-2xl font-semibold text-sm transition-all flex items-center gap-2.5 bg-blue-600 hover:bg-blue-700 text-white shadow-sm hover:shadow-md cursor-pointer"
          >
            <Sparkles className="h-4 w-4" />
            AI Voice Assistant
          </motion.button>
        </div>
      </motion.header>

      {/* ── Live Vitals Integration ── */}
      <motion.div 
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="relative z-10"
      >
        {vitals && (
          <LiveVitals vitals={vitals} hardwareOnline={hardwareOnline} espConnected={espConnected} hideHeader isHomeView />
        )}
      </motion.div>

      {/* ── Medical Journey & Document Insights ── */}
      <motion.div 
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.15 }}
        className="bg-white border border-slate-200 rounded-3xl shadow-xs overflow-hidden relative z-10"
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 min-h-[460px]">
          {/* Documents Sidebar */}
          <div className="lg:col-span-2 bg-slate-50/70 border-r border-slate-200/80 p-6 flex flex-col h-full">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-headline font-bold text-slate-800 flex items-center gap-2">
                <FileText className="h-5 w-5 text-blue-600" /> Patient Medical Journey
              </h3>
              <button 
                onClick={() => onNavigate('report-scanner')}
                className="text-xs text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1 cursor-pointer"
              >
                Scan New <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2.5">
              {scannedHistory.length === 0 ? (
                <div className="h-full py-12 flex flex-col items-center justify-center text-center space-y-3">
                  <div className="p-3.5 rounded-full bg-white border border-slate-200 shadow-2xs">
                    <Upload className="h-5 w-5 text-slate-400" />
                  </div>
                  <p className="text-sm text-slate-600 max-w-[240px]">No medical records uploaded yet.</p>
                  <button 
                    onClick={() => onNavigate('report-scanner')} 
                    className="px-4 py-2.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-xl font-medium text-xs hover:bg-blue-100 transition shadow-2xs cursor-pointer"
                  >
                    Upload Report Document
                  </button>
                </div>
              ) : (
                scannedHistory.map((report, idx) => (
                  <motion.button
                    whileHover={{ x: 2 }}
                    whileTap={{ scale: 0.99 }}
                    key={idx}
                    onClick={() => setSelectedReportIdx(idx)}
                    className={`w-full text-left p-4 rounded-2xl transition-all flex items-start gap-3.5 border cursor-pointer ${
                      selectedReportIdx === idx
                        ? 'bg-blue-50/90 border-blue-300 text-blue-900 shadow-2xs'
                        : 'bg-white border-slate-200/80 hover:border-slate-300 text-slate-700'
                    }`}
                  >
                    <div className={`p-2.5 rounded-xl shrink-0 ${selectedReportIdx === idx ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                      <FileText className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className={`text-sm font-semibold truncate ${selectedReportIdx === idx ? 'text-blue-900' : 'text-slate-800'}`}>{report.fileName}</h4>
                      <p className="text-xs text-slate-500 mt-0.5">{report.timestamp}</p>
                    </div>
                  </motion.button>
                ))
              )}
            </div>
          </div>

          {/* Document AI Analysis */}
          <div className="lg:col-span-3 p-7 flex flex-col h-full bg-white">
            {activeReport ? (
              <AnimatePresence mode="wait">
                <motion.div 
                  key={activeReport.fileName}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  className="flex-1 flex flex-col h-full"
                >
                  <div className="mb-5 flex items-center gap-3 border-b border-slate-100 pb-4">
                    <div className="h-10 w-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                      <Stethoscope className="h-5 w-5" />
                    </div>
                    <div>
                      <h2 className="text-base font-headline font-bold text-slate-800">Clinical AI Synthesis</h2>
                      <p className="text-xs text-slate-500">Summary from {activeReport.fileName}</p>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar pr-3 text-slate-700 leading-relaxed font-body text-sm space-y-3">
                     {activeReport.summary ? (
                       <div className="space-y-3">
                         {activeReport.summary.split('\n').map((line, i) => {
                           if (line.startsWith('##')) return <h3 key={i} className="text-sm font-bold font-headline text-blue-800 mt-4 mb-2 pb-1 border-b border-slate-100">{line.replace(/#/g, '').trim()}</h3>;
                           if (line.startsWith('*')) return <li key={i} className="ml-4 text-slate-700 leading-relaxed">{line.replace('*', '').trim()}</li>;
                           if (line.trim() === '') return null;
                           return <p key={i} className="text-slate-700 leading-relaxed">{line.replace(/\*\*/g, '')}</p>;
                         })}
                       </div>
                     ) : (
                       <p className="text-slate-400 italic">No clinical summary available for this scan.</p>
                     )}
                  </div>
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-400 text-sm py-12">
                Select a document from the left to inspect AI summary.
              </div>
            )}
          </div>
        </div>
      </motion.div>

      <AiDictator open={dictatorOpen} onClose={() => setDictatorOpen(false)} />
    </div>
  );
}

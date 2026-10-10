import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Mic, MicOff, Send, Volume2, VolumeX, Stethoscope, Brain,
  MessageSquare, RefreshCw, AlertCircle, CheckCircle2, Heart,
  Pill, Clock, FileText, Sparkles, Activity
} from 'lucide-react';
import { AiDictatorMessage } from '../types';

interface AiDictatorProps {
  open: boolean;
  onClose: () => void;
}

type Phase = 'idle' | 'loading' | 'briefing' | 'qa';

export default function AiDictator({ open, onClose }: AiDictatorProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [summary, setSummary] = useState('');
  const [analytics, setAnalytics] = useState<Record<string, any> | null>(null);
  const [vitals, setVitals] = useState<Record<string, any> | null>(null);
  const [medbox, setMedbox] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [messages, setMessages] = useState<AiDictatorMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [qaError, setQaError] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const recognitionRef = useRef<any>(null);

  // ── Auto-scroll chat ──────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAsking]);

  // ── Focus input when entering Q&A ─────────────────────────────────────────
  useEffect(() => {
    if (phase === 'qa') {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [phase]);

  // ── Cleanup TTS & Speech Recognition on unmount / close ──────────────────
  useEffect(() => {
    if (!open) {
      stopSpeaking();
      stopListening();
      setPhase('idle');
      setSummary('');
      setMessages([]);
      setError('');
      setAnalytics(null);
      setVitals(null);
      setMedbox(null);
    }
  }, [open]);

  // ── Browser TTS helper ───────────────────────────────────────────────────
  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!('speechSynthesis' in window)) return;
    stopSpeaking();

    // Clean any accidental markdown or symbols from speech text
    const cleanText = text.replace(/[*#_`[\]]/g, '').trim();
    const utt = new SpeechSynthesisUtterance(cleanText);

    // Pick the best available English voice (prefer natural clinical English voice)
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(
      (v) =>
        v.lang.startsWith('en') &&
        (v.name.includes('Natural') ||
          v.name.includes('Google') ||
          v.name.includes('Microsoft') ||
          v.name.includes('Samantha') ||
          v.name.includes('Daniel'))
    );
    if (preferred) utt.voice = preferred;

    utt.rate = 0.92;   // natural, clear clinical tempo
    utt.pitch = 1.0;
    utt.volume = 1.0;

    utt.onstart = () => setIsSpeaking(true);
    utt.onend = () => {
      setIsSpeaking(false);
      onEnd?.();
    };
    utt.onerror = () => setIsSpeaking(false);

    utteranceRef.current = utt;
    window.speechSynthesis.speak(utt);
  }, []);

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    setIsSpeaking(false);
  }, []);

  // ── Speech Recognition (Voice-to-Text) ──────────────────────────────────
  const startListening = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setQaError('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
      return;
    }

    try {
      stopSpeaking();
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setQaError('');
      };

      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((r: any) => (r as any)[0].transcript)
          .join('');
        setQuestion(transcript);
      };

      recognition.onerror = (event: any) => {
        console.warn('Speech recognition error:', event.error);
        setIsListening(false);
        if (event.error !== 'no-speech') {
          setQaError(`Microphone error: ${event.error}`);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      console.error('Speech recognition initiation failed:', err);
      setIsListening(false);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch { }
      recognitionRef.current = null;
    }
    setIsListening(false);
  };

  // ── Trigger Local AI clinical summary (MongoDB + Ollama) ─────────────────
  const triggerDictation = async () => {
    setPhase('loading');
    setError('');
    setSummary('');
    setAnalytics(null);
    setVitals(null);
    setMedbox(null);
    setMessages([]);
    stopSpeaking();
    stopListening();

    try {
      const res = await fetch('/api/ai-dictator/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate clinical summary from MongoDB.');
      }

      setSummary(data.summary);
      setAnalytics(data.analytics || null);
      setVitals(data.vitals || null);
      setMedbox(data.medbox || null);
      setPhase('briefing');

      // Add summary as first assistant message
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      setMessages([{ role: 'assistant', text: data.summary, timestamp: ts }]);

      // Speak the summary, then enter Q&A mode
      speak(data.summary, () => setPhase('qa'));
    } catch (err: any) {
      setError(err.message || 'Unknown error');
      setPhase('idle');
    }
  };

  // ── Ask Doctor Q&A Query (Local Ollama) ──────────────────────────────────
  const handleAskQuery = async (queryText: string) => {
    if (!queryText.trim() || isAsking) return;

    const q = queryText.trim();
    setQuestion('');
    setQaError('');
    setIsAsking(true);
    stopSpeaking();
    stopListening();

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    setMessages((prev) => [...prev, { role: 'doctor', text: q, timestamp: ts }]);

    try {
      const res = await fetch('/api/ai-dictator/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to get answer from Ollama LLM.');
      }

      const ansTs = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      setMessages((prev) => [...prev, { role: 'assistant', text: data.answer, timestamp: ansTs }]);
      speak(data.answer);
    } catch (err: any) {
      setQaError(err.message || 'Error fetching clinical answer.');
    } finally {
      setIsAsking(false);
    }
  };

  const askQuestion = (e: React.FormEvent) => {
    e.preventDefault();
    handleAskQuery(question);
  };

  // Quick-question suggestions tailored for Hackathon Demo
  const SUGGESTIONS = [
    { label: '💊 Medicines Taken & Missed', q: 'What medicines were taken and missed today in the smart medicine box?' },
    { label: '❤️ Average Heart Rate Today', q: 'What is the average BPM and SpO2 observed today?' },
    { label: '⏱️ Medicine Box Timeouts', q: 'What are the configured slot timeouts and schedule in the medicine box?' },
    { label: '📋 Latest Prescription & Lab Reports', q: 'Summarize the latest digitized prescription and lab test reports.' },
    { label: '📊 Full Health & Adherence Report', q: 'Provide a comprehensive daily clinical report on vitals and medication adherence.' },
  ];

  if (!open) return null;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 transition-all"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel */}
      <div
        className="relative w-full max-w-3xl bg-white border border-slate-200 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        style={{ maxHeight: '92vh', height: '820px' }}
      >

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-linear-to-r from-blue-50/50 via-white to-indigo-50/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-600 text-white shadow-md shadow-blue-500/20">
              <Brain className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900 tracking-wide">MITRA AI VOICE HEALTH ASSISTANT</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200">
                  OLLAMA LLM · MONGODB
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Real-time voice briefing on Medicine Box adherence, BPM vitals, and Prescriptions
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Speaking indicator */}
            {isSpeaking && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-200 animate-pulse">
                <Volume2 className="h-3.5 w-3.5 text-blue-600 animate-bounce" />
                <span className="text-[10px] text-blue-700 font-bold uppercase tracking-wider">SPEAKING AUDIO</span>
              </div>
            )}
            {/* Listening indicator */}
            {isListening && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-50 border border-rose-200 animate-pulse">
                <Mic className="h-3.5 w-3.5 text-rose-600" />
                <span className="text-[10px] text-rose-700 font-bold uppercase tracking-wider">LISTENING...</span>
              </div>
            )}
            <button
              onClick={isSpeaking ? stopSpeaking : undefined}
              disabled={!isSpeaking}
              className={`p-2 rounded-xl border transition cursor-pointer ${
                isSpeaking
                  ? 'bg-rose-50 border-rose-200 text-rose-600 hover:bg-rose-100'
                  : 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed opacity-60'
              }`}
              title={isSpeaking ? 'Stop speaking audio' : 'Audio idle'}
            >
              {isSpeaking ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-500 hover:text-slate-800 transition cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Live Telemetry & Schema Strip (MongoDB Snapshot) ─────────────────── */}
        {analytics && (
          <div className="grid grid-cols-4 gap-px bg-slate-100 border-b border-slate-200 shrink-0">
            <div className="bg-white px-4 py-2.5 text-center">
              <div className="flex items-center justify-center gap-1 text-slate-500 mb-0.5">
                <Heart className="h-3 w-3 text-rose-500" />
                <p className="text-[10px] font-bold uppercase tracking-wider">AVG BPM & SpO2</p>
              </div>
              <p className="text-sm font-bold text-slate-900">
                {analytics.avgBpm !== null ? (
                  <>
                    {analytics.avgBpm} <span className="text-xs font-normal text-slate-500">BPM</span>
                    {analytics.avgSpo2 !== null ? ` · ${analytics.avgSpo2}%` : ''}
                  </>
                ) : (
                  <span className="text-xs font-normal text-slate-400">Awaiting Telemetry</span>
                )}
              </p>
            </div>
            <div className="bg-white px-4 py-2.5 text-center">
              <div className="flex items-center justify-center gap-1 text-slate-500 mb-0.5">
                <Pill className="h-3 w-3 text-blue-500" />
                <p className="text-[10px] font-bold uppercase tracking-wider">MED ADHERENCE</p>
              </div>
              <p className="text-sm font-bold text-emerald-600">
                {analytics.adherencePct !== null ? (
                  <>
                    {analytics.adherencePct}% <span className="text-[11px] font-medium text-slate-500">({analytics.dosesTaken ?? 0} Taken)</span>
                  </>
                ) : (
                  <span className="text-xs font-normal text-slate-400">No Schedule</span>
                )}
              </p>
            </div>
            <div className="bg-white px-4 py-2.5 text-center">
              <div className="flex items-center justify-center gap-1 text-slate-500 mb-0.5">
                <Clock className="h-3 w-3 text-amber-500" />
                <p className="text-[10px] font-bold uppercase tracking-wider">MEDBOX SLOTS</p>
              </div>
              <p className="text-sm font-bold text-slate-900">
                {analytics.totalSlots ?? 0} <span className="text-xs font-normal text-slate-500">Active Slots</span>
              </p>
            </div>
            <div className="bg-white px-4 py-2.5 text-center">
              <div className="flex items-center justify-center gap-1 text-slate-500 mb-0.5">
                <FileText className="h-3 w-3 text-indigo-500" />
                <p className="text-[10px] font-bold uppercase tracking-wider">RECORDS ON FILE</p>
              </div>
              <p className="text-sm font-bold text-slate-900">
                {analytics.totalPrescriptions ?? 0} <span className="text-xs font-normal text-slate-500">Rx</span> · {analytics.totalReports ?? 0} <span className="text-xs font-normal text-slate-500">Labs</span>
              </p>
            </div>
          </div>
        )}

        {/* ── Main content area ────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0 bg-slate-50/40">

          {/* IDLE — Call-to-action */}
          {phase === 'idle' && (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-6">
              <div className="relative">
                <div className="h-24 w-24 rounded-3xl bg-linear-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
                  <Stethoscope className="h-11 w-11 text-white" />
                </div>
                <span className="absolute -top-1.5 -right-1.5 h-6 w-6 bg-emerald-500 rounded-full border-2 border-white flex items-center justify-center shadow-xs animate-pulse">
                  <Sparkles className="h-3.5 w-3.5 text-white" />
                </span>
              </div>
              <div>
                <h3 className="text-2xl font-bold text-slate-900 font-headline">Clinical Voice Assistant Ready</h3>
                <p className="text-sm text-slate-600 mt-2 max-w-md leading-relaxed">
                  Mitra automatically fetches patient records from MongoDB — including today's average BPM & SpO2 readings, Smart Medicine Box doses and timeouts, and clinical prescriptions — then speaks the report aloud via Local Ollama.
                </p>
              </div>

              {/* Quick Feature Highlights */}
              <div className="grid grid-cols-3 gap-3 max-w-lg w-full text-left">
                <div className="p-3 bg-white border border-slate-200 rounded-2xl shadow-2xs">
                  <div className="flex items-center gap-1.5 text-blue-600 font-bold text-xs mb-1">
                    <Activity className="h-3.5 w-3.5" /> BPM Telemetry
                  </div>
                  <p className="text-[11px] text-slate-500">Daily average pulse & continuous SpO2 readings.</p>
                </div>
                <div className="p-3 bg-white border border-slate-200 rounded-2xl shadow-2xs">
                  <div className="flex items-center gap-1.5 text-emerald-600 font-bold text-xs mb-1">
                    <Pill className="h-3.5 w-3.5" /> Medicine Box
                  </div>
                  <p className="text-[11px] text-slate-500">Doses taken, missed, 1-10m timeouts, and compliance.</p>
                </div>
                <div className="p-3 bg-white border border-slate-200 rounded-2xl shadow-2xs">
                  <div className="flex items-center gap-1.5 text-indigo-600 font-bold text-xs mb-1">
                    <FileText className="h-3.5 w-3.5" /> Rx & Lab Tests
                  </div>
                  <p className="text-[11px] text-slate-500">Digitized prescriptions & clinical biomarker findings.</p>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 px-4 py-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 max-w-md">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-500" />
                  <span>{error}</span>
                </div>
              )}

              <button
                onClick={triggerDictation}
                className="px-8 py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl text-sm transition shadow-lg shadow-blue-500/25 flex items-center gap-2.5 cursor-pointer transform hover:scale-[1.02] active:scale-[0.98]"
              >
                <Brain className="h-4 w-4" />
                Generate & Speak Clinical Briefing
              </button>
            </div>
          )}

          {/* LOADING */}
          {phase === 'loading' && (
            <div className="flex-1 flex flex-col items-center justify-center p-10 space-y-6">
              {/* Dynamic Animated waveform */}
              <div className="flex items-end gap-1.5 h-16">
                {Array.from({ length: 16 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-2 bg-linear-to-t from-blue-600 to-indigo-500 rounded-full"
                    style={{
                      height: `${18 + Math.sin(i * 0.7) * 22}px`,
                      animation: `pulse 0.7s ease-in-out ${i * 0.05}s infinite alternate`,
                    }}
                  />
                ))}
              </div>
              <div className="text-center space-y-1">
                <p className="text-base font-bold text-slate-800">FETCHING MONGODB SCHEMAS & VITALS...</p>
                <p className="text-xs text-slate-500">
                  Synthesizing medicine box intake logs, average BPM, and prescriptions with Ollama LLM
                </p>
              </div>
            </div>
          )}

          {/* BRIEFING & Q&A MODE */}
          {(phase === 'briefing' || phase === 'qa') && (
            <div className="flex-1 flex flex-col min-h-0">
              
              {/* Chat & Audio Timeline */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
                {messages.map((msg, idx) => (
                  <div key={idx} className={`flex gap-3 ${msg.role === 'doctor' ? 'flex-row-reverse' : ''}`}>
                    <div className={`p-2.5 rounded-2xl shrink-0 mt-0.5 shadow-2xs ${
                      msg.role === 'assistant'
                        ? 'bg-blue-600 text-white shadow-blue-500/20'
                        : 'bg-slate-200 text-slate-700'
                    }`}>
                      {msg.role === 'assistant' ? <Brain className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
                    </div>
                    <div className={`max-w-[85%] rounded-3xl p-4 shadow-xs transition-all ${
                      msg.role === 'assistant'
                        ? 'bg-white border border-slate-200/80 text-slate-800'
                        : 'bg-blue-600 text-white'
                    }`}>
                      <div className="flex items-center justify-between gap-2 mb-1.5 pb-1 border-b border-slate-100/60">
                        <span className={`text-[11px] font-bold uppercase tracking-wider ${
                          msg.role === 'assistant' ? 'text-blue-700' : 'text-blue-100'
                        }`}>
                          {msg.role === 'assistant' ? 'MITRA AI CLINICAL BRIEFING' : 'DOCTOR / USER QUERY'}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] ${msg.role === 'assistant' ? 'text-slate-400' : 'text-blue-200'}`}>
                            {msg.timestamp}
                          </span>
                          {msg.role === 'assistant' && (
                            <button
                              onClick={() => speak(msg.text)}
                              className="p-1 rounded-lg hover:bg-blue-50 text-blue-600 transition cursor-pointer"
                              title="Re-play audio"
                            >
                              <Volume2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      <p className={`text-sm leading-relaxed ${msg.role === 'assistant' ? 'text-slate-700 font-normal' : 'text-white'}`}>
                        {msg.text}
                      </p>
                    </div>
                  </div>
                ))}

                {/* Asking Indicator */}
                {isAsking && (
                  <div className="flex gap-3">
                    <div className="p-2.5 rounded-2xl bg-blue-600 text-white shadow-xs mt-0.5">
                      <Brain className="h-4 w-4" />
                    </div>
                    <div className="bg-white border border-slate-200 rounded-3xl px-5 py-4 shadow-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500 font-medium mr-2">Mitra is consulting MongoDB & Ollama...</span>
                        <div className="h-2 w-2 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="h-2 w-2 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="h-2 w-2 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Speaking Waveform Banner */}
                {isSpeaking && (
                  <div className="p-3 rounded-2xl bg-blue-50/80 border border-blue-200 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs font-bold text-blue-700">
                      <Volume2 className="h-4 w-4 text-blue-600 animate-bounce" />
                      <span>Speaking live clinical voice output...</span>
                    </div>
                    <div className="flex items-center gap-1 h-6">
                      {Array.from({ length: 14 }).map((_, i) => (
                        <div
                          key={i}
                          className="w-1.5 bg-blue-600 rounded-full"
                          style={{
                            height: `${8 + Math.sin(Date.now() / 200 + i) * 6}px`,
                            animation: `pulse ${0.4 + (i % 4) * 0.1}s ease-in-out ${i * 0.04}s infinite alternate`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              {/* Quick Hackathon Demo Question Chips */}
              <div className="px-5 pt-2 pb-1 border-t border-slate-100 bg-white/70 shrink-0">
                <p className="text-[10px] text-slate-500 font-bold mb-1.5 uppercase tracking-wider flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-blue-600" /> Interactive Voice & Telemetry Queries
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleAskQuery(item.q)}
                      disabled={isAsking}
                      className="text-xs px-3 py-1.5 rounded-xl bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 text-slate-700 hover:text-blue-800 transition font-medium cursor-pointer shadow-2xs disabled:opacity-50 flex items-center gap-1"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Error Display */}
              {qaError && (
                <div className="mx-5 my-1 flex items-center gap-2 px-3 py-2 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 shrink-0">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                  <span>{qaError}</span>
                </div>
              )}

              {/* Voice & Text Input Bar */}
              <div className="p-4 pt-2 border-t border-slate-100 bg-white shrink-0">
                <form onSubmit={askQuestion} className="flex items-center gap-2">
                  {/* Microphone speech-to-text toggle */}
                  <button
                    type="button"
                    onClick={isListening ? stopListening : startListening}
                    disabled={isAsking}
                    className={`p-3 rounded-2xl border transition flex items-center justify-center shrink-0 cursor-pointer shadow-2xs ${
                      isListening
                        ? 'bg-rose-500 border-rose-600 text-white animate-pulse shadow-rose-500/30'
                        : 'bg-slate-100 hover:bg-blue-50 border-slate-200 hover:border-blue-300 text-slate-700 hover:text-blue-700'
                    }`}
                    title={isListening ? 'Stop listening' : 'Speak query via microphone'}
                  >
                    {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </button>

                  {/* Input field */}
                  <input
                    ref={inputRef}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder={
                      isListening
                        ? 'Listening to your voice... speak now...'
                        : 'Ask Mitra about medicines, average BPM, timeouts, prescriptions...'
                    }
                    disabled={isAsking}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 transition disabled:opacity-50"
                  />

                  {/* Send button */}
                  <button
                    type="submit"
                    disabled={!question.trim() || isAsking}
                    className="px-5 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-2xl font-semibold transition flex items-center gap-1.5 shrink-0 shadow-md shadow-blue-500/20 cursor-pointer"
                  >
                    {isAsking ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer Status Bar ─────────────────────────────────────────────────── */}
        {(phase === 'briefing' || phase === 'qa') && (
          <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-slate-600 font-medium">
                {phase === 'briefing' ? 'Mitra spoken briefing ready' : `Interactive Q&A active · ${messages.length - 1} question${messages.length - 1 !== 1 ? 's' : ''} answered`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={triggerDictation}
                className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-600 font-semibold transition cursor-pointer"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-generate Briefing
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pulse keyframe for audio waveforms */}
      <style>{`
        @keyframes pulse {
          from { opacity: 0.4; transform: scaleY(0.5); }
          to   { opacity: 1.0; transform: scaleY(1.0); }
        }
      `}</style>
    </div>
  );
}


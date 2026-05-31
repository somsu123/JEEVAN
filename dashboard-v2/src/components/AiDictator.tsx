import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Mic, MicOff, Send, Volume2, VolumeX, Stethoscope, Brain, MessageSquare, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { AiDictatorMessage } from '../types';

interface AiDictatorProps {
  open: boolean;
  onClose: () => void;
}

type Phase = 'idle' | 'loading' | 'briefing' | 'qa';

export default function AiDictator({ open, onClose }: AiDictatorProps) {
  const [phase, setPhase]           = useState<Phase>('idle');
  const [summary, setSummary]       = useState('');
  const [analytics, setAnalytics]   = useState<Record<string, any> | null>(null);
  const [error, setError]           = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages]     = useState<AiDictatorMessage[]>([]);
  const [question, setQuestion]     = useState('');
  const [isAsking, setIsAsking]     = useState(false);
  const [qaError, setQaError]       = useState('');

  const chatEndRef   = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLInputElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // ── Auto-scroll chat ──────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Focus input when entering Q&A ─────────────────────────────────────────
  useEffect(() => {
    if (phase === 'qa') {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [phase]);

  // ── Cleanup TTS on unmount / close ────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      stopSpeaking();
      setPhase('idle');
      setSummary('');
      setMessages([]);
      setError('');
      setAnalytics(null);
    }
  }, [open]);

  // ── Browser TTS helper ───────────────────────────────────────────────────
  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!('speechSynthesis' in window)) return;
    stopSpeaking();

    const utt = new SpeechSynthesisUtterance(text);

    // Pick the best available English voice (prefer Microsoft/Google high-quality)
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(
      (v) =>
        v.lang.startsWith('en') &&
        (v.name.includes('Microsoft') || v.name.includes('Google') || v.name.includes('Samantha'))
    );
    if (preferred) utt.voice = preferred;

    utt.rate   = 0.88;   // deliberate, clinical pace
    utt.pitch  = 0.95;
    utt.volume = 1.0;

    utt.onstart = () => setIsSpeaking(true);
    utt.onend   = () => {
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

  // ── Trigger Gemini clinical summary ──────────────────────────────────────
  const triggerDictation = async () => {
    setPhase('loading');
    setError('');
    setSummary('');
    setAnalytics(null);
    setMessages([]);
    stopSpeaking();

    try {
      const res = await fetch('/api/ai-dictator/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate clinical summary.');
      }

      setSummary(data.summary);
      setAnalytics(data.analytics || null);
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

  // ── Doctor Q&A ───────────────────────────────────────────────────────────
  const askQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || isAsking) return;

    const q = question.trim();
    setQuestion('');
    setQaError('');
    setIsAsking(true);

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
        throw new Error(data.error || 'Failed to get answer.');
      }

      const ansTs = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      setMessages((prev) => [...prev, { role: 'assistant', text: data.answer, timestamp: ansTs }]);
      speak(data.answer);
    } catch (err: any) {
      setQaError(err.message);
    } finally {
      setIsAsking(false);
    }
  };

  // Quick-question suggestions
  const SUGGESTIONS = [
    'What medicines is the patient currently taking?',
    'How many falls happened this month?',
    'What are the abnormal BPM readings?',
    'What health risks should be monitored?',
    'Summarize recent lab reports.',
  ];

  if (!open) return null;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-xl flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel */}
      <div className="relative w-full max-w-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 border border-violet-500/20 rounded-3xl shadow-2xl shadow-violet-900/20 flex flex-col overflow-hidden"
           style={{ maxHeight: '90vh' }}>

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/80 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-violet-600/20 border border-violet-500/30">
              <Brain className="h-5 w-5 text-violet-400" />
            </div>
            <div>
              <h2 className="text-sm font-black text-white tracking-wide">AI DICTATOR MODE</h2>
              <p className="text-[10px] text-slate-400 font-mono mt-0.5">
                Powered by Gemini · Patient: Arthur Pendelton, 82
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Speaking indicator */}
            {isSpeaking && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-violet-600/20 border border-violet-500/30 animate-pulse">
                <Volume2 className="h-3.5 w-3.5 text-violet-400" />
                <span className="text-[10px] text-violet-300 font-mono font-bold">SPEAKING</span>
              </div>
            )}
            <button
              onClick={isSpeaking ? stopSpeaking : undefined}
              disabled={!isSpeaking}
              className={`p-1.5 rounded-lg border transition ${isSpeaking ? 'bg-violet-500/20 border-violet-500/40 text-violet-300 hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-300 cursor-pointer' : 'bg-slate-800/50 border-slate-700/50 text-slate-600 cursor-not-allowed'}`}
              title={isSpeaking ? 'Stop speaking' : 'Not speaking'}
            >
              {isSpeaking ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-700/50 transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Analytics strip (shown after data loads) ────────────────────────── */}
        {analytics && (
          <div className="grid grid-cols-4 gap-px bg-slate-800/50 border-b border-slate-800/80 shrink-0">
            {[
              { label: 'AVG BPM', value: analytics.avgBpm ?? '—' },
              { label: 'FALLS (30d)', value: analytics.recentFalls30Days ?? '—' },
              { label: 'ACTIVE FALLS', value: analytics.activeFalls ?? '—' },
              { label: 'ABNORMAL HR', value: analytics.abnormalBpmCount ?? '—' },
            ].map(({ label, value }) => (
              <div key={label} className="bg-slate-900/80 px-4 py-2.5 text-center">
                <p className="text-[9px] text-slate-500 font-mono font-bold tracking-widest">{label}</p>
                <p className={`text-base font-black mt-0.5 ${
                  label === 'ACTIVE FALLS' && value > 0 ? 'text-red-400' :
                  label === 'ABNORMAL HR' && value > 0 ? 'text-amber-400' : 'text-emerald-400'
                }`}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Main content area ────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">

          {/* IDLE — Call-to-action */}
          {phase === 'idle' && (
            <div className="flex-1 flex flex-col items-center justify-center p-10 text-center space-y-6">
              <div className="relative">
                <div className="h-24 w-24 rounded-full bg-violet-600/10 border border-violet-500/20 flex items-center justify-center">
                  <Stethoscope className="h-10 w-10 text-violet-400" />
                </div>
                <span className="absolute -top-1 -right-1 h-5 w-5 bg-emerald-500 rounded-full border-2 border-slate-900 flex items-center justify-center">
                  <span className="text-[8px] font-black text-slate-950">AI</span>
                </span>
              </div>
              <div>
                <h3 className="text-lg font-black text-white">Ready to Brief, Doctor</h3>
                <p className="text-xs text-slate-400 mt-2 max-w-sm leading-relaxed">
                  Mitra will compile Arthur's complete patient data from MongoDB — heart rate history, fall events, prescriptions, and lab reports — then deliver a professional clinical briefing spoken aloud.
                </p>
              </div>
              {error && (
                <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400 max-w-md">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <button
                onClick={triggerDictation}
                className="px-8 py-3 bg-violet-600 hover:bg-violet-500 text-white font-black rounded-2xl text-sm transition shadow-xl shadow-violet-900/30 flex items-center gap-2.5"
              >
                <Brain className="h-4 w-4" />
                Begin Clinical Briefing
              </button>
            </div>
          )}

          {/* LOADING */}
          {phase === 'loading' && (
            <div className="flex-1 flex flex-col items-center justify-center p-10 space-y-6">
              {/* Animated waveform */}
              <div className="flex items-end gap-1 h-16">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-2 bg-violet-500 rounded-full"
                    style={{
                      height: `${20 + Math.sin(i * 0.8) * 15}px`,
                      animation: `pulse 0.8s ease-in-out ${i * 0.07}s infinite alternate`,
                    }}
                  />
                ))}
              </div>
              <div className="text-center">
                <p className="text-sm font-bold text-violet-300 font-mono">COMPILING PATIENT DATA...</p>
                <p className="text-xs text-slate-500 mt-1">Fetching MongoDB records · Generating clinical summary with Gemini</p>
              </div>
            </div>
          )}

          {/* BRIEFING — showing summary + speaking animation */}
          {phase === 'briefing' && (
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="flex items-center gap-2 mb-4">
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${isSpeaking ? 'bg-violet-600/20 border border-violet-500/30 animate-pulse' : 'bg-emerald-500/10 border border-emerald-500/20'}`}>
                  {isSpeaking ? <Volume2 className="h-3.5 w-3.5 text-violet-400" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                  <span className={`text-[10px] font-mono font-bold ${isSpeaking ? 'text-violet-300' : 'text-emerald-300'}`}>
                    {isSpeaking ? 'MITRA IS SPEAKING...' : 'SUMMARY READY — ENTERING Q&A MODE'}
                  </span>
                </div>
              </div>
              <div className="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-5">
                <div className="flex items-start gap-3">
                  <div className="p-1.5 rounded-lg bg-violet-600/20 border border-violet-500/20 shrink-0 mt-0.5">
                    <Brain className="h-4 w-4 text-violet-400" />
                  </div>
                  <p className="text-sm text-slate-200 leading-relaxed font-medium">{summary}</p>
                </div>
              </div>
              {/* Speaking waveform */}
              {isSpeaking && (
                <div className="flex items-center justify-center gap-0.5 h-8 mt-2">
                  {Array.from({ length: 20 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-1.5 bg-violet-500/70 rounded-full"
                      style={{
                        height: `${8 + Math.sin(Date.now() / 200 + i) * 6}px`,
                        animation: `pulse ${0.4 + i * 0.05}s ease-in-out ${i * 0.04}s infinite alternate`,
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Q&A MODE */}
          {phase === 'qa' && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Chat messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((msg, idx) => (
                  <div key={idx} className={`flex gap-3 ${msg.role === 'doctor' ? 'flex-row-reverse' : ''}`}>
                    <div className={`p-1.5 rounded-lg shrink-0 mt-0.5 ${msg.role === 'assistant' ? 'bg-violet-600/20 border border-violet-500/20' : 'bg-slate-700/40 border border-slate-600/30'}`}>
                      {msg.role === 'assistant'
                        ? <Brain className="h-3.5 w-3.5 text-violet-400" />
                        : <MessageSquare className="h-3.5 w-3.5 text-slate-400" />
                      }
                    </div>
                    <div className={`max-w-[82%] rounded-2xl px-4 py-3 ${
                      msg.role === 'assistant'
                        ? 'bg-slate-950/70 border border-slate-800/60'
                        : 'bg-violet-600/15 border border-violet-500/20'
                    }`}>
                      <p className={`text-xs leading-relaxed ${msg.role === 'assistant' ? 'text-slate-200' : 'text-violet-200'}`}>
                        {msg.text}
                      </p>
                      <p className="text-[9px] text-slate-600 font-mono mt-1.5">{msg.timestamp}</p>
                    </div>
                  </div>
                ))}
                {isAsking && (
                  <div className="flex gap-3">
                    <div className="p-1.5 rounded-lg bg-violet-600/20 border border-violet-500/20 mt-0.5">
                      <Brain className="h-3.5 w-3.5 text-violet-400" />
                    </div>
                    <div className="bg-slate-950/70 border border-slate-800/60 rounded-2xl px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Quick-question suggestions */}
              {messages.length <= 1 && (
                <div className="px-4 pb-2">
                  <p className="text-[9px] text-slate-500 font-mono mb-1.5 uppercase tracking-widest">Suggested Questions</p>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => setQuestion(s)}
                        className="text-[10px] px-2.5 py-1 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-300 hover:bg-violet-600/20 hover:border-violet-500/30 hover:text-violet-200 transition font-mono"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Error */}
              {qaError && (
                <div className="mx-4 mb-2 flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl text-[11px] text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {qaError}
                </div>
              )}

              {/* Input bar */}
              <div className="p-4 pt-0 border-t border-slate-800/60 shrink-0">
                <form onSubmit={askQuestion} className="flex gap-2">
                  <input
                    ref={inputRef}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Ask about medicines, falls, vitals, lab reports..."
                    disabled={isAsking}
                    className="flex-1 bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-2.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 font-mono transition disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!question.trim() || isAsking}
                    className="px-4 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl transition flex items-center gap-1.5 shrink-0"
                  >
                    {isAsking ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer action bar ─────────────────────────────────────────────────── */}
        {(phase === 'briefing' || phase === 'qa') && (
          <div className="px-6 py-3 border-t border-slate-800/60 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] text-slate-500 font-mono">
                {phase === 'briefing' ? 'Mitra is briefing...' : `Q&A Active · ${messages.length - 1} question${messages.length - 1 !== 1 ? 's' : ''} answered`}
              </span>
            </div>
            <button
              onClick={triggerDictation}
              className="flex items-center gap-1.5 text-[10px] text-slate-400 hover:text-violet-300 font-mono transition"
            >
              <RefreshCw className="h-3 w-3" />
              Re-run briefing
            </button>
          </div>
        )}
      </div>

      {/* Pulse keyframe (injected inline for self-containment) */}
      <style>{`
        @keyframes pulse {
          from { opacity: 0.5; transform: scaleY(0.6); }
          to   { opacity: 1.0; transform: scaleY(1.0); }
        }
      `}</style>
    </div>
  );
}

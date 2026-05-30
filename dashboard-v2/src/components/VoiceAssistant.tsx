import React, { useState, useRef, useEffect } from 'react';
import {
  MessageCircleHeart,
  Send,
  Sparkles,
  AlertCircle,
  Bot,
  User,
  Mic,
  Volume2,
} from 'lucide-react';
import { VoiceMessage, ScanResult } from '../types';

interface VoiceAssistantProps {
  scannedHistory: ScanResult[];
}

const INITIAL_GREETING: VoiceMessage = {
  id: 'init-0',
  role: 'assistant',
  content: `Hello! I'm **MITRA**, your personal AI health companion. 💚

I'm here to help Arthur with health questions, medication reminders, lifestyle tips, and anything else on your mind.

You can ask me things like:
- *"What is Lisinopril used for?"*
- *"I have a headache, what should I do?"*
- *"Is 88 BPM a normal heart rate?"*
- *"What gentle exercises are good for my age?"*

How are you feeling today?`,
  timestamp: new Date().toLocaleTimeString('en-US', { hour12: true }),
};

function MessageBubble({ msg }: { msg: VoiceMessage }) {
  const isUser = msg.role === 'user';

  // Simple markdown-like bold parser
  const parseContent = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, li) => {
      if (!line.trim()) return <div key={li} className="h-2" />;
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const content = line.substring(2);
        const parts = content.split(/\*\*([^*]+)\*\*/g);
        return (
          <div key={li} className="flex gap-2 text-sm leading-relaxed ml-2 mb-1">
            <span className="text-emerald-400 shrink-0">•</span>
            <span>{parts.map((p, i) => i % 2 === 1 ? <strong key={i} className="text-white">{p}</strong> : p)}</span>
          </div>
        );
      }
      const parts = line.split(/\*\*([^*]+)\*\*/g);
      const parsed = parts.map((p, i) => i % 2 === 1 ? <strong key={i} className="text-white">{p}</strong> : p);
      // Italic with *text*
      return <p key={li} className="text-sm leading-relaxed mb-1">{parsed}</p>;
    });
  };

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`h-8 w-8 rounded-xl shrink-0 flex items-center justify-center ${
        isUser
          ? 'bg-slate-700 border border-slate-600'
          : 'bg-emerald-500/10 border border-emerald-500/30'
      }`}>
        {isUser
          ? <User className="h-4 w-4 text-slate-300" />
          : <Bot className="h-4 w-4 text-emerald-400" />
        }
      </div>

      {/* Bubble */}
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
        isUser
          ? 'bg-slate-700 text-slate-100 rounded-tr-sm'
          : 'bg-slate-900 border border-slate-800 text-slate-300 rounded-tl-sm'
      }`}>
        {msg.isLoading ? (
          <div className="flex items-center gap-2 py-1">
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 bg-emerald-400 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
            <span className="text-xs text-slate-500 font-mono">MITRA is thinking…</span>
          </div>
        ) : (
          <div>{parseContent(msg.content)}</div>
        )}
        <div className={`text-[9px] font-mono mt-1.5 ${isUser ? 'text-slate-400 text-right' : 'text-slate-500'}`}>
          {msg.timestamp}
        </div>
      </div>
    </div>
  );
}

const QUICK_PROMPTS = [
  "What does my BPM reading mean?",
  "I have a headache, what can I do?",
  "Remind me about my medications",
  "What gentle exercises suit my age?",
  "How much water should I drink daily?",
  "I feel dizzy when I stand up",
];

export default function VoiceAssistant({ scannedHistory }: VoiceAssistantProps) {
  const [messages, setMessages] = useState<VoiceMessage[]>([INITIAL_GREETING]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const buildPatientContext = () => {
    const recentReportText = scannedHistory
      .slice(0, 2)
      .map(r => r.summary.slice(0, 300))
      .join(' | ');
    return {
      name: 'Arthur Pendelton',
      age: '82',
      recentReports: recentReportText || '',
    };
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: VoiceMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text.trim(),
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: true }),
    };

    const loadingMsg: VoiceMessage = {
      id: `loading-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: '',
      isLoading: true,
    };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      // Build history excluding the loading message and initial greeting
      const historyForAPI = messages
        .filter(m => !m.isLoading && m.id !== 'init-0')
        .map(m => ({ role: m.role, content: m.content }));

      const response = await fetch('/api/voice-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text.trim(),
          history: historyForAPI,
          patientContext: buildPatientContext(),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to get a response from MITRA.');
      }

      const assistantMsg: VoiceMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.reply,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: true }),
      };

      setMessages(prev => [...prev.filter(m => !m.isLoading), assistantMsg]);
    } catch (err: any) {
      setError(err?.message || 'Connection error. Is the server running?');
      setMessages(prev => prev.filter(m => !m.isLoading));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className="flex flex-col h-full space-y-4">

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/60 pb-5 shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <MessageCircleHeart className="h-6 w-6 text-emerald-400" />
            AI Voice Assistant — MITRA
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Powered by Gemini AI. Aware of Arthur's medical history, medications, and current vitals.
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
          <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
          <span className="text-xs font-mono font-bold text-emerald-400">GEMINI 2.5 FLASH</span>
        </div>
      </div>

      {/* Quick prompt chips */}
      <div className="flex flex-wrap gap-2 shrink-0">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => sendMessage(prompt)}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/30 text-[11px] text-slate-400 hover:text-emerald-400 font-mono transition-all disabled:opacity-40"
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 min-h-0" style={{ maxHeight: '420px' }}>
        {messages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 font-mono">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Input area */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 flex items-center gap-3 shrink-0">
        <button
          className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-emerald-400 transition"
          title="Voice input (coming soon)"
        >
          <Mic className="h-4 w-4" />
        </button>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          placeholder="Ask MITRA anything about health, medications, or lifestyle…"
          className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none font-sans"
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={loading || !input.trim()}
          className="p-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      {/* Context awareness notice */}
      {scannedHistory.length > 0 && (
        <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono shrink-0">
          <Volume2 className="h-3.5 w-3.5 text-emerald-500/50" />
          MITRA has context from {scannedHistory.length} scanned report{scannedHistory.length > 1 ? 's' : ''}.
          Responses are tailored to Arthur's medical history.
        </div>
      )}

    </div>
  );
}

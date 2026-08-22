import React from 'react';
import {
  LayoutDashboard,
  Activity,
  Heart,
  FileText,
  AlertCircle,
  Pill,
  ShieldAlert,
  Battery,
  Upload,
  BarChart3,
} from 'lucide-react';
import { ViewType } from '../types';

interface SidebarProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  activeAlert: boolean;
  onTriggerSOS: () => void;
  fallCount: number;
  pendingRxCount?: number;
}

const menuItems: { id: ViewType; name: string; icon: React.ElementType; badge?: string; badgeType?: 'live' | 'alert' | 'iot' | 'ai' | 'rx' | 'hist' }[] = [
  { id: 'overview', name: 'Dashboard', icon: LayoutDashboard },
  { id: 'live-vitals', name: 'Live Vitals', icon: Heart, badge: 'LIVE', badgeType: 'live' },
  { id: 'fall-alerts', name: 'Fall Detection', icon: ShieldAlert, badge: 'ALERT', badgeType: 'alert' },
  { id: 'medicine', name: 'Medicine Box', icon: Pill, badge: 'IoT', badgeType: 'iot' },
  { id: 'report-scanner', name: 'Clinical Scanner', icon: FileText, badge: 'AI', badgeType: 'ai' },
  { id: 'rx-review', name: 'Rx Scan & Review', icon: Upload, badge: 'RX', badgeType: 'rx' },
  { id: 'dose-history', name: 'Dose History', icon: BarChart3, badge: 'HIST', badgeType: 'hist' },
];

const badgeStyles: Record<string, string> = {
  live: 'bg-red-500/20 text-red-400 border-red-500/20',
  alert: 'bg-amber-500/20 text-amber-400 border-amber-500/20',
  iot: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/20',
  ai: 'bg-violet-500/20 text-violet-400 border-violet-500/20',
  rx: 'bg-amber-500/20 text-amber-400 border-amber-500/20',
  hist: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/20',
};

export default function Sidebar({
  currentView,
  onViewChange,
  activeAlert,
  onTriggerSOS,
  fallCount,
  pendingRxCount = 0,
}: SidebarProps) {
  return (
    <aside className="w-[280px] shrink-0 h-screen bg-slate-900/80 backdrop-blur-md border-r border-slate-800/50 shadow-xl flex flex-col p-6 gap-6 z-30">

      {/* ── Brand ── */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
              <Activity className="h-6 w-6 text-emerald-400 animate-pulse" />
            </div>
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-slate-900 glow-emerald" />
          </div>
          <span className="text-2xl font-headline font-bold text-emerald-500 tracking-tight">
            JEEVAN
          </span>
        </div>
        <p className="text-xs text-slate-400 font-medium pl-1">360° AI Monitoring System</p>
      </div>

      {/* ── Patient Card (Glassmorphism) ── */}
      <div className="glass-card rounded-xl p-4 flex flex-col gap-3 relative overflow-hidden">
        {/* Decorative glow */}
        <div className="absolute top-0 right-0 w-16 h-16 bg-emerald-500/10 rounded-bl-full blur-xl" />

        <div className="flex justify-between items-start relative z-10">
          <div>
            <span className="text-[9px] text-slate-500 font-label tracking-widest uppercase">Patient Unit</span>
            <h3 className="font-headline font-bold text-slate-100 text-sm mt-0.5">Somsubhro</h3>
            <span className="text-[10px] text-slate-400">Age 82 · Cardiology</span>
          </div>
          <span className="bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-[9px] font-bold font-label tracking-wider border border-emerald-500/20">
            SECURE
          </span>
        </div>

        <div className="flex items-center justify-between text-xs border-t border-slate-700/50 pt-2.5">
          <div className="flex items-center gap-1.5 text-slate-300">
            <Battery className="h-3.5 w-3.5 text-emerald-400" />
            <span className="font-mono text-[11px]">92%</span>
          </div>
          <div className="flex items-center gap-1.5 text-emerald-400">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full pulse-emerald" />
            <span className="text-[11px] font-medium">Telemetry Active</span>
          </div>
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 flex flex-col gap-1.5">
        <span className="text-[9px] font-label font-bold tracking-[0.2em] text-slate-500 uppercase px-2 mb-1">
          Monitoring Modules
        </span>
        {menuItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;
          const isFallAlert = item.id === 'fall-alerts' && (activeAlert || fallCount > 0);
          const isRxPending = item.id === 'rx-review' && pendingRxCount > 0;

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm transition-all duration-200 group ${isActive
                ? 'bg-emerald-500/10 text-emerald-400 font-bold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`h-[18px] w-[18px] transition-transform duration-200 group-hover:scale-110 ${isActive ? 'text-emerald-400' : isFallAlert ? 'text-red-400' : isRxPending ? 'text-amber-400' : 'text-slate-500 group-hover:text-slate-300'
                  }`} />
                <span>{item.name}</span>
              </div>
              {item.badge && (
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold font-label border ${isFallAlert
                  ? 'bg-red-500/20 border-red-500/30 text-red-400 animate-pulse'
                  : isRxPending
                    ? 'bg-amber-500/20 border-amber-500/30 text-amber-400 animate-pulse'
                    : badgeStyles[item.badgeType || 'ai']
                  }`}>
                  {isFallAlert ? fallCount.toString() : isRxPending ? pendingRxCount.toString() : item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* ── Emergency SOS ── */}
      <div className="mt-auto flex flex-col gap-3">
        {activeAlert && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 animate-pulse">
            <span className="h-2 w-2 bg-red-500 rounded-full pulse-red-dot" />
            <span className="text-[10px] font-bold text-red-400 font-label uppercase tracking-wider">
              Active Emergency
            </span>
          </div>
        )}
        <button
          onClick={onTriggerSOS}
          id="sos-button"
          className="w-full bg-gradient-to-b from-red-500 to-red-600 hover:from-red-400 hover:to-red-500 text-white font-bold py-3.5 rounded-xl shadow-lg shadow-red-500/20 transition-all flex items-center justify-center gap-2 group active:scale-95"
        >
          <AlertCircle className="h-4.5 w-4.5 animate-bounce group-hover:scale-110 transition-transform" />
          <span className="text-sm">Emergency SOS</span>
        </button>
        <p className="text-[10px] text-slate-500 text-center font-mono">
          Notifies caregiver + logs emergency event
        </p>
      </div>
    </aside>
  );
}

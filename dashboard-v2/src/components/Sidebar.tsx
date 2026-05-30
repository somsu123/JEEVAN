import React from 'react';
import {
  LayoutDashboard,
  Activity,
  Heart,
  FileText,
  AlertCircle,
  Pill,
  MessageCircleHeart,
  Battery,
  ShieldAlert,
} from 'lucide-react';
import { ViewType } from '../types';

interface SidebarProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  activeAlert: boolean;
  onTriggerSOS: () => void;
  fallCount: number;
}

const menuItems: { id: ViewType; name: string; icon: React.ElementType; badge?: string; badgeType?: 'ai' | 'alert' | 'count' }[] = [
  { id: 'overview',         name: 'Overview',          icon: LayoutDashboard },
  { id: 'live-vitals',      name: 'Live Vitals',        icon: Heart,          badge: 'LIVE', badgeType: 'ai' },
  { id: 'fall-alerts',      name: 'Fall Detection',     icon: ShieldAlert,    badge: 'alert', badgeType: 'alert' },
  { id: 'medicine',         name: 'Medicine Box',        icon: Pill,           badge: 'IoT', badgeType: 'ai' },
  { id: 'report-scanner',   name: 'Clinical Scanner',   icon: FileText,        badge: 'AI', badgeType: 'ai' },
];

export default function Sidebar({
  currentView,
  onViewChange,
  activeAlert,
  onTriggerSOS,
  fallCount,
}: SidebarProps) {
  return (
    <aside className="w-72 border-r border-slate-800 bg-slate-900/90 backdrop-blur-md flex flex-col h-screen overflow-y-auto shrink-0">

      {/* Brand */}
      <div className="p-6 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <Activity className="h-6 w-6 animate-pulse" />
            </div>
            <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-slate-900" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-1.5">
              Elder<span className="text-emerald-400">Care</span>
            </h1>
            <p className="text-xs text-slate-400 font-mono">360° AI Monitoring System</p>
          </div>
        </div>
      </div>

      {/* Patient widget */}
      <div className="p-4 mx-4 my-4 bg-slate-950/60 rounded-xl border border-slate-800/80">
        <div className="flex justify-between items-start mb-2">
          <div>
            <span className="text-[10px] text-slate-500 font-mono">PATIENT UNIT</span>
            <h2 className="text-sm font-semibold text-slate-200">Arthur Pendelton</h2>
            <span className="text-[10px] text-slate-400 font-mono">Age 82 · Cardiology</span>
          </div>
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            SECURE
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-900/60 text-xs text-slate-400">
          <div className="flex items-center gap-1.5">
            <Battery className="h-3.5 w-3.5 text-emerald-400" />
            <span>Bracelet 92%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
            <span>Telemetry Ok</span>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 space-y-1">
        <span className="block px-3 pb-2 text-[10px] font-bold font-mono tracking-wider text-slate-500">
          MONITORING MODULES
        </span>

        {menuItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;
          const isFallAlert = item.id === 'fall-alerts' && (activeAlert || fallCount > 0);

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm transition-all duration-200 group ${
                isActive
                  ? 'bg-emerald-500/10 text-emerald-300 border-l-4 border-emerald-500 font-medium'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200 border-l-4 border-transparent'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`h-4 w-4 transition-transform duration-200 group-hover:scale-110 ${
                  isActive ? 'text-emerald-400' : isFallAlert ? 'text-red-400' : 'text-slate-500 group-hover:text-slate-300'
                }`} />
                <span>{item.name}</span>
              </div>
              {item.badge && (
                <span className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold leading-none ${
                  isFallAlert
                    ? 'bg-red-500/20 border border-red-500/30 text-red-400 animate-pulse'
                    : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                }`}>
                  {isFallAlert ? fallCount.toString() : item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* SOS */}
      <div className="p-5 mt-auto border-t border-slate-800/80 bg-slate-950/40">
        {activeAlert && (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 animate-pulse">
            <span className="h-2 w-2 bg-red-500 rounded-full animate-ping" />
            <span className="text-[10px] font-bold text-red-400 font-mono uppercase tracking-wide">
              ACTIVE EMERGENCY
            </span>
          </div>
        )}
        <button
          onClick={onTriggerSOS}
          id="sos-button"
          className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-semibold text-sm transition-all shadow-lg shadow-red-950/30 border border-red-500/30 flex items-center justify-center gap-2 group"
        >
          <AlertCircle className="h-4 w-4 animate-bounce group-hover:scale-110 transition-transform" />
          TRIGGER MANUAL SOS
        </button>
        <p className="text-[10px] text-slate-500 text-center mt-2 font-mono">
          Notifies caregiver + logs emergency event
        </p>
      </div>
    </aside>
  );
}

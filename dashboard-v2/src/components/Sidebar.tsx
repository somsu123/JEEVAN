import React from 'react';
import {
  LayoutDashboard, Activity, Heart, FileText,
  AlertCircle, Pill, ShieldAlert, Upload, BarChart3
} from 'lucide-react';
import { ViewType } from '../types';
import { motion } from 'motion/react';

interface SidebarProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  activeAlert: boolean;
  onTriggerSOS: () => void;
  fallCount: number;
  pendingRxCount?: number;
}

const menuItems: { id: ViewType; name: string; icon: React.ElementType; badge?: string; badgeType?: 'live' | 'alert' | 'iot' | 'ai' | 'rx' | 'hist' }[] = [
  { id: 'overview', name: 'Home', icon: LayoutDashboard },
  { id: 'live-vitals', name: 'Live Vitals', icon: Heart, badge: 'Live', badgeType: 'live' },
  { id: 'fall-alerts', name: 'Safety Alerts', icon: ShieldAlert, badge: 'Active', badgeType: 'alert' },
  { id: 'medicine', name: 'Medications', icon: Pill },
  { id: 'report-scanner', name: 'Clinical Scans', icon: FileText },
  { id: 'rx-review', name: 'Prescriptions', icon: Upload },
  { id: 'dose-history', name: 'History', icon: BarChart3 },
];

export default function Sidebar({
  currentView, onViewChange, activeAlert, onTriggerSOS, fallCount, pendingRxCount = 0
}: SidebarProps) {
  return (
    <aside className="w-[280px] shrink-0 h-screen bg-[#030712]/80 backdrop-blur-2xl border-r border-white/5 flex flex-col px-6 py-8 gap-8 z-30 relative">
      <div className="absolute top-0 left-0 w-full h-32 bg-emerald-500/5 blur-3xl" />

      {/* ── Brand ── */}
      <div className="flex items-center gap-3 relative z-10">
        <div className="p-2.5 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 shadow-lg shadow-emerald-500/20">
          <Activity className="h-6 w-6 text-white" />
        </div>
        <div className="flex flex-col">
          <span className="text-2xl font-headline font-bold text-white tracking-tight leading-none">JEEVAN</span>
          <span className="text-[10px] text-emerald-400 font-label uppercase tracking-widest mt-1">Care AI</span>
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 flex flex-col gap-2 relative z-10">
        <span className="text-xs font-headline font-semibold text-slate-500 px-2 mb-2">Modules</span>
        {menuItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;
          const isFallAlert = item.id === 'fall-alerts' && (activeAlert || fallCount > 0);
          const isRxPending = item.id === 'rx-review' && pendingRxCount > 0;

          return (
            <motion.button
              key={item.id}
              whileHover={{ x: 4 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center justify-between px-4 py-3.5 rounded-2xl text-sm transition-all duration-300 group relative overflow-hidden ${
                isActive ? 'text-white font-medium' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
              }`}
            >
              {isActive && (
                <motion.div 
                  layoutId="activeTab"
                  className="absolute inset-0 bg-white/10 rounded-2xl border border-white/10"
                  initial={false}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
              <div className="flex items-center gap-3 relative z-10">
                <Icon className={`h-[18px] w-[18px] transition-transform duration-300 ${isActive ? 'text-emerald-400' : isFallAlert ? 'text-rose-400' : 'text-slate-500 group-hover:text-slate-300'}`} />
                <span className="font-body">{item.name}</span>
              </div>
              
              {item.badge && (
                <span className={`relative z-10 px-2 py-0.5 rounded-full text-[10px] font-bold font-label ${
                  isFallAlert ? 'bg-rose-500/20 text-rose-400 animate-pulse' : 
                  isActive ? 'bg-emerald-500/20 text-emerald-400' : 
                  'bg-slate-800 text-slate-400'
                }`}>
                  {isFallAlert ? fallCount.toString() : item.badge}
                </span>
              )}
            </motion.button>
          );
        })}
      </nav>

    </aside>
  );
}


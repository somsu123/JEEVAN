import React from 'react';
import {
  LayoutDashboard, Activity, Heart, FileText,
  Pill, ShieldAlert, Upload, BarChart3
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
  { id: 'overview', name: 'Home Overview', icon: LayoutDashboard },
  { id: 'live-vitals', name: 'Live Vitals', icon: Heart, badge: 'Live', badgeType: 'live' },
  { id: 'fall-alerts', name: 'Safety & Fall Alerts', icon: ShieldAlert, badge: 'Active', badgeType: 'alert' },
  { id: 'medicine', name: 'Medication Box', icon: Pill },
  { id: 'report-scanner', name: 'Medical Reports', icon: FileText },
  { id: 'rx-review', name: 'Prescriptions', icon: Upload },
  { id: 'dose-history', name: 'Dose History', icon: BarChart3 },
];

export default function Sidebar({
  currentView, onViewChange, activeAlert, onTriggerSOS, fallCount, pendingRxCount = 0
}: SidebarProps) {
  return (
    <aside className="w-[280px] shrink-0 h-screen bg-white border-r border-slate-200/80 flex flex-col px-5 py-6 gap-6 z-30 relative shadow-2xs">
      {/* ── Brand ── */}
      <div className="flex items-center gap-3.5 px-2">
        <div className="p-2.5 rounded-2xl bg-blue-600 text-white shadow-sm shadow-blue-500/20">
          <Activity className="h-6 w-6" />
        </div>
        <div className="flex flex-col">
          <span className="text-xl font-headline font-bold text-slate-800 tracking-tight leading-tight">JEEVAN</span>
          <span className="text-xs text-blue-600 font-medium tracking-wide">Eldercare Assistant</span>
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 flex flex-col gap-2">
        <span className="text-xs font-semibold text-slate-400 px-3 uppercase tracking-wider mb-0.5">Menu</span>
        {menuItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;
          const isFallAlert = item.id === 'fall-alerts' && (activeAlert || fallCount > 0);

          return (
            <motion.button
              key={item.id}
              whileHover={{ x: 3 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-2xl text-sm transition-all duration-200 group relative cursor-pointer ${
                isActive
                  ? 'bg-blue-50/90 text-blue-700 font-semibold border border-blue-200 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-800 hover:bg-slate-100/70 font-medium'
              }`}
            >
              <div className="flex items-center gap-3.5">
                <Icon
                  className={`h-5 w-5 transition-colors shrink-0 ${
                    isActive
                      ? 'text-blue-600'
                      : isFallAlert
                      ? 'text-rose-600'
                      : 'text-slate-400 group-hover:text-slate-600'
                  }`}
                />
                <span className="text-sm font-medium">{item.name}</span>
              </div>

              {item.badge && (
                <span
                  className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                    isFallAlert
                      ? 'bg-rose-100 text-rose-700 border border-rose-200 animate-pulse'
                      : isActive
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {isFallAlert ? fallCount.toString() : item.badge}
                </span>
              )}
            </motion.button>
          );
        })}
      </nav>

      {/* ── Caregiver Quick Status ── */}
      <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-1 shadow-2xs">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-800 text-sm">System Status</span>
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </div>
        <p className="text-xs text-slate-500 leading-relaxed">Continuous patient monitoring active</p>
      </div>
    </aside>
  );
}

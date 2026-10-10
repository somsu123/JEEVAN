/**
 * ============================================================
 *  ConnectionStatus.jsx — Connection Indicator
 * ============================================================
 *  Shows dashboard ↔ server and server ↔ ESP32 connection
 *  status with animated coloured dots and live timestamps.
 *  Ticks every second so "Last update" stays real-time.
 * ============================================================
 */

import React, { useState, useEffect } from 'react';
import { Radio, Clock } from 'lucide-react';

function formatTime(date) {
  if (!date) return 'Never';
  return new Date(date).toLocaleTimeString();
}

function timeSince(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 5)    return 'Just now';
  if (seconds < 60)   return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function StatusDot({ active }) {
  return (
    <span className="relative flex h-3 w-3">
      {active && (
        <span
          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
          style={{ backgroundColor: '#10b981' }}
        />
      )}
      <span
        className="relative inline-flex rounded-full h-3 w-3"
        style={{ backgroundColor: active ? '#10b981' : '#ef4444' }}
      />
    </span>
  );
}

export default function ConnectionStatus({ isConnected, espConnected, lastUpdate }) {
  // Tick every second so timeSince() re-renders live
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="glass-card p-6" id="connection-status">
      <div className="flex items-center gap-3 mb-5">
        <Radio className="w-5 h-5 text-indigo-400" />
        <h2 className="text-lg font-semibold text-slate-200 tracking-tight">Connection</h2>
      </div>

      <div className="space-y-4">
        {/* Dashboard → Server */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusDot active={isConnected} />
            <div>
              <p className="text-sm font-medium text-slate-200">Dashboard → Server</p>
              <p className="text-xs text-slate-500">Socket.IO</p>
            </div>
          </div>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            isConnected
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20'
          }`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* Server → ESP32 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusDot active={espConnected} />
            <div>
              <p className="text-sm font-medium text-slate-200">Server → ESP32</p>
              <p className="text-xs text-slate-500">WebSocket</p>
            </div>
          </div>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            espConnected
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20'
          }`}>
            {espConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* Last update — ticks every second */}
        <div className="border-t border-white/[0.06] pt-4">
          <div className="flex items-center gap-2 text-slate-400">
            <Clock className="w-4 h-4" />
            <span className="text-xs">
              Last update:{' '}
              <span className="text-slate-300 font-medium">{formatTime(lastUpdate)}</span>
              {lastUpdate && (
                <span className="text-slate-500 ml-2">({timeSince(lastUpdate)})</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}


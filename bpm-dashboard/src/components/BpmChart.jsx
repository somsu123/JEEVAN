/**
 * ============================================================
 *  BpmChart.jsx — Real-Time Scrolling Heart Rate Chart
 * ============================================================
 *  Uses Recharts to display a live-scrolling line chart of
 *  BPM readings over the last 60 seconds. Features:
 *  • Smooth animated transitions
 *  • Gradient fill under the curve
 *  • Reference lines for normal range (60–100 BPM)
 *  • Dark-themed custom tooltip
 *  • Responsive sizing
 * ============================================================
 */

import React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
} from 'recharts';
import { Activity } from 'lucide-react';

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;

  const entry = payload[0]?.payload;
  if (!entry) return null;

  return (
    <div className="chart-tooltip">
      <p className="text-xs text-slate-400 mb-1">{entry.time}</p>
      <p className="text-lg font-bold text-emerald-400" style={{ fontFamily: 'var(--font-mono)' }}>
        {entry.bpm > 0 ? `${entry.bpm} BPM` : 'No data'}
      </p>
      {entry.fingerDetected === false && (
        <p className="text-xs text-amber-400 mt-1">No finger detected</p>
      )}
    </div>
  );
}

export default function BpmChart({ history }) {
  // Only show entries with valid BPM for a cleaner chart
  const chartData = history.map((entry, idx) => ({
    ...entry,
    displayBpm: entry.fingerDetected && entry.bpm > 0 ? entry.bpm : null,
    index: idx,
  }));

  const hasBpmData = chartData.some((d) => d.displayBpm !== null);

  return (
    <div className="glass-card p-6" id="bpm-chart">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-indigo-400" />
          <h2 className="text-lg font-semibold text-slate-200 tracking-tight">Live Heart Rate</h2>
        </div>
        <span className="text-xs font-medium text-slate-500">
          {chartData.length > 0 ? `${chartData.length} readings` : 'Waiting for data…'}
        </span>
      </div>

      {/* Chart */}
      <div className="w-full" style={{ height: 320 }}>
        {!hasBpmData ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="text-center">
              <Activity className="w-12 h-12 text-slate-600 mx-auto mb-3 animate-pulse" />
              <p className="text-slate-500 text-sm">Waiting for heart rate data…</p>
              <p className="text-slate-600 text-xs mt-1">Place finger on sensor to begin</p>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="bpmGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                  <stop offset="50%" stopColor="#10b981" stopOpacity={0.1} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#6366f1" />
                  <stop offset="50%" stopColor="#10b981" />
                  <stop offset="100%" stopColor="#22d3ee" />
                </linearGradient>
              </defs>

              <CartesianGrid
                strokeDasharray="3 6"
                stroke="rgba(148, 163, 184, 0.06)"
                vertical={false}
              />

              <XAxis
                dataKey="time"
                stroke="rgba(148, 163, 184, 0.3)"
                tick={{ fill: '#64748b', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={60}
              />

              <YAxis
                domain={[30, 180]}
                stroke="rgba(148, 163, 184, 0.3)"
                tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                axisLine={false}
                width={40}
              />

              {/* Normal range reference lines */}
              <ReferenceLine
                y={60}
                stroke="rgba(16, 185, 129, 0.25)"
                strokeDasharray="6 4"
                label={{ value: '60', fill: '#10b98140', fontSize: 10, position: 'left' }}
              />
              <ReferenceLine
                y={100}
                stroke="rgba(16, 185, 129, 0.25)"
                strokeDasharray="6 4"
                label={{ value: '100', fill: '#10b98140', fontSize: 10, position: 'left' }}
              />

              <Tooltip content={<CustomTooltip />} />

              <Area
                type="monotone"
                dataKey="displayBpm"
                stroke="url(#lineGradient)"
                strokeWidth={2.5}
                fill="url(#bpmGradient)"
                dot={false}
                activeDot={{
                  r: 5,
                  stroke: '#10b981',
                  strokeWidth: 2,
                  fill: '#0a0e1a',
                }}
                isAnimationActive={true}
                animationDuration={300}
                animationEasing="ease-in-out"
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

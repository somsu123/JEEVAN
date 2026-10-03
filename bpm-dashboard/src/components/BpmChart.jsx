/**
 * ============================================================
 *  BpmChart.jsx — Real-Time Dual-Line Vitals Chart
 * ============================================================
 *  Displays live BPM (left axis) and SpO₂ (right axis) on a
 *  single scrolling chart using Recharts ComposedChart.
 *  • BPM  — emerald gradient area + indigo→cyan line
 *  • SpO₂ — blue/violet line (right Y-axis, 85–100%)
 *  • Dark-themed custom tooltip with both metrics
 * ============================================================
 */

import React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  Legend,
} from 'recharts';
import { Activity } from 'lucide-react';

function CustomTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const entry = payload[0]?.payload;
  if (!entry) return null;

  // Treat 0 as no-data in the tooltip (shows — instead of 0)
  const bpmVal  = entry.displayBpm  > 0 ? entry.displayBpm  : null;
  const spo2Val = entry.displaySpo2 > 0 ? entry.displaySpo2 : null;

  return (
    <div className="chart-tooltip">
      <p className="text-xs text-slate-400 mb-2">{entry.time}</p>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-xs text-slate-400">Heart Rate</span>
          <span
            className="text-sm font-bold text-emerald-400 ml-auto tabular-nums"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {bpmVal ? `${bpmVal} BPM` : '—'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-400" />
          <span className="text-xs text-slate-400">SpO₂</span>
          <span
            className="text-sm font-bold text-blue-400 ml-auto tabular-nums"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {spo2Val ? `${spo2Val}%` : '—'}
          </span>
        </div>
      </div>

      {entry.fingerDetected === false && (
        <p className="text-xs text-amber-400 mt-2 pt-2 border-t border-white/10">
          No finger detected
        </p>
      )}
    </div>
  );
}

function CustomLegend() {
  return (
    <div className="flex items-center gap-6 justify-end pr-2 mb-2">
      <div className="flex items-center gap-2">
        <div className="w-8 h-[2.5px] rounded bg-emerald-400" />
        <span className="text-xs text-slate-400">Heart Rate (BPM)</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-8 h-[2.5px] rounded bg-blue-400" />
        <span className="text-xs text-slate-400">SpO₂ (%)</span>
      </div>
    </div>
  );
}

export default function BpmChart({ history, isFresh = false }) {
  // Map to 0 (not null) when no finger — keeps the line continuous.
  // Null would break the line into discrete segments (connectNulls=false).
  let lastValidBpm = null;
  let lastValidSpo2 = null;
  const chartData = history.map((entry, idx) => {
    if (entry.bpm > 0) lastValidBpm = entry.bpm;
    if (entry.spo2 > 0) lastValidSpo2 = entry.spo2;
    return {
      ...entry,
      displayBpm:  entry.bpm > 0 ? entry.bpm : (entry.fingerDetected ? lastValidBpm : null),
      displaySpo2: entry.spo2 > 0 ? entry.spo2 : (entry.fingerDetected ? lastValidSpo2 : null),
      index: idx,
    };
  });

  const hasBpmData  = chartData.some((d) => d.displayBpm  > 0);
  const hasSpo2Data = chartData.some((d) => d.displaySpo2 > 0);
  const hasAnyData  = chartData.length > 0;

  return (
    <div className={`glass-card p-6 transition-opacity duration-300 ${isFresh ? '' : 'opacity-50 grayscale'}`} id="bpm-chart">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-indigo-400" />
          <h2 className="text-lg font-semibold text-slate-200 tracking-tight">
            Live Vitals
          </h2>
        </div>
        <span className="text-xs font-medium text-slate-500">
          {chartData.length > 0 ? `${chartData.length} readings` : 'Waiting for data…'}
        </span>
      </div>

      <CustomLegend />

      {/* Chart */}
      <div className="w-full" style={{ height: 320 }}>
        {!hasAnyData ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="text-center">
              <Activity className="w-12 h-12 text-slate-600 mx-auto mb-3 animate-pulse" />
              <p className="text-slate-500 text-sm">Waiting for vitals data…</p>
              <p className="text-slate-600 text-xs mt-1">
                Place finger on MAX30102 sensor to begin
              </p>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 50, left: -10, bottom: 0 }}>
              <defs>
                {/* BPM area gradient */}
                <linearGradient id="bpmAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#10b981" stopOpacity={0.30} />
                  <stop offset="60%"  stopColor="#10b981" stopOpacity={0.08} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0}    />
                </linearGradient>
                {/* BPM stroke gradient */}
                <linearGradient id="bpmLineGrad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%"   stopColor="#6366f1" />
                  <stop offset="50%"  stopColor="#10b981" />
                  <stop offset="100%" stopColor="#22d3ee" />
                </linearGradient>
              </defs>

              <CartesianGrid
                strokeDasharray="3 6"
                stroke="rgba(148, 163, 184, 0.06)"
                vertical={false}
              />

              {/* Shared X axis — time labels */}
              <XAxis
                dataKey="time"
                stroke="rgba(148, 163, 184, 0.3)"
                tick={{ fill: '#64748b', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={60}
              />

              {/* Left Y axis — BPM (starts at 0 so drop-to-zero is visible) */}
              <YAxis
                yAxisId="bpm"
                domain={[0, 180]}
                stroke="rgba(148, 163, 184, 0.3)"
                tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                axisLine={false}
                width={40}
                label={{
                  value: 'BPM',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#475569',
                  fontSize: 10,
                  dx: 14,
                }}
              />

              {/* Right Y axis — SpO₂ (starts at 0 so drop-to-zero is visible) */}
              <YAxis
                yAxisId="spo2"
                orientation="right"
                domain={[0, 100]}
                stroke="rgba(148, 163, 184, 0.3)"
                tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                axisLine={false}
                width={46}
                tickFormatter={(v) => v === 0 ? '0' : `${v}%`}
                label={{
                  value: 'SpO₂',
                  angle: 90,
                  position: 'insideRight',
                  fill: '#475569',
                  fontSize: 10,
                  dx: -10,
                }}
              />

              {/* Normal BPM reference band */}
              <ReferenceLine
                yAxisId="bpm"
                y={60}
                stroke="rgba(16, 185, 129, 0.2)"
                strokeDasharray="6 4"
              />
              <ReferenceLine
                yAxisId="bpm"
                y={100}
                stroke="rgba(16, 185, 129, 0.2)"
                strokeDasharray="6 4"
              />

              {/* SpO₂ danger reference */}
              <ReferenceLine
                yAxisId="spo2"
                y={95}
                stroke="rgba(96, 165, 250, 0.2)"
                strokeDasharray="6 4"
              />

              <Tooltip content={<CustomTooltip />} />

              {/* BPM — continuous filled area; drops to 0 when no finger */}
              <Area
                yAxisId="bpm"
                type="monotone"
                dataKey="displayBpm"
                stroke="url(#bpmLineGrad)"
                strokeWidth={2.5}
                fill="url(#bpmAreaGrad)"
                dot={false}
                activeDot={{ r: 5, stroke: '#10b981', strokeWidth: 2, fill: '#0a0e1a' }}
                isAnimationActive={false}
                connectNulls={true}
                name="Heart Rate (BPM)"
              />

              {/* SpO₂ — continuous line; drops to 0 when no finger */}
              <Line
                yAxisId="spo2"
                type="monotone"
                dataKey="displaySpo2"
                stroke="#60a5fa"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: '#60a5fa', strokeWidth: 2, fill: '#0a0e1a' }}
                isAnimationActive={false}
                connectNulls={true}
                name="SpO₂ (%)"
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

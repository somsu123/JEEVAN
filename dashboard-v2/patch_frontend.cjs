const fs = require('fs');
let text = fs.readFileSync('src/components/ReportScanner.tsx', 'utf8');

// 1. Add metrics to RxScanOutput
text = text.replace(
  "  medicines: RxExtractedMed[];\n  uncertain_items?: string[];",
  "  medicines: RxExtractedMed[];\n  metrics?: any[];\n  uncertain_items?: string[];"
);

// 2. Add MetricCard component
const metricCardCode = `
function MetricCard({ metric, index }: { metric: any; index: number }) {
  const grad = GRAD_COLORS[index % GRAD_COLORS.length];
  const isConcerning = metric.status === "CONCERNING";
  const isElevated = metric.status === "ELEVATED";

  return (
    <div className={\`rounded-2xl border overflow-hidden transition-all \${
      isConcerning ? 'border-red-500/40 bg-red-950/10'
        : isElevated ? 'border-amber-500/30 bg-amber-950/5'
        : 'border-slate-700/60 bg-slate-900/50'
    }\`}>
      <div className={\`h-0.5 w-full bg-gradient-to-r \${grad}\`} />
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className={\`h-8 w-8 rounded-xl bg-gradient-to-br \${grad} flex items-center justify-center text-sm shrink-0\`}>
              🔬
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-white leading-tight truncate">{metric.name}</p>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wide">Result</span>
          </div>
          <p className="text-sm font-bold text-emerald-400">{metric.value}</p>
        </div>
        
        {metric.interpretation && (
          <p className="text-[9px] text-slate-500 font-mono italic">{metric.interpretation}</p>
        )}
      </div>
    </div>
  );
}
`;

text = text.replace(
  "function ConfidenceBar",
  metricCardCode + "\nfunction ConfidenceBar"
);

// 3. Update the render block
const renderMedBlock = `                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-2">
                    <Pill className="h-3.5 w-3.5 text-indigo-400" /> Extracted Medicines
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {activeRxData!.medicines.map((med, i) => <MedCard key={i} med={med} index={i} />)}
                  </div>
                </div>`;

const renderMetricBlock = `                {activeRxData!.metrics && activeRxData!.metrics.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-2">
                      <Activity className="h-3.5 w-3.5 text-indigo-400" /> Clinical Metrics
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {activeRxData!.metrics.map((metric, i) => <MetricCard key={i} metric={metric} index={i} />)}
                    </div>
                  </div>
                )}
                {activeRxData!.medicines && activeRxData!.medicines.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono mb-3 flex items-center gap-2">
                      <Pill className="h-3.5 w-3.5 text-indigo-400" /> Extracted Medicines
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {activeRxData!.medicines.map((med, i) => <MedCard key={i} med={med} index={i} />)}
                    </div>
                  </div>
                )}`;

text = text.replace(renderMedBlock, renderMetricBlock);

// 4. Update the stats bar to show metrics count instead of medicines count if medicines is 0
text = text.replace(
  "const hasStructuredData = activeRxData && (activeRxData.medicines?.length > 0 || activeRxData.uncertain_items?.length);",
  "const hasStructuredData = activeRxData && (activeRxData.medicines?.length > 0 || activeRxData.metrics?.length > 0 || activeRxData.uncertain_items?.length);"
);

text = text.replace(
  "{activeRxData!.medicines.length}",
  "{activeRxData!.medicines?.length || activeRxData!.metrics?.length || 0}"
);

text = text.replace(
  "{activeRxData!.medicines.filter(m => m.confidence >= 0.8).length}",
  "{activeRxData!.medicines?.filter(m => m.confidence >= 0.8).length || activeRxData!.metrics?.filter(m => m.status === 'NORMAL').length || 0}"
);

text = text.replace(
  "{activeRxData!.medicines.filter(m => m.confidence < 0.8).length + (activeRxData!.uncertain_items?.length || 0)}",
  "{(activeRxData!.medicines?.filter(m => m.confidence < 0.8).length || activeRxData!.metrics?.filter(m => m.status !== 'NORMAL').length || 0) + (activeRxData!.uncertain_items?.length || 0)}"
);

text = text.replace(
  "{activeRxData!.medicines.some(m => m.confidence < 0.6)",
  "{(activeRxData!.medicines || []).some(m => m.confidence < 0.6)"
);

fs.writeFileSync('src/components/ReportScanner.tsx', text);
console.log('Patched ReportScanner.tsx');

const fs = require('fs');
let text = fs.readFileSync('localAi.ts', 'utf8');

const replacement = `export function sanitizeScanReport(raw: unknown): ScanReport {
  if (typeof raw === "string") {
    const parsed = tryParseJSON(raw);
    if (parsed) raw = parsed;
  }

  let medList: any[] = [];
  let metricList: any[] = [];
  let overviewStr = "";
  let actionList: string[] = [];

  if (Array.isArray(raw)) {
    medList = raw;
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, any>;
    if (typeof obj.overview === "string" && obj.overview.trim()) overviewStr = obj.overview.trim();
    if (Array.isArray(obj.actions)) actionList = obj.actions.map(String);
    if (Array.isArray(obj.medicines)) medList = obj.medicines;
    else if (Array.isArray(obj.prescription)) medList = obj.prescription;
    else if (Array.isArray(obj.drugs)) medList = obj.drugs;
    
    if (Array.isArray(obj.metrics)) metricList = obj.metrics;
  }

  const medicines: ScanMed[] = medList
    .map((m: any) => ({
      name: String(m?.name || m?.medicine || m?.drug || "").trim(),
      dosage: m?.dosage ? String(m.dosage).trim() : undefined,
      purpose: m?.purpose ? String(m.purpose).trim() : undefined,
      times: ["08:00"]
    }))
    .filter((m) => m.name.length > 0 && !/^none$|^n\\/a$|^null$/i.test(m.name));

  const metrics: ScanMetric[] = metricList
    .map((m: any) => ({
      name: String(m?.name || "").trim(),
      value: String(m?.value || "").trim(),
      status: String(m?.status || "NORMAL").trim(),
      interpretation: String(m?.interpretation || "").trim()
    }))
    .filter((m) => m.name.length > 0);

  return {
    overview: overviewStr || "Document scan complete.",
    metrics,
    actions: actionList.length > 0 ? actionList : ["Continue regular monitoring."],
    doctorQuestions: [],
    disclaimer: "Always consult your physician.",
    medicines,
  };
}`;

const fnStart = text.indexOf('export function sanitizeScanReport(raw: unknown): ScanReport {');
const endFn = text.indexOf('}', text.indexOf('disclaimer: "Always consult your prescribing physician before modifying dosage.",', fnStart)) + 2;

if (fnStart !== -1) {
  text = text.slice(0, fnStart) + replacement + text.slice(endFn);
  fs.writeFileSync('localAi.ts', text);
  console.log("Replaced successfully");
} else {
  console.log("Could not find function start");
}

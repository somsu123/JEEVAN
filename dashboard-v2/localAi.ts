import dns from "node:dns";
try { dns.setDefaultResultOrder("ipv4first"); } catch { }
import dotenv from "dotenv";
dotenv.config();

export const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
export const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "llava:latest";
export const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || "llama3.2:latest";
export const LOCAL_AI_ONLY = process.env.LOCAL_AI_ONLY?.toLowerCase() !== "false";

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

interface OllamaResponse {
  message: { content: string };
  model: string;
  done: boolean;
}

async function ollamaStreamChat(
  body: object,
  timeoutMs = 180_000
): Promise<{ text: string; model: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body reader from Ollama");

    const decoder = new TextDecoder();
    let fullText = "";
    let usedModel = "";
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullText += parsed.message.content;
          }
          if (parsed.model) usedModel = parsed.model;
          if (parsed.done) done = true;
        } catch { }
      }
    }

    return { text: fullText.trim(), model: usedModel };
  } finally {
    clearTimeout(timer);
  }
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
}

function extractBalancedJSON(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      const openChar = text[i];
      const closeChar = openChar === "{" ? "}" : "]";
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (c === "\\") {
          escape = true;
          continue;
        }
        if (c === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (c === openChar) depth++;
          else if (c === closeChar) {
            depth--;
            if (depth === 0) {
              const candidate = text.slice(i, j + 1);
              try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === "object") return parsed;
              } catch { }
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

export function tryParseJSON(text: string): unknown {
  if (!text || typeof text !== "string") return null;
  // 1. Direct parse
  try { return JSON.parse(text); } catch { }
  // 2. Strip fences
  try { return JSON.parse(stripFences(text)); } catch { }
  // 3. Find any markdown code fences ```json ... ```
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const p = JSON.parse(match[1].trim());
      if (p && typeof p === "object") return p;
    } catch { }
  }
  // 4. Extract balanced JSON object/array
  const balanced = extractBalancedJSON(text);
  if (balanced) return balanced;

  // 5. Fallback first/last brace
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch { }
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch { }
  }
  return null;
}

function sanitizeTime(t: unknown): string | null {
  if (typeof t !== "string" || !t.trim()) return null;
  const trimmed = t.trim();
  if (/^null$|^none$|^n\/a$|^undefined$/i.test(trimmed)) return null;

  // 1. Match explicit 24h or 12h clock times like "08:30", "8:00 AM", "14:00", "9:00 PM"
  const m = trimmed.match(/(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2];
    const ampm = m[3]?.toLowerCase();
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;
    return `${String(hh).padStart(2, "0")}:${mm}`;
  }

  // 2. Match direct 12-hour with am/pm without colon e.g. "8 AM", "8pm", "9 PM"
  const ampmMatch = trimmed.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (ampmMatch) {
    let hh = parseInt(ampmMatch[1], 10);
    const ampm = ampmMatch[2].toLowerCase();
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;
    return `${String(hh).padStart(2, "0")}:00`;
  }

  // Do NOT guess or default a time if not explicitly stated in prescription
  return null;
}

export async function extractWithVision(
  base64Image: string,
  prompt: string,
  timeoutMs = 180_000
): Promise<{ raw: string; parsed: unknown; model: string }> {
  let cleanImage = base64Image;
  if (cleanImage.includes(",")) cleanImage = cleanImage.split(",")[1];

  // Try Gemini cloud vision models first if configured
  if (!LOCAL_AI_ONLY && process.env.GEMINI_API_KEY) {
    const geminiModels = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash"];
    const apiKey = process.env.GEMINI_API_KEY;

    for (const model of geminiModels) {
      try {
        console.log(`[AI] Routing vision task to Gemini (${model})...`);
        const body = {
          contents: [
            {
              parts: [
                { inlineData: { mimeType: "image/jpeg", data: cleanImage } },
                { text: prompt }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        };

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        const json = await res.json();
        if (!json.error && json.candidates?.[0]?.content?.parts?.[0]?.text) {
          const raw = json.candidates[0].content.parts[0].text;
          const parsed = tryParseJSON(raw);
          console.log(`[AI] ✅ Gemini (${model}) vision extraction succeeded.`);
          return { raw, parsed, model };
        } else {
          console.warn(`[AI] Gemini (${model}) returned:`, json.error?.message || "empty response");
        }
      } catch (e: any) {
        console.warn(`[AI] Gemini (${model}) failed:`, e.message);
      }
    }
    console.warn("[AI] All Gemini vision models exhausted, falling back to local Ollama vision...");
  }

  // Local Ollama Vision fallback
  console.log(`[AI] Using local Ollama vision (${VISION_MODEL})...`);
  const messages: OllamaMessage[] = [{ role: "user", content: prompt, images: [cleanImage] }];
  const body = {
    model: VISION_MODEL,
    messages,
    options: {
      temperature: 0.05,
      repeat_penalty: 1.15,
      num_predict: 2048,
      num_ctx: 4096,
    }
  };
  const result = await ollamaStreamChat(body, timeoutMs);
  const raw = result.text;
  return { raw, parsed: tryParseJSON(raw), model: result.model || VISION_MODEL };
}

export async function generateWithText(
  prompt: string,
  systemPrompt?: string,
  timeoutMs = 120_000
): Promise<{ text: string; model: string }> {
  const messages: OllamaMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });
  const body = {
    model: TEXT_MODEL,
    messages,
    options: {
      temperature: 0.1,
      num_predict: 2048,
      num_ctx: 4096,
    }
  };
  const result = await ollamaStreamChat(body, timeoutMs);
  return { text: result.text, model: result.model || TEXT_MODEL };
}

export async function isOllamaReady(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

export interface RxMed {
  name: string;
  dosage: string | null;
  frequency: string | null;
  suggestedTime: string | null;
  confidence: "high" | "low";
  purpose?: string;
}

export function sanitizeRxMeds(raw: unknown): RxMed[] {
  let textToParse = "";
  if (typeof raw === "string") {
    textToParse = raw;
    const parsed = tryParseJSON(raw);
    if (parsed) raw = parsed;
  }

  let list: any[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, any>;
    if (Array.isArray(obj.medicines)) list = obj.medicines;
    else if (Array.isArray(obj.prescription)) list = obj.prescription;
    else if (Array.isArray(obj.prescriptions)) list = obj.prescriptions;
    else if (Array.isArray(obj.drugs)) list = obj.drugs;
    else if (Array.isArray(obj.meds)) list = obj.meds;
    else if (Array.isArray(obj.items)) list = obj.items;
    else if (Array.isArray(obj.results)) list = obj.results;
    else if (obj.name) list = [obj];
    else {
      for (const val of Object.values(obj)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
          list = val;
          break;
        }
      }
    }
  }

  // If list is still empty but we have raw string, salvage individual JSON objects
  if (list.length === 0 && textToParse) {
    const objRegex = /\{[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?\}/g;
    let match: RegExpExecArray | null;
    while ((match = objRegex.exec(textToParse)) !== null) {
      try {
        const item = JSON.parse(match[0]);
        if (item && item.name) list.push(item);
      } catch {
        // Fallback regex field extraction
        const nameMatch = match[0].match(/"name"\s*:\s*"([^"]+)"/);
        const doseMatch = match[0].match(/"dosage"\s*:\s*"([^"]+)"/);
        const freqMatch = match[0].match(/"frequency"\s*:\s*"([^"]+)"/);
        const timeMatch = match[0].match(/"suggestedTime"\s*:\s*"([^"]+)"/);
        if (nameMatch && nameMatch[1]) {
          list.push({
            name: nameMatch[1],
            dosage: doseMatch ? doseMatch[1] : null,
            frequency: freqMatch ? freqMatch[1] : null,
            suggestedTime: timeMatch ? sanitizeTime(timeMatch[1]) : null,
            confidence: "high"
          });
        }
      }
    }
  }

  return list
    .map((item: any) => {
      const name = String(item?.name || item?.medicine || item?.drug || "").trim();
      const dosage = item?.dosage ? String(item.dosage).trim() : null;
      const frequency = item?.frequency ? String(item.frequency).trim() : null;
      const timeCandidate = item?.suggestedTime || item?.time || null;
      const suggestedTime = sanitizeTime(timeCandidate);
      const confidence = item?.confidence === "low" ? ("low" as const) : ("high" as const);
      const purpose = item?.purpose ? String(item.purpose).trim() : undefined;
      return { name, dosage, frequency, suggestedTime, confidence, purpose };
    })
    .filter((m) => m.name.length > 0 && !/^none$|^n\/a$|^null$/i.test(m.name))
    .filter((m, idx, arr) => {
      const clean = `${m.name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${(m.dosage || '').toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      return arr.findIndex((x) => `${x.name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${(x.dosage || '').toLowerCase().replace(/[^a-z0-9]/g, "")}` === clean) === idx;
    });
}

export interface ScanMetric { name: string; value: string; status: string; interpretation: string; }
export interface ScanMed { name: string; dosage?: string; times: string[]; purpose?: string; }
export interface ScanReport {
  overview: string; metrics: ScanMetric[]; actions: string[];
  doctorQuestions: string[]; disclaimer: string; medicines: ScanMed[];
}

export function sanitizeScanReport(raw: unknown): ScanReport {
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
    .filter((m) => m.name.length > 0 && !/^none$|^n\/a$|^null$/i.test(m.name));

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
}

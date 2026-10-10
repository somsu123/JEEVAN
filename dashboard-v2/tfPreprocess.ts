/**
 * tfPreprocess.ts -- TF.js image preprocessing pipeline
 *
 * Steps: grayscale -> contrast stretch -> Gaussian blur -> deskew -> PNG re-encode
 * Also exposes:
 *   - classifyDocument() -> "prescription" | "lab_report" | "other"
 *   - checkImageQuality() -> quality gate (rejects blurry/dark/low-res images)
 *   - pdfFirstPageToPng() -> rasterise first PDF page using pdfjs-dist
 *
 * CNN hook: marked in classifyDocument() -- swap heuristic for a real model.
 */

import sharp from "sharp";

const MIN_WIDTH  = parseInt(process.env.IMG_MIN_WIDTH  || "300", 10);
const MIN_HEIGHT = parseInt(process.env.IMG_MIN_HEIGHT || "300", 10);
const MIN_MEAN   = parseFloat(process.env.IMG_MIN_MEAN  || "0.08");
const MAX_MEAN   = parseFloat(process.env.IMG_MAX_MEAN  || "0.97");
const MIN_STD    = parseFloat(process.env.IMG_MIN_STD   || "0.04");

function computeStats(pixels: Uint8Array): { mean: number; std: number } {
  let sum = 0;
  const n = pixels.length;
  for (let i = 0; i < n; i++) sum += pixels[i] / 255;
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) { const d = pixels[i] / 255 - mean; variance += d * d; }
  return { mean, std: Math.sqrt(variance / n) };
}

export interface QualityResult { pass: boolean; reason?: string; }

export async function checkImageQuality(inputBuffer: Buffer): Promise<QualityResult> {
  const meta = await sharp(inputBuffer).metadata();
  const { width = 0, height = 0 } = meta;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return { pass: false, reason: `Image too small (${width}x${height}). Please upload at least ${MIN_WIDTH}x${MIN_HEIGHT} pixels.` };
  }
  const { data: pixels } = await sharp(inputBuffer).resize(200, 200, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { mean, std } = computeStats(pixels);
  if (mean < MIN_MEAN) return { pass: false, reason: "Image is too dark. Please retake in better lighting." };
  if (mean > MAX_MEAN) return { pass: false, reason: "Image is overexposed. Please reduce glare and retake." };
  if (std < MIN_STD)   return { pass: false, reason: "Image appears blurry. Please hold the camera steady and retake." };
  return { pass: true };
}

function stretchContrast(pixels: Uint8Array): Uint8Array {
  const sorted = [...pixels].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const range = hi - lo || 1;
  const result = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    result[i] = Math.min(255, Math.max(0, Math.round(((pixels[i] - lo) / range) * 255)));
  }
  return result;
}

function gaussianBlur3x3(pixels: Uint8Array, w: number, h: number): Uint8Array {
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const kSum = 16;
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0, ki = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const ny = Math.max(0, Math.min(h - 1, y + ky));
          const nx = Math.max(0, Math.min(w - 1, x + kx));
          acc += pixels[ny * w + nx] * kernel[ki++];
        }
      }
      out[y * w + x] = Math.round(acc / kSum);
    }
  }
  return out;
}

function estimateSkewAngleDeg(pixels: Uint8Array, w: number, h: number): number {
  let sumX = 0, sumY = 0, count = 0, sxx = 0, sxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pixels[y * w + x] < 128) { sumX += x; sumY += y; count++; }
  if (count < 10) return 0;
  const mx = sumX / count, my = sumY / count;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pixels[y * w + x] < 128) { const dx = x - mx, dy = y - my; sxx += dx * dx; sxy += dx * dy; }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - (sxy * sxy) / (sxx || 1));
  const deg = (angle * 180) / Math.PI;
  return Math.abs(deg) < 10 ? deg : 0;
}

export interface PreprocessResult { base64: string; width: number; height: number; }

export async function preprocessImage(inputBuffer: Buffer): Promise<PreprocessResult> {
  try {
    let pipeline = sharp(inputBuffer).rotate();

    const meta = await sharp(inputBuffer).metadata();
    const w = meta.width || 800;
    const h = meta.height || 600;
    if (w > 1800 || h > 1800) {
      pipeline = pipeline.resize(1800, 1800, { fit: "inside", withoutEnlargement: true });
    }

    const pngBuffer = await pipeline.normalize().png({ compressionLevel: 6 }).toBuffer();
    const finalMeta = await sharp(pngBuffer).metadata();
    return {
      base64: pngBuffer.toString("base64"),
      width: finalMeta.width || w,
      height: finalMeta.height || h,
    };
  } catch {
    return {
      base64: inputBuffer.toString("base64"),
      width: 800,
      height: 600,
    };
  }
}

export async function pdfFirstPageToPng(pdfBuffer: Buffer): Promise<Buffer> {
  // pdfjs-dist for PDF rasterisation (pure JS, no native deps)
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs" as any);
  GlobalWorkerOptions.workerSrc = "";
  const uint8 = new Uint8Array(pdfBuffer);
  const pdf = await (await getDocument({ data: uint8, disableFontFace: true })).promise;
  const page = await pdf.getPage(1);
  const scale = 2.0;
  const viewport = page.getViewport({ scale });
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const context = canvas.getContext("2d") as any;
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toBuffer("image/png");
}

type DocClass = "prescription" | "lab_report" | "other";

/**
 * Heuristic document classifier.
 * HOOK: replace heuristic with tf.loadLayersModel(...) when a trained CNN is available.
 */
export async function classifyDocument(base64Png: string): Promise<DocClass> {
  const buf = Buffer.from(base64Png, "base64");
  const { data: pixels, info } = await sharp(buf).resize(128, 128, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (const p of pixels) if (p < 100) dark++;
  const density = dark / (info.width * info.height);
  if (density > 0.15) return "lab_report";
  if (density > 0.04) return "prescription";
  return "other";
}

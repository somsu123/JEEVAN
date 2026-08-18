/**
 * ============================================================
 *  validation.js — BPM + SpO₂ Payload Validation
 * ============================================================
 *  Validates and sanitises incoming JSON from the ESP32.
 *  Accepts: bpm, spo2, irValue, redValue, fingerDetected,
 *           signal, uptime
 * ============================================================
 */

/**
 * Validate a vitals payload from the ESP32.
 * @param {object} data - Parsed JSON object
 * @returns {{ valid: boolean, cleaned: object|null, error: string|null }}
 */
function validateBpmPayload(data) {
  // Must be an object
  if (!data || typeof data !== 'object') {
    return { valid: false, cleaned: null, error: 'Payload is not an object' };
  }

  const { bpm, spo2, irValue, fingerDetected } = data;

  // ── Required fields ──────────────────────────────────────
  if (typeof bpm !== 'number' || isNaN(bpm)) {
    return { valid: false, cleaned: null, error: 'bpm must be a number' };
  }
  if (typeof irValue !== 'number' || isNaN(irValue)) {
    return { valid: false, cleaned: null, error: 'irValue must be a number' };
  }
  if (typeof fingerDetected !== 'boolean') {
    return { valid: false, cleaned: null, error: 'fingerDetected must be a boolean' };
  }

  // ── Range checks ─────────────────────────────────────────
  if (bpm < 0 || bpm > 300) {
    return { valid: false, cleaned: null, error: `bpm out of range: ${bpm}` };
  }
  if (irValue < 0) {
    return { valid: false, cleaned: null, error: `irValue out of range: ${irValue}` };
  }

  // ── SpO₂ — optional, default 0 when finger absent/invalid ─
  let spo2Cleaned = 0;
  if (typeof spo2 === 'number' && !isNaN(spo2) && spo2 >= 70 && spo2 <= 100) {
    spo2Cleaned = Math.round(spo2);
  }

  // ── Build cleaned object ──────────────────────────────────
  const cleaned = {
    bpm:            Math.round(bpm),
    spo2:           spo2Cleaned,
    irValue:        Math.round(irValue),
    redValue:       typeof data.redValue === 'number' ? Math.round(data.redValue) : 0,
    fingerDetected: fingerDetected,
    signal:         typeof data.signal === 'string' ? data.signal : 'unknown',
    uptime:         typeof data.uptime === 'number'  ? Math.round(data.uptime) : 0,
    timestamp:      Date.now(),
  };

  return { valid: true, cleaned, error: null };
}

module.exports = { validateBpmPayload };

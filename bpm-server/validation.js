/**
 * ============================================================
 *  validation.js — BPM Payload Validation
 * ============================================================
 *  Validates and sanitises incoming JSON from the ESP32.
 * ============================================================
 */

/**
 * Validate a BPM data payload from the ESP32.
 * @param {object} data - Parsed JSON object
 * @returns {{ valid: boolean, cleaned: object|null, error: string|null }}
 */
function validateBpmPayload(data) {
  // Must be an object
  if (!data || typeof data !== 'object') {
    return { valid: false, cleaned: null, error: 'Payload is not an object' };
  }

  // Required fields
  const { bpm, irValue, fingerDetected } = data;

  if (typeof bpm !== 'number' || isNaN(bpm)) {
    return { valid: false, cleaned: null, error: 'bpm must be a number' };
  }

  if (typeof irValue !== 'number' || isNaN(irValue)) {
    return { valid: false, cleaned: null, error: 'irValue must be a number' };
  }

  if (typeof fingerDetected !== 'boolean') {
    return { valid: false, cleaned: null, error: 'fingerDetected must be a boolean' };
  }

  // Range checks
  if (bpm < 0 || bpm > 300) {
    return { valid: false, cleaned: null, error: `bpm out of range: ${bpm}` };
  }

  if (irValue < 0) {
    return { valid: false, cleaned: null, error: `irValue out of range: ${irValue}` };
  }

  // Build cleaned object
  const cleaned = {
    bpm: Math.round(bpm),
    irValue: Math.round(irValue),
    fingerDetected: fingerDetected,
    signal: typeof data.signal === 'string' ? data.signal : 'unknown',
    uptime: typeof data.uptime === 'number' ? Math.round(data.uptime) : 0,
    timestamp: Date.now(),
  };

  return { valid: true, cleaned, error: null };
}

module.exports = { validateBpmPayload };

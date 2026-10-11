/**
 * Validate and normalize one ESP32 vitals packet.
 *
 * Broadcast schema (`bpm:data`):
 * { type, bpm, spo2, irValue, redValue, fingerDetected, signal, uptime,
 *   perfusionPct, sensorError, timestamp }
 * `timestamp` is assigned by the server when the packet is accepted.
 */
function validateBpmPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, cleaned: null, error: 'Payload must be an object' };
  }
  if (data.type !== 'vitals') {
    return { valid: false, cleaned: null, error: 'type must be "vitals"' };
  }

  const numericFields = ['bpm', 'spo2', 'irValue', 'redValue', 'uptime', 'perfusionPct'];
  for (const field of numericFields) {
    if (typeof data[field] !== 'number' || !Number.isFinite(data[field])) {
      return { valid: false, cleaned: null, error: `${field} must be a finite number` };
    }
  }
  if (typeof data.fingerDetected !== 'boolean') {
    return { valid: false, cleaned: null, error: 'fingerDetected must be a boolean' };
  }
  if (typeof data.sensorError !== 'boolean') {
    return { valid: false, cleaned: null, error: 'sensorError must be a boolean' };
  }
  if (typeof data.signal !== 'string' || data.signal.length > 24) {
    return { valid: false, cleaned: null, error: 'signal must be a string of at most 24 characters' };
  }

  const ranges = {
    bpm: [0, 300],
    spo2: [0, 100], // zero means unavailable; valid sensor readings are 70-100
    irValue: [0, 0x7fffff],
    redValue: [0, 0x7fffff],
    uptime: [0, Number.MAX_SAFE_INTEGER],
    perfusionPct: [0, 1000],
  };
  for (const [field, [min, max]] of Object.entries(ranges)) {
    if (data[field] < min || data[field] > max) {
      return { valid: false, cleaned: null, error: `${field} out of range` };
    }
  }
  if (data.spo2 !== 0 && data.spo2 < 70) {
    return { valid: false, cleaned: null, error: 'spo2 must be zero or between 70 and 100' };
  }

  return {
    valid: true,
    cleaned: {
      type: 'vitals',
      bpm: Math.round(data.bpm),
      spo2: Math.round(data.spo2),
      irValue: Math.round(data.irValue),
      redValue: Math.round(data.redValue),
      fingerDetected: data.fingerDetected,
      signal: data.signal,
      uptime: Math.round(data.uptime),
      perfusionPct: Math.round(data.perfusionPct * 100) / 100,
      sensorError: data.sensorError,
      timestamp: Date.now(),
    },
    error: null,
  };
}

module.exports = { validateBpmPayload };

/**
 * ============================================================
 *  bpmStore.js — In-Memory Vitals Ring Buffer
 * ============================================================
 *  Stores the last MAX_SIZE readings (default 300 = 5 min @ 1/s).
 *  Tracks: bpm, spo2, irValue, redValue, fingerDetected, signal,
 *          uptime, timestamp.
 * ============================================================
 */

const MAX_SIZE = 300;

class BpmStore {
  constructor() {
    /** @type {Array<object>} */
    this.buffer       = [];
    this.espConnected = false;
    this.lastReceived = null;
  }

  /**
   * Push a validated vitals entry into the store.
   * @param {object} entry
   */
  push(entry) {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_SIZE) {
      this.buffer.shift(); // drop oldest
    }
    this.lastReceived = Date.now();
  }

  /** Get the most recent entry, or null. */
  getLatest() {
    return this.buffer.length > 0
      ? this.buffer[this.buffer.length - 1]
      : null;
  }

  /**
   * Get the last N entries.
   * @param {number} n
   * @returns {Array<object>}
   */
  getHistory(n = 60) {
    const start = Math.max(0, this.buffer.length - n);
    return this.buffer.slice(start);
  }

  /**
   * Compute stats over the stored window.
   * @returns {{ bpm: object, spo2: object }}
   */
  getStats() {
    const validEntries = this.buffer.filter(e => e.fingerDetected && e.bpm > 0);

    if (validEntries.length === 0) {
      return {
        bpm:  { min: 0, max: 0, avg: 0, count: 0 },
        spo2: { min: 0, max: 0, avg: 0, count: 0 },
      };
    }

    // BPM stats
    const bpms   = validEntries.map(e => e.bpm);
    const bpmSum = bpms.reduce((a, b) => a + b, 0);

    // SpO₂ stats (only entries where sensor reported a valid value)
    const spo2Entries = validEntries.filter(e => e.spo2 > 0);
    const spo2s       = spo2Entries.map(e => e.spo2);
    const spo2Sum     = spo2s.reduce((a, b) => a + b, 0);

    return {
      bpm: {
        min:   Math.min(...bpms),
        max:   Math.max(...bpms),
        avg:   Math.round(bpmSum / bpms.length),
        count: validEntries.length,
      },
      spo2: {
        min:   spo2s.length > 0 ? Math.min(...spo2s) : 0,
        max:   spo2s.length > 0 ? Math.max(...spo2s) : 0,
        avg:   spo2s.length > 0 ? Math.round(spo2Sum / spo2s.length) : 0,
        count: spo2s.length,
      },
    };
  }

  /** Set ESP32 connection status */
  setEspConnected(status) {
    this.espConnected = status;
  }

  /** Get connection / status summary */
  getStatus() {
    const latest = this.getLatest();
    return {
      espConnected:    this.espConnected,
      fingerDetected:  latest?.fingerDetected ?? false,
      signal:          latest?.signal ?? 'unknown',
      lastReceived:    this.lastReceived,
      totalReadings:   this.buffer.length,
      latestBpm:       latest?.bpm  ?? null,
      latestSpo2:      latest?.spo2 ?? null,
    };
  }
}

// Singleton
module.exports = new BpmStore();

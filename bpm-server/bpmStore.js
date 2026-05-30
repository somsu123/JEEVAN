/**
 * ============================================================
 *  bpmStore.js — In-Memory BPM Ring Buffer
 * ============================================================
 *  Stores the last MAX_SIZE readings (default 300 = 5 min @ 1/s).
 *  Provides history retrieval and basic statistics.
 * ============================================================
 */

const MAX_SIZE = 300;

class BpmStore {
  constructor() {
    /** @type {Array<object>} */
    this.buffer = [];
    this.espConnected = false;
    this.lastReceived = null;
  }

  /**
   * Push a validated BPM entry into the store.
   * @param {object} entry - Cleaned BPM data with timestamp
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
   * @param {number} n - Number of entries (default 60)
   * @returns {Array<object>}
   */
  getHistory(n = 60) {
    const start = Math.max(0, this.buffer.length - n);
    return this.buffer.slice(start);
  }

  /**
   * Compute stats over the stored window.
   * @returns {{ min: number, max: number, avg: number, count: number }}
   */
  getStats() {
    const validEntries = this.buffer.filter(e => e.fingerDetected && e.bpm > 0);

    if (validEntries.length === 0) {
      return { min: 0, max: 0, avg: 0, count: 0 };
    }

    const bpms = validEntries.map(e => e.bpm);
    const sum = bpms.reduce((a, b) => a + b, 0);

    return {
      min: Math.min(...bpms),
      max: Math.max(...bpms),
      avg: Math.round(sum / bpms.length),
      count: validEntries.length,
    };
  }

  /** Set ESP32 connection status */
  setEspConnected(status) {
    this.espConnected = status;
  }

  /** Get connection / status summary */
  getStatus() {
    return {
      espConnected: this.espConnected,
      lastReceived: this.lastReceived,
      totalReadings: this.buffer.length,
      latestBpm: this.getLatest()?.bpm ?? null,
    };
  }
}

// Singleton
module.exports = new BpmStore();

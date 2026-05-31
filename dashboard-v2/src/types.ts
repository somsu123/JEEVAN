// ─────────────────────────────────────────────────────────────────────────────
// ElderCare Dashboard v2 — Single Source of Truth for All TypeScript Interfaces
// Bridges D:\ai_care features with D:\Elder--Care IoT backend
// ─────────────────────────────────────────────────────────────────────────────

export type ViewType =
  | 'overview'
  | 'live-vitals'
  | 'fall-alerts'
  | 'medicine'
  | 'report-scanner'
  | 'ai-dictator';

// ─── AI Dictator Q&A ─────────────────────────────────────────────────────────
export interface AiDictatorMessage {
  role: 'assistant' | 'doctor';
  text: string;
  timestamp: string;
}

// ─── Live Vitals ─────────────────────────────────────────────────────────────
export interface VitalReading {
  time: string;
  value: number;
}

export interface VitalState {
  heartRate: number | string;
  heartRateHistory: VitalReading[];
  movementState: 'Resting' | 'Gentle Walk' | 'Seated Activity' | 'Sleeping';
  bloodLevelSeconds: number;
  oxygenSpO2: number;
  systolicBP: number;
  diastolicBP: number;
  roomPresence: boolean;
  fingerPresent: boolean;
  lastUpdated: string;
}

// ─── Fall Detection ──────────────────────────────────────────────────────────
export type FallSeverity = 'Critical Fall' | 'Stumble Warning' | 'Rapid Descent';
export type FallSource = 'camera' | 'bracelet' | 'manual';

export interface FallEvent {
  id: string;
  timestamp: string;
  isoTimestamp: string;
  type: FallSeverity;
  source: FallSource;
  location: string;
  confidence: number;
  status: 'active' | 'resolved';
  resolvedAt?: string;
}

// Legacy alias for backwards compat
export interface FallAlert {
  id: string;
  timestamp: string;
  type: FallSeverity;
  status: 'active' | 'resolved';
  resolvedBy?: string;
}

// ─── Medicine Reminder Box ───────────────────────────────────────────────────
export interface MedicineSlot {
  id: string;
  slotNumber: number;
  medicineName: string;
  dosage: string;
  scheduledTime: string; // "HH:MM" 24h
  taken: boolean;
  takenAt?: string;
  presenceConfirmed: boolean;  // ultrasonic sensor
  touchVerified: boolean;       // touch sensor
  notes?: string;
}



// ─── Report Scanner ──────────────────────────────────────────────────────────
export interface ScanResult {
  fileName: string;
  timestamp: string;
  summary: string;
}

// ─── ESP32 Medicine Box Device Status ────────────────────────────────────────
export type MedboxDeviceState =
  | 'IDLE'
  | 'REMINDER'
  | 'DISPENSING'
  | 'CONFIRMED'
  | 'MISSED'
  | 'UNKNOWN';

export interface MedboxStatus {
  online: boolean;
  state: MedboxDeviceState;
  presenceDetected: boolean;
  lastSeen: string;          // ISO timestamp of last heartbeat
  nextDoseTime?: string;     // "HH:MM" of next upcoming dose
  uptime?: number;           // seconds since ESP32 boot
  deviceId: string;
}

// ─── Medicine Event Log (audit trail) ────────────────────────────────────────
export type MedboxEventType = 'DOSE_TAKEN' | 'DOSE_MISSED';

export interface MedboxEvent {
  event: MedboxEventType;
  box: number;               // 1, 2, or 3
  medicine: string;
  dosage?: string;
  timestamp: string;
  deviceId: string;
}

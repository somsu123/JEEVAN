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
  | 'ai-dictator'
  | 'rx-review'
  | 'dose-history';

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
  spo2History?: VitalReading[];
  signalQuality?: string;
  movementState: 'Resting' | 'Gentle Walk' | 'Seated Activity' | 'Sleeping' | 'Unknown';
  bloodLevelSeconds: number | null;
  oxygenSpO2: number;
  roomPresence: boolean | null;
  fingerPresent: boolean;
  lastUpdated: string;
  lastPacketAt?: number | null;
  sensorError?: boolean;
}

// ─── Fall Detection ──────────────────────────────────────────────────────────
export type FallSeverity = 'Critical Fall' | 'Stumble Warning' | 'Rapid Descent' | 'Fall Detected';
export type FallSource = 'camera' | 'bracelet' | 'manual';

export interface FallEvent {
  id: string;
  timestamp: string;
  isoTimestamp: string;
  type: FallSeverity;
  source: FallSource;
  location: string;
  confidence: number | null;
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
  missed?: boolean;
  completelyMissed?: boolean;
  timeoutMinutes?: number;         // Grace period (1–10m) before dose attempt times out
  retryIntervalMinutes?: number;   // Auto-reminder retry snooze interval (2–15m)
  maxRetries?: number;             // Max reminder cycles (1–4 times) before completely missed
  currentRetry?: number;           // Current reminder count (0 = initial, 1..maxRetries)
  nextRetryTime?: string;          // "HH:MM" timestamp of next scheduled auto-reminder
  inSnooze?: boolean;              // True when waiting for next auto-reminder
  presenceConfirmed: boolean;      // ultrasonic sensor
  touchVerified: boolean;          // touch sensor
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
  | 'SNOOZE'
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
export type MedboxEventType = 'DOSE_TAKEN' | 'DOSE_MISSED' | 'DOSE_MISSED_SNOOZE' | 'DOSE_COMPLETELY_MISSED';

export interface MedboxEvent {
  event: MedboxEventType;
  box: number;               // 1, 2, 3, or 4
  medicine: string;
  dosage?: string;
  retryAttempt?: number;
  maxRetries?: number;
  nextRetryTime?: string;
  timestamp: string;
  deviceId: string;
}

// ─── Rx Pipeline ──────────────────────────────────────────────────────────────

export interface ExtractedMed {
  name: string;
  dosage: string | null;
  frequency: string | null;
  suggestedTime: string | null;     // "HH:MM" or null if not in prescription
  confidence: 'high' | 'low';
}

export interface PendingChange {
  id: string;
  prescriptionId: string;
  compartment: number;             // 0–3, matches ESP32 LED_PIN index
  currentLabel: string;            // what's currently in the box (from schedule_cache)
  proposedLabel: string;           // label as it should appear on the LCD
  proposedHour: number;
  proposedMinute: number;
  timeoutMinutes?: number;         // 1–10 minutes grace period
  retryIntervalMinutes?: number;   // 2–15 minutes auto-reminder interval
  maxRetries?: number;             // 1–4 reminder cycles
  extractedMed?: ExtractedMed;
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
  reloadConfirmed: boolean;
}

export interface DoseEvent {
  id: string;
  compartment: number;
  label: string;
  scheduledTime: string;     // "HH:MM"
  takenAt: string | null;    // ISO timestamp or null if missed
  status: 'taken' | 'missed';
  loggedAt: string;          // ISO timestamp when event was written
}

export interface Prescription {
  id: string;
  uploadedAt: string;
  fileName: string;
  ocrText: string;
  extractedMeds: ExtractedMed[];
  llmModel: string;
  status: 'pending_review' | 'applied' | 'rejected';
  prescriptionNumber?: string | null;
}

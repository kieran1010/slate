// ============================================================
// Slate — utils/exportImport.ts
// ============================================================
// Two export formats:
//
//   ENCRYPTED BACKUP (.slate)
//     All clinical data → JSON → AES-256-GCM encrypted →
//     base64 text file. Also carries the user's settings
//     (BACKUP_SETTINGS_FIELDS, incl. the Anthropic API key), which
//     a Replace import restores. The passphrase is stored on this
//     device only, so the user must enter it on a new device.
//
//   CSV ZIP (.zip)
//     Three CSVs (acute, pre-assessment, follow-up) including
//     archived records, zipped for download. Suitable for
//     importing into a spreadsheet. No CSV import is provided.
//
// FILE LOCATION:
//   src/utils/exportImport.ts
// ============================================================

import JSZip from "jszip";
import { encryptPayload, decryptPayload } from "./crypto";
import {
  getConfig,
  saveConfig,
  listPatients,
  listAllAcute,
  listAllPreAssess,
  listAllFollowUp,
  importData,
  type ImportPayload,
  type ImportMode,
} from "../data/repository";
import type { StoredAcute, StoredPreAssess, StoredFollowUp } from "../data/db";
import {
  BACKUP_SETTINGS_FIELDS,
  DEFAULT_APP_CONFIG,
  type BackupSettings,
  type Patient,
} from "../data/models";

// ── Helpers ──────────────────────────────────────────────────

/** Triggers a file download in the browser. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** ISO date string for use in filenames (YYYY-MM-DD). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── CSV helpers ───────────────────────────────────────────────

/** RFC-4180 compliant CSV field escaping. */
function csvField(value: string | number | boolean): string {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: (string | number | boolean)[]): string {
  return fields.map(csvField).join(",");
}

function acuteToCsv(
  records: StoredAcute[],
  patientMap: Map<string, Patient>
): string {
  const headers = [
    "nhi", "surname", "givenName", "dob",
    "location", "background", "taskToComplete", "urgency",
    "status", "notes",
    "archived", "archivedAt", "createdAt", "updatedAt",
  ];
  const rows = records.map((r) => {
    const p = patientMap.get(r.nhi);
    return csvRow([
      r.nhi, p?.surname ?? "", p?.givenName ?? "", p?.dob ?? "",
      r.location, r.background, r.taskToComplete, r.urgency,
      r.status, r.notes,
      r.archived, r.archivedAt, r.createdAt, r.updatedAt,
    ]);
  });
  return [headers.join(","), ...rows].join("\n");
}

function preAssessToCsv(
  records: StoredPreAssess[],
  patientMap: Map<string, Patient>
): string {
  const headers = [
    "nhi", "surname", "givenName", "dob",
    "dateOfSurgery", "procedure", "surgeon", "indicationForSurgery",
    "pastMedicalHistory", "anaestheticHistory", "socialHistory",
    "functionalStatus", "investigations", "medications", "allergies",
    "weight", "height", "airwayAssessment", "notes",
    "status", "archived", "archivedAt", "createdAt", "updatedAt",
  ];
  const rows = records.map((r) => {
    const p = patientMap.get(r.nhi);
    return csvRow([
      r.nhi, p?.surname ?? "", p?.givenName ?? "", p?.dob ?? "",
      r.dateOfSurgery, r.procedure, r.surgeon, r.indicationForSurgery,
      r.pastMedicalHistory, r.anaestheticHistory, r.socialHistory,
      r.functionalStatus, r.investigations, r.medications, r.allergies,
      r.weight, r.height, r.airwayAssessment, r.notes,
      r.status, r.archived, r.archivedAt, r.createdAt, r.updatedAt,
    ]);
  });
  return [headers.join(","), ...rows].join("\n");
}

function followUpToCsv(
  records: StoredFollowUp[],
  patientMap: Map<string, Patient>
): string {
  const headers = [
    "nhi", "surname", "givenName", "dob",
    "intervention", "interventionDate", "followUpDue", "followUpType",
    "outcome", "phoneNumber", "notes",
    "status", "archived", "archivedAt", "createdAt", "updatedAt",
  ];
  const rows = records.map((r) => {
    const p = patientMap.get(r.nhi);
    return csvRow([
      r.nhi, p?.surname ?? "", p?.givenName ?? "", p?.dob ?? "",
      r.intervention, r.interventionDate, r.followUpDue, r.followUpType,
      r.outcome, r.phoneNumber, r.notes,
      r.status, r.archived, r.archivedAt, r.createdAt, r.updatedAt,
    ]);
  });
  return [headers.join(","), ...rows].join("\n");
}

// ── Encrypted backup ──────────────────────────────────────────

/**
 * Builds an encrypted payload string from all local patient
 * data. Shared by the file download and Google Drive backup flows.
 */
export async function buildEncryptedPayload(
  passphrase: string
): Promise<string> {
  const [patients, acute, preAssess, followUp, config] = await Promise.all([
    listPatients(),
    listAllAcute(),
    listAllPreAssess(),
    listAllFollowUp(),
    getConfig(),
  ]);

  const settings: Partial<BackupSettings> = {};
  for (const field of BACKUP_SETTINGS_FIELDS) {
    (settings as Record<string, unknown>)[field] = config[field];
  }

  const payload: ImportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    patients: patients.map((p) => {
      const { profileId: _p, ...r } = p as typeof p & { profileId?: string };
      void _p;
      return r;
    }),
    acute: acute.map(({ profileId: _p, id: _i, ...r }) => r),
    preAssess: preAssess.map(({ profileId: _p, id: _i, ...r }) => r),
    followUp: followUp.map(({ profileId: _p, id: _i, ...r }) => r),
    settings,
    settingsFieldTimes: config.settingsFieldTimes,
  };

  return encryptPayload(JSON.stringify(payload), passphrase);
}

// Per-module record count, split by lifecycle state. Reporting these
// separately (rather than one combined total) avoids a misleading
// import message: a record archived from, say, Acute (e.g. via "Move to
// follow-up") still lives in the acute table, so a flat count makes it
// look like it's still part of the active acute list when it isn't.
export interface ModuleImportCounts {
  total: number;
  active: number;
  archived: number;
}

export interface ImportResultCounts {
  patients: number;
  acute: ModuleImportCounts;
  preAssess: ModuleImportCounts;
  followUp: ModuleImportCounts;
  // True when the backup carried settings and they were applied.
  settingsRestored: boolean;
}

/**
 * Picks the backup's settings, keeping only known fields whose type
 * matches the default (anything else is ignored rather than trusted).
 */
function validBackupSettings(raw: unknown): Partial<BackupSettings> {
  const out: Record<string, unknown> = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const field of BACKUP_SETTINGS_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === typeof DEFAULT_APP_CONFIG[field]) out[field] = value;
  }
  return out as Partial<BackupSettings>;
}

function countByLifecycle(records: { archived: 0 | 1 }[]): ModuleImportCounts {
  const archived = records.filter((r) => r.archived === 1).length;
  return { total: records.length, active: records.length - archived, archived };
}

/**
 * Decrypts an encrypted payload string and checks its shape. The
 * settings are filtered to known, correctly-typed fields. Throws
 * WrongPassphraseError (crypto.ts) if the passphrase doesn't open it.
 */
export async function decryptBackup(
  encryptedText: string,
  passphrase: string
): Promise<ImportPayload> {
  const decrypted = await decryptPayload(encryptedText, passphrase);

  let payload: ImportPayload;
  try {
    payload = JSON.parse(decrypted) as ImportPayload;
  } catch {
    throw new Error("Backup data is corrupted or unreadable.");
  }

  if (payload.version !== 1) {
    throw new Error(
      `Unsupported backup version (${String(payload.version)}).`
    );
  }
  for (const list of [payload.patients, payload.acute, payload.preAssess, payload.followUp]) {
    if (!Array.isArray(list)) throw new Error("Backup data is corrupted or unreadable.");
  }

  return { ...payload, settings: validBackupSettings(payload.settings) };
}

/**
 * Decrypts an encrypted payload string and imports the data.
 * Used by the file import. Returns record counts for the success message.
 */
export async function importFromEncryptedString(
  encryptedText: string,
  passphrase: string,
  mode: ImportMode = "replace"
): Promise<ImportResultCounts> {
  const payload = await decryptBackup(encryptedText, passphrase);

  await importData(payload, mode);

  // Replace restores the backup's settings too (e.g. setting up a new
  // device); Merge keeps this device's own settings.
  const settings = mode === "replace" ? payload.settings ?? {} : {};
  const settingsRestored = Object.keys(settings).length > 0;
  if (settingsRestored) await saveConfig(settings);

  return {
    patients: payload.patients.length,
    acute: countByLifecycle(payload.acute),
    preAssess: countByLifecycle(payload.preAssess),
    followUp: countByLifecycle(payload.followUp),
    settingsRestored,
  };
}

/**
 * Exports all patient data as an encrypted .slate file.
 * The file format is produced by crypto.ts and is safe to store
 * as plain text (e.g. the Google Drive backup file).
 */
export async function exportEncrypted(passphrase: string): Promise<void> {
  const encrypted = await buildEncryptedPayload(passphrase);
  const blob = new Blob([encrypted], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, `slate-backup-${today()}.slate`);
}

/**
 * Imports from an encrypted .slate file.
 * Returns the number of records imported, or throws on error.
 */
export async function importEncrypted(
  file: File,
  passphrase: string,
  mode: ImportMode = "replace"
): Promise<ImportResultCounts> {
  const text = await file.text();
  return importFromEncryptedString(text, passphrase, mode);
}

// ── CSV export ────────────────────────────────────────────────

/**
 * Exports all data as three CSV files inside a zip archive.
 * Includes both active and archived records.
 */
export async function exportCsv(): Promise<void> {
  const [patients, acute, preAssess, followUp] = await Promise.all([
    listPatients(),
    listAllAcute(),
    listAllPreAssess(),
    listAllFollowUp(),
  ]);

  const patientMap = new Map(patients.map((p) => [p.nhi, p]));

  const zip = new JSZip();
  zip.file("acute-referrals.csv", acuteToCsv(acute, patientMap));
  zip.file("pre-assessments.csv", preAssessToCsv(preAssess, patientMap));
  zip.file("follow-ups.csv", followUpToCsv(followUp, patientMap));

  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `slate-export-${today()}.zip`);
}

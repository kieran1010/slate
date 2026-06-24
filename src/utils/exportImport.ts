// ============================================================
// Slate — utils/exportImport.ts
// ============================================================
// Two export formats:
//
//   ENCRYPTED BACKUP (.slate)
//     All clinical data → JSON → AES-256-GCM encrypted →
//     base64 text file. The passphrase is stored in the user's
//     Slate account (Firestore) so it is restored automatically
//     on sign-in, enabling import on a new device without the
//     user needing to memorise the passphrase.
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
  listPatients,
  listAllAcute,
  listAllPreAssess,
  listAllFollowUp,
  importData,
  type ImportPayload,
} from "../data/repository";
import type { StoredAcute, StoredPreAssess, StoredFollowUp } from "../data/db";
import type { Patient } from "../data/models";

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
 * data. Shared by the file download and GDocs export flows.
 */
export async function buildEncryptedPayload(
  passphrase: string
): Promise<string> {
  const [patients, acute, preAssess, followUp] = await Promise.all([
    listPatients(),
    listAllAcute(),
    listAllPreAssess(),
    listAllFollowUp(),
  ]);

  const payload: ImportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    patients,
    acute: acute.map(({ profileId: _p, id: _i, ...r }) => r),
    preAssess: preAssess.map(({ profileId: _p, id: _i, ...r }) => r),
    followUp: followUp.map(({ profileId: _p, id: _i, ...r }) => r),
  };

  return encryptPayload(JSON.stringify(payload), passphrase);
}

/**
 * Decrypts an encrypted payload string and imports the data.
 * Shared by the file import and GDocs import flows.
 * Returns record counts for the success message.
 */
export async function importFromEncryptedString(
  encryptedText: string,
  passphrase: string
): Promise<{
  patients: number;
  acute: number;
  preAssess: number;
  followUp: number;
}> {
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

  await importData(payload);

  return {
    patients: payload.patients.length,
    acute: payload.acute.length,
    preAssess: payload.preAssess.length,
    followUp: payload.followUp.length,
  };
}

/**
 * Exports all patient data as an encrypted .slate file.
 * The file format is produced by crypto.ts and is safe to store
 * as plain text (e.g. in a Google Doc for GDocs integration).
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
  passphrase: string
): Promise<{
  patients: number;
  acute: number;
  preAssess: number;
  followUp: number;
}> {
  const text = await file.text();
  return importFromEncryptedString(text, passphrase);
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

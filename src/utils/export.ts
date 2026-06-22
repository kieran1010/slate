// ============================================================
// Charted PWA — utils/export.ts
// ============================================================
// Formats a pre-assessment record as plain text suitable for
// pasting into an anaesthetic record system.
//
// Rules:
//   • Sections with no content are omitted entirely — no blank
//     headings left behind.
//   • Dates are output as dd/MM/yyyy (NZ clinical convention).
//   • BMI is calculated if both weight and height are present
//     (rounded to 1 decimal place).
//   • The stored multi-line format (one item per line, sub-items
//     indented with "  - ") is preserved as-is — the formatter
//     never re-parses or re-structures field content.
//   • Clinician info is included only if the name is set in
//     config; the line is omitted entirely if blank so the
//     output doesn't start with "Assessed by: , Anaesthetist".
//
// FILE LOCATION:
//   src/utils/export.ts
// ============================================================

import { calculateAge } from "../data/models";
import { formatDateDMY, formatDateTimeDMY } from "./format";

// The minimal shapes this formatter needs — only the fields it
// actually reads, so it isn't coupled to the full stored types.
interface ExportPatient {
  nhi: string;
  surname: string;
  givenName: string;
  dob: string;
}

interface ExportRecord {
  dateOfSurgery: string;
  procedure: string;
  surgeon: string;
  indicationForSurgery: string;
  pastMedicalHistory: string;
  anaestheticHistory: string;
  socialHistory: string;
  functionalStatus: string;
  investigations: string;
  medications: string;
  allergies: string;
  weight: string;
  height: string;
  airwayAssessment: string;
  notes: string;
}

// ── BMI helper ────────────────────────────────────────────────

function computeBmi(weight: string, height: string): string | null {
  const w = parseFloat(weight);
  const h = parseFloat(height);
  if (!isFinite(w) || !isFinite(h) || h <= 0 || w <= 0) return null;
  const bmi = w / (h / 100) ** 2;
  return bmi.toFixed(1);
}

// ── Main formatter ────────────────────────────────────────────

export function formatPreAssess(
  patient: ExportPatient,
  record: ExportRecord,
  clinicianName: string,
  clinicianRole: string
): string {
  // Accumulate lines, then join at the end.
  const lines: string[] = [];

  // Helper: adds a blank line, a heading, and the content —
  // but only if the content is non-empty after trimming.
  function section(heading: string, content: string) {
    const body = content.trim();
    if (!body) return;
    lines.push("");
    lines.push(heading);
    lines.push(body);
  }

  // ── Header ─────────────────────────────────────────────────
  lines.push("PRE-ANAESTHETIC ASSESSMENT");

  // Patient identity: "Surname, Given    NHI: ABC1234    DOB: 14/03/1978 (48 yrs)"
  const age = patient.dob ? calculateAge(patient.dob) : "";
  const dobStr = patient.dob ? formatDateDMY(patient.dob) : "";
  const dobPart = dobStr
    ? `DOB: ${dobStr}${age ? ` (${age})` : ""}`
    : "";
  const identityParts = [
    `${patient.surname}, ${patient.givenName}`.trim().replace(/^,\s*/, ""),
    patient.nhi ? `NHI: ${patient.nhi}` : "",
    dobPart,
  ].filter(Boolean);
  lines.push(identityParts.join("    "));

  // Assessor line — omitted entirely if name is blank.
  const name = clinicianName.trim();
  if (name) {
    const role = clinicianRole.trim() || "Anaesthetist";
    lines.push(`Assessed by: ${name}, ${role}`);
  }

  // ── Procedure ──────────────────────────────────────────────
  const hasSurgery =
    record.procedure ||
    record.surgeon ||
    record.indicationForSurgery ||
    record.dateOfSurgery;

  if (hasSurgery) {
    lines.push("");
    lines.push("PROCEDURE");
    if (record.procedure.trim()) lines.push(record.procedure.trim());
    if (record.surgeon.trim()) lines.push(`Surgeon: ${record.surgeon.trim()}`);
    if (record.indicationForSurgery.trim())
      lines.push(`Indication: ${record.indicationForSurgery.trim()}`);
    if (record.dateOfSurgery)
      lines.push(`Date: ${formatDateTimeDMY(record.dateOfSurgery)}`);
  }

  // ── Measurements ───────────────────────────────────────────
  const w = record.weight.trim();
  const h = record.height.trim();
  if (w || h) {
    lines.push("");
    lines.push("MEASUREMENTS");
    const parts: string[] = [];
    if (w) parts.push(`Weight: ${w} kg`);
    if (h) parts.push(`Height: ${h} cm`);
    const bmi = computeBmi(w, h);
    if (bmi) parts.push(`BMI: ${bmi}`);
    lines.push(parts.join("    "));
  }

  // ── Clinical sections (omitted if empty) ───────────────────
  section("PAST MEDICAL HISTORY", record.pastMedicalHistory);
  section("MEDICATIONS",          record.medications);
  section("ALLERGIES",            record.allergies);
  section("ANAESTHETIC HISTORY",  record.anaestheticHistory);
  section("SOCIAL HISTORY",       record.socialHistory);
  section("FUNCTIONAL STATUS",    record.functionalStatus);
  section("INVESTIGATIONS",       record.investigations);
  section("AIRWAY ASSESSMENT",    record.airwayAssessment);
  section("NOTES / PLAN",         record.notes);

  return lines.join("\n");
}

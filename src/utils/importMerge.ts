// ============================================================
// Slate — utils/importMerge.ts
// ============================================================
// Rules for AI import when the patient already has an active record
// in the module (matched on NHI), and the user chooses to add the
// newly read information to it instead of creating a new record.
//
// THE RULE — nothing already in the record is removed or overwritten:
//   • An empty field is filled with what was read.
//   • A field that already says the same thing (ignoring case, spacing
//     and the [UNCERTAIN] tag), or already contains it, is left alone.
//   • A multi-line text field that says something different gets the
//     new text added underneath, after a "— Imported DD/MM/YYYY —" line.
//   • A one-line field or a date (procedure, surgeon, weight, date of
//     surgery…) can't hold two values, so it is kept as it is and the
//     differing value is written into Notes, under the same marker
//     line, for the clinician to reconcile.
// Patient identity follows the same spirit: a stored name or DOB is
// never overwritten by an AI read, only blanks are filled, and any
// difference is shown to the user as a warning (identityMismatches).
//
// Pure functions only — the screens read and write the records.
//
// FILE LOCATION:
//   src/utils/importMerge.ts
// ============================================================

import type { Patient } from "../data/models";
import { formatDateTimeDMY } from "./format";
import { normaliseDob, type ImportModule } from "./importAi";

// ── Field specs ───────────────────────────────────────────────

type FieldKind = "text" | "line" | "date";

interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
}

// The clinical fields AI import can bring into each module's record
// (notes is handled separately: it also receives the conflict lines).
// "text" = multi-line text area; "line" = one-line input; "date" = the
// date/time picker. Keep in step with the detail screens' widgets.
export const MERGE_FIELDS: Record<ImportModule, FieldSpec[]> = {
  "acute": [
    { key: "location",       label: "Location",         kind: "line" },
    { key: "background",     label: "Background",       kind: "text" },
    { key: "taskToComplete", label: "Task to complete", kind: "text" },
  ],
  "pre-assess": [
    { key: "procedure",            label: "Procedure",              kind: "line" },
    { key: "dateOfSurgery",        label: "Date of surgery",        kind: "date" },
    { key: "surgeon",              label: "Surgeon",                kind: "line" },
    { key: "indicationForSurgery", label: "Indication for surgery", kind: "text" },
    { key: "pastMedicalHistory",   label: "Past medical history",   kind: "text" },
    { key: "anaestheticHistory",   label: "Anaesthetic history",    kind: "text" },
    { key: "socialHistory",        label: "Social history",         kind: "text" },
    { key: "functionalStatus",     label: "Functional status",      kind: "text" },
    { key: "investigations",       label: "Investigations",         kind: "text" },
    { key: "medications",          label: "Medications",            kind: "text" },
    { key: "allergies",            label: "Allergies",              kind: "text" },
    { key: "weight",               label: "Weight (kg)",            kind: "line" },
    { key: "height",               label: "Height (cm)",            kind: "line" },
    { key: "airwayAssessment",     label: "Airway assessment",      kind: "text" },
  ],
  "follow-up": [
    { key: "intervention",     label: "Intervention",      kind: "line" },
    { key: "interventionDate", label: "Intervention date", kind: "date" },
    { key: "phoneNumber",      label: "Phone number",      kind: "line" },
    { key: "outcome",          label: "Outcome",           kind: "text" },
  ],
};

// ── Comparison helpers ────────────────────────────────────────

const TAG = /\[UNCERTAIN\]\s*/gi;
const STORAGE_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

/** Text reduced for comparison: no [UNCERTAIN] tag, case or spacing. */
export function comparable(value: string): string {
  return value.replace(TAG, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when `existing` already says `incoming`: equal, or containing it
 * as whole words (so "82" does not count as containing "8").
 */
export function alreadyHas(existing: string, incoming: string): boolean {
  const inc = comparable(incoming);
  if (inc === "") return true;
  const cur = comparable(existing);
  if (cur === inc) return true;
  const escaped = inc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(cur);
}

// A date read without a time ("2026-11-23") agrees with a stored
// date+time on the same day ("2026-11-23T08:00").
function sameDate(existing: string, incoming: string): boolean {
  const cur = comparable(existing);
  const inc = comparable(incoming);
  if (cur === inc) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(inc) && cur.startsWith(`${inc}t`);
}

function displayDate(value: string): string {
  return STORAGE_DATE.test(value) ? formatDateTimeDMY(value) : value;
}

/** NHI as a lookup key: no [UNCERTAIN] tag, no spaces, upper case. */
export function normaliseNhi(raw: string | null | undefined): string {
  return (raw ?? "").replace(TAG, "").replace(/\s+/g, "").toUpperCase();
}

/** The marker line written above anything import adds to a field. */
export function importMarker(importedOn: string): string {
  return `— Imported ${importedOn} —`;
}

// ── Merge ─────────────────────────────────────────────────────

export interface MergeResult {
  /** Field → new value, for only the fields that change. */
  changes: Record<string, string>;
  /** Labels of fields that were empty and have been filled. */
  filled: string[];
  /** Labels of text fields that had new text added underneath. */
  appended: string[];
  /** Labels of one-line/date fields whose differing value went to Notes. */
  conflicts: string[];
}

/**
 * Works out how to add `incoming` (values read by AI import) to an
 * existing record, by the rule at the top of this file. `importedOn`
 * is the date shown in the marker line, e.g. "19/11/2026".
 */
export function buildMergeChanges(
  module: ImportModule,
  existing: Record<string, unknown>,
  incoming: Record<string, string>,
  importedOn: string
): MergeResult {
  const marker = importMarker(importedOn);
  const result: MergeResult = { changes: {}, filled: [], appended: [], conflicts: [] };
  const conflictLines: string[] = [];

  for (const { key, label, kind } of MERGE_FIELDS[module]) {
    const inc = (incoming[key] ?? "").trim();
    if (!inc) continue;
    const cur = typeof existing[key] === "string" ? (existing[key] as string) : "";

    if (!cur.trim()) {
      result.changes[key] = inc;
      result.filled.push(label);
      continue;
    }
    if (kind === "date" ? sameDate(cur, inc) : alreadyHas(cur, inc)) continue;

    if (kind === "text") {
      result.changes[key] = `${cur.trimEnd()}\n${marker}\n${inc}`;
      result.appended.push(label);
    } else {
      const shown = kind === "date" ? displayDate(inc) : inc;
      conflictLines.push(`${label} on imported document: ${shown}`);
      result.conflicts.push(label);
    }
  }

  // Notes: the document's own notes, plus a line for each one-line field
  // that disagreed. Lines Notes already holds (e.g. from importing the
  // same document twice) are not added again.
  const curNotes = typeof existing.notes === "string" ? existing.notes : "";
  const incNotes = (incoming.notes ?? "").trim();
  const extra = [incNotes, ...conflictLines].filter(
    (line) => line && !alreadyHas(curNotes, line)
  );
  if (extra.length > 0) {
    if (!curNotes.trim() && extra.length === 1 && extra[0] === incNotes) {
      result.changes.notes = incNotes;
      result.filled.push("Notes");
    } else {
      result.changes.notes = [curNotes.trimEnd(), marker, ...extra].filter(Boolean).join("\n");
      if (curNotes.trim()) result.appended.push("Notes");
      else result.filled.push("Notes");
    }
  }

  return result;
}

// ── Patient identity ──────────────────────────────────────────

export interface ReadIdentity {
  surname: string;
  givenName: string;
  dob: string;
}

/**
 * Differences between the stored patient and the name/DOB read from
 * the document, as sentences for a warning. Only compares values that
 * are present on both sides. A difference can mean a misread NHI —
 * i.e. the document may be about a different patient.
 */
export function identityMismatches(stored: Patient, read: ReadIdentity): string[] {
  const out: string[] = [];
  const check = (label: string, storedValue: string, readValue: string) => {
    if (!storedValue.trim() || !readValue.trim()) return;
    if (comparable(storedValue) === comparable(readValue)) return;
    out.push(`${label} on the document is "${readValue.replace(TAG, "")}", but Slate has "${storedValue}".`);
  };
  check("Surname", stored.surname, read.surname);
  check("Given name", stored.givenName, read.givenName);
  const readDob = normaliseDob(read.dob.replace(TAG, ""));
  if (stored.dob.trim() && readDob && comparable(stored.dob) !== comparable(readDob)) {
    out.push(
      `Date of birth on the document is ${displayDate(readDob)}, but Slate has ${displayDate(stored.dob)}.`
    );
  }
  return out;
}

// ============================================================
// Slate — utils/archiveSearch.ts
// ============================================================
// Free-text search for the Archive screen. Matches against every
// clinical field of a record plus the patient's identity (NHI,
// surname, given name, date of birth) and the module name.
//
// Case-insensitive; the query is split on whitespace and EVERY word
// must appear somewhere ("smith hip" finds Smith's hip procedure).
// Enum values match with spaces ("in progress", "follow up").
// Internal fields (ids, archive flag, created/updated/archived
// timestamps) are left out so they don't add noise.
//
// FILE LOCATION:
//   src/utils/archiveSearch.ts
// ============================================================

import type { Patient } from "../data/models";
import type { ArchivedItem } from "../data/repository";

const SKIPPED_FIELDS = new Set([
  "id", "profileId", "archived", "archivedAt", "createdAt", "updatedAt",
]);

const MODULE_TEXT: Record<ArchivedItem["module"], string> = {
  ACUTE: "acute",
  PRE_ASSESSMENT: "pre-assess pre assess pre-assessment",
  FOLLOW_UP: "follow-up follow up",
};

/** Lower-cased text that the search matches against. */
export function archiveSearchText(item: ArchivedItem, patient?: Patient): string {
  const parts: string[] = [MODULE_TEXT[item.module]];
  if (patient) parts.push(patient.surname, patient.givenName, patient.dob);
  for (const [key, value] of Object.entries(item.record)) {
    if (SKIPPED_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number") parts.push(String(value));
  }
  return parts.join("\n").replace(/_/g, " ").toLowerCase();
}

export function matchesArchiveSearch(
  item: ArchivedItem,
  patient: Patient | undefined,
  query: string
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = archiveSearchText(item, patient);
  return words.every((w) => text.includes(w));
}

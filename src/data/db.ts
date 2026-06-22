// ============================================================
// Charted PWA — db.ts
// ============================================================
// The local database. Everything lives in the browser via
// IndexedDB; Dexie is a thin, typed wrapper over it.
//
// DESIGN (master + many sub-records + soft archive):
//
//   patients   ── ONE master identity row per patient (per
//                 profile): surname, givenName, dob. Keyed
//                 [profileId+nhi].
//
//   acute /    ── MANY sub-records per patient, each with its own
//   preAssess /   auto-increment `id`. A patient can hold several
//   followUp      records of the same type at once, and a full
//                 history over time. Linked to the master by `nhi`.
//                 Archiving is a soft flag (`archived` 0/1) ON the
//                 record — it is never deleted or moved, so every
//                 field is preserved and "restore" just flips the
//                 flag back to 0.
//
//   (no archive table) ── archiving is the flag above, not a
//                 separate de-identified table. This is what makes
//                 pre-assess → follow-up → archive → restore
//                 lossless.
//
// MULTI-USER = LOCAL PROFILES (per device): every row carries a
// `profileId`. All access goes through the repository (next step),
// which scopes every query to the active profile.
//
// WHY THE `as` CAST INSTEAD OF `class extends Dexie`:
//   With modern TS targets (useDefineForClassFields), subclass
//   field declarations run after Dexie's constructor and overwrite
//   the tables Dexie just assigned — a known "table is undefined"
//   footgun. A plain instance + typed cast avoids it.
//
// SCHEMA VERSIONING: this is pre-release, so v1 is defined fresh
// against the final shape. If you ran an earlier dev build in this
// browser, clear the "ChartedDB" IndexedDB once so the new schema
// takes (same version number won't auto-migrate a changed shape).
//
// FILE LOCATION:
//   src/data/db.ts
// ============================================================

import Dexie, { type Table } from "dexie";
import type {
  Patient,
  AcuteRecord,
  PreAssessRecord,
  FollowUpRecord,
  AppConfig,
} from "./models";

// ── Profile ──────────────────────────────────────────────────
// One local clinician profile on this device.
export interface Profile {
  id: string; // UUID, generated on creation
  name: string; // display name, e.g. "Dr Aroha"
  createdAt: string; // ISO timestamp (system metadata; UTC is fine here)
}

// ── Meta ─────────────────────────────────────────────────────
// Tiny key/value table for app-wide (NOT per-profile) state.
// We use it to remember the active profile (key "activeProfileId")
// so the choice survives a reload. Keeping it in IndexedDB (not
// localStorage) means all state lives in one place and is testable
// outside a browser.
export interface MetaRow {
  key: string;
  value: string;
}

// ── Stored entity shapes ─────────────────────────────────────
// The domain models (models.ts) describe a record's clinical +
// lifecycle fields. What we persist is that PLUS:
//   • profileId — the owning profile (injected by the repository)
//   • id        — auto-increment key for sub-records. Optional in
//                 the type because Dexie assigns it on insert;
//                 every record READ back from the DB will have one.
export type StoredPatient = Patient & { profileId: string };
export type StoredAcute = AcuteRecord & { profileId: string; id?: number };
export type StoredPreAssess = PreAssessRecord & { profileId: string; id?: number };
export type StoredFollowUp = FollowUpRecord & { profileId: string; id?: number };
export type StoredConfig = AppConfig & { profileId: string };

// ── The typed database handle ────────────────────────────────
type ChartedDB = Dexie & {
  meta: Table<MetaRow, string>; // key: the `key` string
  profiles: Table<Profile, string>; // key: the `id` string
  patients: Table<StoredPatient, [string, string]>; // key: [profileId, nhi]
  acute: Table<StoredAcute, number>; // key: auto-increment id
  preAssess: Table<StoredPreAssess, number>;
  followUp: Table<StoredFollowUp, number>;
  config: Table<StoredConfig, string>; // key: profileId
};

export const db = new Dexie("ChartedDB") as ChartedDB;

// ── Schema ───────────────────────────────────────────────────
// In a Dexie `stores()` string you list ONLY the primary key and
// the properties you want indexed; all other fields are still
// stored, just not indexed. Syntax: first entry = primary key,
// "++id" = auto-increment PK, "[a+b]" = compound index.
//
// Indexes chosen for the operations we know we need:
//   • [profileId+nhi]      → all of a patient's records in a module
//                            (used for restore-search and joins)
//   • [profileId+archived] → fast split of active (0) vs archived
//                            (1) for list views and the archive view
//   • profileId            → everything for a profile
//
// The pre-assessment date-desc / time-asc / blanks-last ordering
// (to-do item 1) and follow-up date-desc ordering (item 3) are
// applied in memory by the repository: the ordering is custom and
// per-patient volumes are small, so a dedicated sort index would
// add complexity for no real gain.
db.version(1).stores({
  meta: "key",
  profiles: "id, name",
  patients: "[profileId+nhi], profileId",
  acute: "++id, [profileId+nhi], [profileId+archived], profileId",
  preAssess: "++id, [profileId+nhi], [profileId+archived], profileId",
  followUp: "++id, [profileId+nhi], [profileId+archived], profileId",
  config: "profileId",
});

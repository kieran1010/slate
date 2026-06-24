// ============================================================
// Charted PWA — repository.ts
// ============================================================
// The single API the UI talks to for data. Nothing in the UI
// touches Dexie (db.ts) directly — it all goes through here.
// This is the web equivalent of the Android SheetsRepository,
// minus the webhook: purely local for now, but structured so a
// sync/backend layer could slot in later without the screens
// changing.
//
// TWO RESPONSIBILITIES THIS LAYER OWNS (so screens never have to):
//   1. PROFILE SCOPING. Every read and write is scoped to the
//      active local profile. Reads fetch the active profile id
//      themselves (which also reads the `meta` table, so a
//      `useLiveQuery` over a read re-runs automatically when the
//      user switches profile). This keeps the "always filter by
//      profile" rule in exactly one place.
//   2. MANAGED FIELDS. Callers supply only clinical fields + the
//      module's `status`. The repository fills in `profileId`,
//      `archived`/`archivedAt`, and `createdAt`/`updatedAt` (in
//      the ISO-no-offset format) — callers never set those.
//
// REACTIVITY: read functions are plain async functions returning
// promises. In a component you wrap them with dexie-react-hooks'
// useLiveQuery, e.g.  useLiveQuery(() => listActivePreAssess())
// and the result updates live whenever the data changes.
//
// FILE LOCATION:
//   src/data/repository.ts
// ============================================================

import {
  db,
  type StoredAcute,
  type StoredPreAssess,
  type StoredFollowUp,
} from "./db";
import type {
  Patient,
  AcuteRecord,
  PreAssessRecord,
  FollowUpRecord,
  AppConfig,
  Urgency,
  DischargeToFollowUpRequest,
} from "./models";
import { DEFAULT_APP_CONFIG } from "./models";
import { getActiveProfileId } from "./profiles";
import { nowIso } from "./dates";

// ============================================================
// INPUT TYPES
// ============================================================
// "Managed" fields are set by the repository, never by callers.
type Managed = "archived" | "archivedAt" | "createdAt" | "updatedAt";

// What a screen passes to CREATE a record: clinical fields +
// status + nhi, nothing else.
export type NewAcute = Omit<AcuteRecord, Managed>;
export type NewPreAssess = Omit<PreAssessRecord, Managed>;
export type NewFollowUp = Omit<FollowUpRecord, Managed>;

// What a screen passes to UPDATE a record: any editable field
// (not the managed ones, and not nhi — identity is fixed at
// creation). All optional; updatedAt is bumped automatically.
export type AcuteChanges = Partial<Omit<AcuteRecord, Managed | "nhi">>;
export type PreAssessChanges = Partial<Omit<PreAssessRecord, Managed | "nhi">>;
export type FollowUpChanges = Partial<Omit<FollowUpRecord, Managed | "nhi">>;

// A uniform wrapper for the archive view, which mixes records from
// all three modules. A tagged union so the UI can switch on
// `module` and get the correctly-typed `record`.
export type ArchivedItem =
  | { module: "ACUTE"; record: StoredAcute }
  | { module: "PRE_ASSESSMENT"; record: StoredPreAssess }
  | { module: "FOLLOW_UP"; record: StoredFollowUp };

// ============================================================
// INTERNAL HELPERS
// ============================================================

// For writes: an active profile MUST exist (ensureActiveProfile()
// runs at startup). Missing one is a programming error, not a
// user-facing state, so we throw.
async function requireActiveProfileId(): Promise<string> {
  const id = await getActiveProfileId();
  if (!id) {
    throw new Error(
      "No active profile. Call ensureActiveProfile() during app startup."
    );
  }
  return id;
}

// ── Sort helpers (applied in memory) ─────────────────────────
// Per-patient/per-profile volumes are small, and the orderings
// are custom, so we sort in JS rather than maintaining dedicated
// sort indexes.

// Pre-assessment list (to-do item 1):
//   date of surgery DESCENDING, but time ASCENDING within a date,
//   and blank dates pushed to the very bottom.
function sortPreAssess(rows: StoredPreAssess[]): StoredPreAssess[] {
  const withDate = rows.filter((r) => r.dateOfSurgery !== "");
  const blanks = rows.filter((r) => r.dateOfSurgery === "");
  withDate.sort((a, b) => {
    const [da, ta = ""] = a.dateOfSurgery.split("T");
    const [dbb, tb = ""] = b.dateOfSurgery.split("T");
    if (da !== dbb) return da < dbb ? 1 : -1; // date DESC
    return ta < tb ? -1 : ta > tb ? 1 : 0; // time ASC within a date
  });
  return [...withDate, ...blanks];
}

// Follow-up list (to-do item 3):
//   intervention date DESCENDING, blanks last.
function sortFollowUp(rows: StoredFollowUp[]): StoredFollowUp[] {
  const withDate = rows.filter((r) => r.interventionDate !== "");
  const blanks = rows.filter((r) => r.interventionDate === "");
  withDate.sort((a, b) =>
    a.interventionDate < b.interventionDate
      ? 1
      : a.interventionDate > b.interventionDate
        ? -1
        : 0
  );
  return [...withDate, ...blanks];
}

// Acute list (no spec given — sensible default, easily changed):
//   most urgent first, then oldest-waiting first within an urgency.
const URGENCY_RANK: Record<Urgency, number> = {
  EMERGENCY: 0,
  URGENT: 1,
  ROUTINE: 2,
};
function sortAcute(rows: StoredAcute[]): StoredAcute[] {
  return [...rows].sort((a, b) => {
    const r = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (r !== 0) return r;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

// ============================================================
// PATIENTS (master identity)
// ============================================================

export async function getPatient(nhi: string): Promise<Patient | undefined> {
  const pid = await getActiveProfileId();
  if (!pid) return undefined;
  return db.patients.get([pid, nhi]);
}

export async function listPatients(): Promise<Patient[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  return db.patients.where("profileId").equals(pid).toArray();
}

// Create or update the identity record (keyed on NHI per profile).
export async function upsertPatient(patient: Patient): Promise<void> {
  const pid = await requireActiveProfileId();
  await db.patients.put({ ...patient, profileId: pid });
}

// ============================================================
// ACTIVE LISTS (archived = 0, sorted for display)
// ============================================================

export async function listActiveAcute(): Promise<StoredAcute[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  const rows = await db.acute.where("[profileId+archived]").equals([pid, 0]).toArray();
  return sortAcute(rows);
}

export async function listActivePreAssess(): Promise<StoredPreAssess[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  const rows = await db.preAssess.where("[profileId+archived]").equals([pid, 0]).toArray();
  return sortPreAssess(rows);
}

export async function listActiveFollowUp(): Promise<StoredFollowUp[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  const rows = await db.followUp.where("[profileId+archived]").equals([pid, 0]).toArray();
  return sortFollowUp(rows);
}

// ============================================================
// CREATE  (managed fields filled in here)
// ============================================================

export async function createAcute(input: NewAcute): Promise<number> {
  const profileId = await requireActiveProfileId();
  const now = nowIso();
  const row: StoredAcute = {
    ...input, profileId, archived: 0, archivedAt: "", createdAt: now, updatedAt: now,
  };
  return (await db.acute.add(row)) as number;
}

export async function createPreAssess(input: NewPreAssess): Promise<number> {
  const profileId = await requireActiveProfileId();
  const now = nowIso();
  const row: StoredPreAssess = {
    ...input, profileId, archived: 0, archivedAt: "", createdAt: now, updatedAt: now,
  };
  return (await db.preAssess.add(row)) as number;
}

export async function createFollowUp(input: NewFollowUp): Promise<number> {
  const profileId = await requireActiveProfileId();
  const now = nowIso();
  const row: StoredFollowUp = {
    ...input, profileId, archived: 0, archivedAt: "", createdAt: now, updatedAt: now,
  };
  return (await db.followUp.add(row)) as number;
}

// ============================================================
// UPDATE  (updatedAt bumped automatically)
// ============================================================

export async function updateAcute(id: number, changes: AcuteChanges): Promise<void> {
  await db.acute.update(id, { ...changes, updatedAt: nowIso() });
}

export async function updatePreAssess(id: number, changes: PreAssessChanges): Promise<void> {
  await db.preAssess.update(id, { ...changes, updatedAt: nowIso() });
}

export async function updateFollowUp(id: number, changes: FollowUpChanges): Promise<void> {
  await db.followUp.update(id, { ...changes, updatedAt: nowIso() });
}

// ============================================================
// ARCHIVE / RESTORE / DELETE
// ============================================================
// Archive and restore are pure flag flips — the record stays put
// and keeps every field, which is what makes restore lossless.

export async function archiveRecord(
  module: ArchivedItem["module"],
  id: number
): Promise<void> {
  const patch = { archived: 1 as const, archivedAt: nowIso() };
  switch (module) {
    case "ACUTE": await db.acute.update(id, patch); break;
    case "PRE_ASSESSMENT": await db.preAssess.update(id, patch); break;
    case "FOLLOW_UP": await db.followUp.update(id, patch); break;
  }
}

export async function restoreRecord(
  module: ArchivedItem["module"],
  id: number
): Promise<void> {
  const patch = { archived: 0 as const, archivedAt: "" };
  switch (module) {
    case "ACUTE": await db.acute.update(id, patch); break;
    case "PRE_ASSESSMENT": await db.preAssess.update(id, patch); break;
    case "FOLLOW_UP": await db.followUp.update(id, patch); break;
  }
}

// Hard delete — rarely needed (e.g. a mis-entered record). Prefer
// archiveRecord for normal "remove from view" so nothing is lost.
export async function deleteRecord(
  module: ArchivedItem["module"],
  id: number
): Promise<void> {
  switch (module) {
    case "ACUTE": await db.acute.delete(id); break;
    case "PRE_ASSESSMENT": await db.preAssess.delete(id); break;
    case "FOLLOW_UP": await db.followUp.delete(id); break;
  }
}

// ============================================================
// ARCHIVE VIEW + RESTORE SEARCH
// ============================================================

export async function listArchived(): Promise<ArchivedItem[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  const [ac, pre, fu] = await Promise.all([
    db.acute.where("[profileId+archived]").equals([pid, 1]).toArray(),
    db.preAssess.where("[profileId+archived]").equals([pid, 1]).toArray(),
    db.followUp.where("[profileId+archived]").equals([pid, 1]).toArray(),
  ]);
  const items: ArchivedItem[] = [
    ...ac.map((record) => ({ module: "ACUTE" as const, record })),
    ...pre.map((record) => ({ module: "PRE_ASSESSMENT" as const, record })),
    ...fu.map((record) => ({ module: "FOLLOW_UP" as const, record })),
  ];
  // Most-recently-archived first.
  return items.sort((a, b) =>
    a.record.archivedAt < b.record.archivedAt
      ? 1
      : a.record.archivedAt > b.record.archivedAt
        ? -1
        : 0
  );
}

// For the "restore from archive" flow (to-do item 2): find all
// ARCHIVED records for an NHI, across all three modules, so the
// user can pick which one to restore.
export async function searchArchivedByNhi(nhi: string): Promise<ArchivedItem[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  const [ac, pre, fu] = await Promise.all([
    db.acute.where("[profileId+nhi]").equals([pid, nhi]).toArray(),
    db.preAssess.where("[profileId+nhi]").equals([pid, nhi]).toArray(),
    db.followUp.where("[profileId+nhi]").equals([pid, nhi]).toArray(),
  ]);
  const items: ArchivedItem[] = [
    ...ac.filter((r) => r.archived === 1).map((record) => ({ module: "ACUTE" as const, record })),
    ...pre.filter((r) => r.archived === 1).map((record) => ({ module: "PRE_ASSESSMENT" as const, record })),
    ...fu.filter((r) => r.archived === 1).map((record) => ({ module: "FOLLOW_UP" as const, record })),
  ];
  return items;
}

// ============================================================
// MOVE TO FOLLOW-UP  (archive source + create follow-up)
// ============================================================

// Step 1: build the editable draft, pre-filled per the carry-over
// mapping. The UI shows this in a form for the user to adjust.
export async function buildMoveToFollowUpDraft(
  module: "ACUTE" | "PRE_ASSESSMENT",
  id: number
): Promise<DischargeToFollowUpRequest> {
  if (module === "ACUTE") {
    const a = await db.acute.get(id);
    if (!a) throw new Error(`Acute record ${id} not found`);
    return {
      nhi: a.nhi,
      originModule: "ACUTE",
      intervention: a.taskToComplete, // ← taskToComplete
      interventionDate: a.createdAt, // ← acute referral creation time
      followUpDue: "",
      followUpType: "OFFSET",
      phoneNumber: "",
      notes: "",
    };
  }
  const p = await db.preAssess.get(id);
  if (!p) throw new Error(`Pre-assessment record ${id} not found`);
  return {
    nhi: p.nhi,
    originModule: "PRE_ASSESSMENT",
    intervention: p.procedure, // ← procedure
    interventionDate: p.dateOfSurgery, // ← surgery date/time
    followUpDue: "",
    followUpType: "OFFSET",
    phoneNumber: "",
    notes: "",
  };
}

// Step 2: commit the (possibly edited) draft. Archives the source
// record and creates the new follow-up in a single transaction, so
// the two never get out of step.
export async function commitMoveToFollowUp(
  module: "ACUTE" | "PRE_ASSESSMENT",
  sourceId: number,
  draft: DischargeToFollowUpRequest
): Promise<number> {
  const profileId = await requireActiveProfileId();
  const now = nowIso();
  let newId = 0;
  await db.transaction("rw", db.acute, db.preAssess, db.followUp, async () => {
    if (module === "ACUTE") {
      await db.acute.update(sourceId, { archived: 1, archivedAt: now });
    } else {
      await db.preAssess.update(sourceId, { archived: 1, archivedAt: now });
    }
    const fu: StoredFollowUp = {
      profileId,
      nhi: draft.nhi,
      intervention: draft.intervention,
      interventionDate: draft.interventionDate,
      followUpDue: draft.followUpDue,
      followUpType: draft.followUpType,
      outcome: "",
      phoneNumber: draft.phoneNumber,
      notes: draft.notes,
      status: "PENDING",
      archived: 0,
      archivedAt: "",
      createdAt: now,
      updatedAt: now,
    };
    newId = (await db.followUp.add(fu)) as number;
  });
  return newId;
}

// ============================================================
// CONFIG (per profile)
// ============================================================

export async function getConfig(): Promise<AppConfig> {
  const pid = await requireActiveProfileId();
  const row = await db.config.get(pid);
  // Always spread DEFAULT_APP_CONFIG first so that any new fields added
  // to AppConfig after a user's config was first stored are present with
  // sensible values, rather than being undefined. The stored row wins on
  // every field it does have. We omit profileId from the return since
  // AppConfig (the domain type) doesn't carry it — that's StoredConfig's job.
  if (row) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { profileId: _pid, ...rowFields } = row;
    return { ...DEFAULT_APP_CONFIG, ...rowFields };
  }
  return { ...DEFAULT_APP_CONFIG };
}

export async function saveConfig(changes: Partial<AppConfig>): Promise<void> {
  const pid = await requireActiveProfileId();
  const existing = (await db.config.get(pid)) ?? { ...DEFAULT_APP_CONFIG, profileId: pid };
  await db.config.put({ ...existing, ...changes, profileId: pid });
}

// ============================================================
// FULL-DATA QUERIES  (for export — includes archived records)
// ============================================================

export async function listAllAcute(): Promise<StoredAcute[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  return db.acute.where("profileId").equals(pid).toArray();
}

export async function listAllPreAssess(): Promise<StoredPreAssess[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  return db.preAssess.where("profileId").equals(pid).toArray();
}

export async function listAllFollowUp(): Promise<StoredFollowUp[]> {
  const pid = await getActiveProfileId();
  if (!pid) return [];
  return db.followUp.where("profileId").equals(pid).toArray();
}

// ============================================================
// IMPORT  (from encrypted backup — creates duplicates)
// ============================================================
// Inserts all records from the payload into the current profile.
// Per design: always creates new records rather than checking for
// conflicts — on a new device this is correct, and on an existing
// device the user can delete any unwanted duplicates.
//
// profileId is overridden with the current profile's id.
// Record ids are stripped so Dexie auto-assigns new ones
// (avoiding PK collisions with any existing records).

export interface ImportPayload {
  version: 1;
  exportedAt: string;
  patients: Patient[];
  acute: Omit<StoredAcute, "profileId" | "id">[];
  preAssess: Omit<StoredPreAssess, "profileId" | "id">[];
  followUp: Omit<StoredFollowUp, "profileId" | "id">[];
}

export async function importData(payload: ImportPayload): Promise<void> {
  const pid = await requireActiveProfileId();
  await db.transaction(
    "rw",
    db.patients,
    db.acute,
    db.preAssess,
    db.followUp,
    async () => {
      // Patients: upsert — keyed on [profileId+nhi] so existing
      // identity rows are updated rather than duplicated.
      for (const p of payload.patients) {
        await db.patients.put({ ...p, profileId: pid });
      }
      // Records: no id → Dexie assigns a fresh auto-increment PK.
      for (const r of payload.acute) {
        await db.acute.add({ ...r, profileId: pid });
      }
      for (const r of payload.preAssess) {
        await db.preAssess.add({ ...r, profileId: pid });
      }
      for (const r of payload.followUp) {
        await db.followUp.add({ ...r, profileId: pid });
      }
    }
  );
}

export async function clearAllLocalData(): Promise<void> {
  await db.transaction(
    "rw",
    db.acute,
    db.preAssess,
    db.followUp,
    db.patients,
    db.config,
    db.meta,
    db.profiles,
    async () => {
      await Promise.all([
        db.acute.clear(),
        db.preAssess.clear(),
        db.followUp.clear(),
        db.patients.clear(),
        db.config.clear(),
        db.meta.clear(),
        db.profiles.clear(),
      ]);
    }
  );
  // Also wipe localStorage (warning banner state, etc.).
  localStorage.clear();
}

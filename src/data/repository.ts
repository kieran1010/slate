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

import Dexie, { type Table } from "dexie";
import {
  db,
  type StoredPatient,
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
  BackupSettings,
  Urgency,
  DischargeToFollowUpRequest,
} from "./models";
import { DEFAULT_APP_CONFIG, BACKUP_SETTINGS_FIELDS } from "./models";
import {
  newRowMeta,
  stampChanges,
  normaliseIncoming,
  mergeModule,
  mergePatients,
  mergeSettings,
  type FieldTimes,
} from "./syncMerge";
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

// ── Sync stamping ────────────────────────────────────────────
// Every clinical write records which fields it changed, and when, so
// Drive sync can merge per field (see syncMerge.ts). Writes made BY a
// sync are tagged so the sync engine doesn't treat them as new edits.

type ClinicalTable = Table<StoredAcute, number> | Table<StoredPreAssess, number> | Table<StoredFollowUp, number>;

async function updateStamped(table: ClinicalTable, id: number, changes: Record<string, unknown>): Promise<void> {
  const rows = table as unknown as Table<Record<string, unknown>, number>;
  await db.transaction("rw", rows, async () => {
    const existing = await rows.get(id);
    if (!existing) return;
    await rows.update(id, {
      ...changes,
      fieldTimes: stampChanges(existing, changes),
    });
  });
}

const syncTransactions = new WeakSet<object>();

/** True when the current write belongs to a Drive sync (not a user edit). */
export function isSyncTransaction(tx: object | null | undefined): boolean {
  return !!tx && syncTransactions.has(tx);
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
  await db.transaction("rw", db.patients, async () => {
    const existing = await db.patients.get([pid, patient.nhi]);
    await db.patients.put({
      ...patient,
      profileId: pid,
      fieldTimes: stampChanges(existing as Record<string, unknown> | undefined, { ...patient }),
    });
  });
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
  const fields = { ...input, archived: 0 as const, archivedAt: "" };
  const row: StoredAcute = {
    ...fields, ...newRowMeta(fields), profileId, createdAt: now, updatedAt: now,
  };
  return (await db.acute.add(row)) as number;
}

export async function createPreAssess(input: NewPreAssess): Promise<number> {
  const profileId = await requireActiveProfileId();
  const now = nowIso();
  const fields = { ...input, archived: 0 as const, archivedAt: "" };
  const row: StoredPreAssess = {
    ...fields, ...newRowMeta(fields), profileId, createdAt: now, updatedAt: now,
  };
  return (await db.preAssess.add(row)) as number;
}

export async function createFollowUp(input: NewFollowUp): Promise<number> {
  const profileId = await requireActiveProfileId();
  const now = nowIso();
  const fields = { ...input, archived: 0 as const, archivedAt: "" };
  const row: StoredFollowUp = {
    ...fields, ...newRowMeta(fields), profileId, createdAt: now, updatedAt: now,
  };
  return (await db.followUp.add(row)) as number;
}

// ============================================================
// UPDATE  (updatedAt bumped automatically)
// ============================================================

export async function updateAcute(id: number, changes: AcuteChanges): Promise<void> {
  await updateStamped(db.acute, id, { ...changes, updatedAt: nowIso() });
}

export async function updatePreAssess(id: number, changes: PreAssessChanges): Promise<void> {
  await updateStamped(db.preAssess, id, { ...changes, updatedAt: nowIso() });
}

export async function updateFollowUp(id: number, changes: FollowUpChanges): Promise<void> {
  await updateStamped(db.followUp, id, { ...changes, updatedAt: nowIso() });
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
    case "ACUTE": await updateStamped(db.acute, id, patch); break;
    case "PRE_ASSESSMENT": await updateStamped(db.preAssess, id, patch); break;
    case "FOLLOW_UP": await updateStamped(db.followUp, id, patch); break;
  }
}

// Archives several records of one module in a single transaction.
export async function archiveRecords(
  module: ArchivedItem["module"],
  ids: number[]
): Promise<void> {
  if (ids.length === 0) return;
  const table =
    module === "ACUTE" ? db.acute : module === "PRE_ASSESSMENT" ? db.preAssess : db.followUp;
  const patch = { archived: 1 as const, archivedAt: nowIso() };
  await db.transaction("rw", table, () => Promise.all(ids.map((id) => updateStamped(table, id, patch))));
}

export async function restoreRecord(
  module: ArchivedItem["module"],
  id: number
): Promise<void> {
  const patch = { archived: 0 as const, archivedAt: "" };
  switch (module) {
    case "ACUTE": await updateStamped(db.acute, id, patch); break;
    case "PRE_ASSESSMENT": await updateStamped(db.preAssess, id, patch); break;
    case "FOLLOW_UP": await updateStamped(db.followUp, id, patch); break;
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
      await updateStamped(db.acute, sourceId, { archived: 1, archivedAt: now });
    } else {
      await updateStamped(db.preAssess, sourceId, { archived: 1, archivedAt: now });
    }
    const fields = {
      nhi: draft.nhi,
      intervention: draft.intervention,
      interventionDate: draft.interventionDate,
      followUpDue: draft.followUpDue,
      followUpType: draft.followUpType,
      outcome: "",
      phoneNumber: draft.phoneNumber,
      notes: draft.notes,
      status: "PENDING" as const,
      archived: 0 as const,
      archivedAt: "",
    };
    const fu: StoredFollowUp = { ...fields, ...newRowMeta(fields), profileId, createdAt: now, updatedAt: now };
    newId = (await db.followUp.add(fu)) as number;
  });
  return newId;
}

// ============================================================
// CONFIG (per profile)
// ============================================================

export async function getConfig(): Promise<AppConfig> {
  // getActiveProfileId directly, like the other reads, rather than via
  // requireActiveProfileId: the extra async layer loses Dexie's live-query
  // tracking, so useLiveQuery(getConfig) never saw config changes.
  const pid = await getActiveProfileId();
  if (!pid) throw new Error("No active profile. Call ensureActiveProfile() during app startup.");
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
  await db.transaction("rw", db.config, async () => {
    const existing = (await db.config.get(pid)) ?? { ...DEFAULT_APP_CONFIG, profileId: pid };
    // Stamp the synced settings this save actually changes (see syncMerge.ts).
    const settingsFieldTimes = { ...(existing.settingsFieldTimes ?? {}) };
    const now = new Date().toISOString();
    for (const field of BACKUP_SETTINGS_FIELDS) {
      if (field in changes && changes[field] !== existing[field]) settingsFieldTimes[field] = now;
    }
    await db.config.put({ ...existing, ...changes, settingsFieldTimes, profileId: pid });
  });
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
  patients: Omit<StoredPatient, "profileId">[];
  // Rows carry their sync bookkeeping (uid, fieldTimes) when the backup
  // came from a Slate with Drive sync; older backups don't, and older
  // versions of Slate keep the extra fields untouched, so the format
  // version stays 1.
  acute: Omit<StoredAcute, "profileId" | "id">[];
  preAssess: Omit<StoredPreAssess, "profileId" | "id">[];
  followUp: Omit<StoredFollowUp, "profileId" | "id">[];
  // The user's settings (BACKUP_SETTINGS_FIELDS). Optional: backups made
  // before settings were included don't have it, and older versions of
  // Slate simply ignore it, so the format version stays 1.
  settings?: Partial<BackupSettings>;
  // When each of those settings was last changed (for Drive sync).
  settingsFieldTimes?: FieldTimes;
}

// REPLACE wipes all clinical data for the profile first, then inserts the
// backup — the result is exactly the backup's contents.
// MERGE keeps existing data and merges the backup in with the same rules
// as Drive sync (syncMerge.ts): a record in both copies is matched by its
// uid and merged field by field, so it doesn't appear twice. Records from
// a backup made before uids existed can only be matched on NHI + created
// time against records that also predate uids; otherwise they're added
// alongside, and the user can archive any duplicate.
export type ImportMode = "replace" | "merge";

export async function hasAnyLocalData(): Promise<boolean> {
  const pid = await getActiveProfileId();
  if (!pid) return false;
  const [acute, preAssess, followUp, patients] = await Promise.all([
    db.acute.where("profileId").equals(pid).count(),
    db.preAssess.where("profileId").equals(pid).count(),
    db.followUp.where("profileId").equals(pid).count(),
    db.patients.where("profileId").equals(pid).count(),
  ]);
  return acute + preAssess + followUp + patients > 0;
}

export async function importData(
  payload: ImportPayload,
  mode: ImportMode = "replace"
): Promise<void> {
  const pid = await requireActiveProfileId();
  await db.transaction(
    "rw",
    db.patients,
    db.acute,
    db.preAssess,
    db.followUp,
    async () => {
      // All clears (if replacing) + all inserts happen inside a single
      // transaction, so a failure mid-way leaves the database untouched.
      if (mode === "replace") {
        await db.patients.where("profileId").equals(pid).delete();
        await db.acute.where("profileId").equals(pid).delete();
        await db.preAssess.where("profileId").equals(pid).delete();
        await db.followUp.where("profileId").equals(pid).delete();
        for (const p of payload.patients) {
          await db.patients.put({ ...p, profileId: pid });
        }
        // No id on sub-records → Dexie assigns a fresh auto-increment PK,
        // avoiding any collision with existing/deleted rows.
        for (const r of payload.acute) await db.acute.add({ ...normaliseIncoming(r), profileId: pid });
        for (const r of payload.preAssess) await db.preAssess.add({ ...normaliseIncoming(r), profileId: pid });
        for (const r of payload.followUp) await db.followUp.add({ ...normaliseIncoming(r), profileId: pid });
        return;
      }
      await mergeRecordsInto(pid, payload);
    }
  );
}

export interface SyncMergeStats {
  /** Records (any module) that arrived from the other copy. */
  added: number;
  /** Records on this device that took changes from the other copy. */
  updated: number;
  /** True when any synced setting took the other copy's value. */
  settingsChanged: boolean;
}

// Merges a payload's patients and records into the profile. Must run
// inside a rw transaction over patients, acute, preAssess and followUp.
async function mergeRecordsInto(pid: string, payload: ImportPayload): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;

  const patients = mergePatients(
    await db.patients.where("profileId").equals(pid).toArray(),
    payload.patients.map((p) => ({ ...p, profileId: pid }))
  );
  for (const p of [...patients.changed, ...patients.added]) await db.patients.put({ ...p, profileId: pid });

  async function mergeTable<T extends StoredAcute | StoredPreAssess | StoredFollowUp>(
    table: Table<T, number>,
    remote: Omit<T, "profileId" | "id">[]
  ) {
    const local = await table.where("profileId").equals(pid).toArray();
    const result = mergeModule(local as Record<string, unknown>[], remote as Record<string, unknown>[]);
    for (const row of result.changed) await table.put(row as T);
    for (const row of result.added) await table.add({ ...row, profileId: pid } as T);
    added += result.added.length;
    updated += result.changed.length;
  }
  await mergeTable(db.acute, payload.acute);
  await mergeTable(db.preAssess, payload.preAssess);
  await mergeTable(db.followUp, payload.followUp);
  return { added, updated };
}

/**
 * Drive sync: merges the copy from Drive (null if there isn't one yet)
 * into this device — records and settings — in one transaction. The
 * transaction is tagged (isSyncTransaction) so these writes don't count
 * as fresh edits that need syncing again.
 */
export async function applySyncPayload(remote: ImportPayload | null): Promise<SyncMergeStats> {
  const pid = await requireActiveProfileId();
  if (!remote) return { added: 0, updated: 0, settingsChanged: false };
  return db.transaction(
    "rw",
    [db.patients, db.acute, db.preAssess, db.followUp, db.config],
    async () => {
      if (Dexie.currentTransaction) syncTransactions.add(Dexie.currentTransaction);
      const { added, updated } = await mergeRecordsInto(pid, remote);

      const existing = (await db.config.get(pid)) ?? { ...DEFAULT_APP_CONFIG, profileId: pid };
      const merged = mergeSettings(
        existing as unknown as Record<string, unknown>,
        existing.settingsFieldTimes ?? {},
        (remote.settings ?? {}) as Record<string, unknown>,
        remote.settingsFieldTimes ?? {},
        DEFAULT_APP_CONFIG as unknown as Record<string, unknown>,
        BACKUP_SETTINGS_FIELDS
      );
      const settingsChanged = Object.keys(merged.changes).length > 0;
      await db.config.put({ ...existing, ...merged.changes, settingsFieldTimes: merged.fieldTimes, profileId: pid });
      return { added, updated, settingsChanged };
    }
  );
}

export async function clearAllLocalData(): Promise<void> {
  // Use the array form of db.transaction to avoid exceeding Dexie's
  // typed overload limit (max 7 positional arguments).
  await db.transaction(
    "rw",
    [db.acute, db.preAssess, db.followUp, db.patients, db.config, db.meta, db.profiles],
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

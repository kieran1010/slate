// ============================================================
// Slate — data/syncMerge.ts
// ============================================================
// Pure merge logic for two-way Google Drive sync. Modelled on
// Tribulator's merge (kieran1010/Tribulator, web/src/lib/merge.js).
//
// IDENTITY:
//   Acute / pre-assess / follow-up rows have a device-local auto-
//   increment id, which means nothing on another device, so each row
//   also carries a `uid` (UUID) that travels with it. Rows that existed
//   before uids were introduced were given one by the v2 database
//   upgrade and flagged `uidMigrated`; two devices that each upgraded
//   the same legacy row invented different uids for it, so legacy rows
//   are also matched by NHI + createdAt, and collapse to the smaller
//   uid (deterministic, so both devices settle on the same one).
//   Patients are keyed on NHI, which is already the same everywhere.
//
// CONFLICTS — per field, latest edit wins:
//   Every write stamps the fields it actually changed in `fieldTimes`
//   (UTC ISO, millisecond precision). Merging takes each field from
//   whichever copy edited it last, so edits to different fields on two
//   devices both survive. Ties (e.g. two legacy copies) are broken by
//   comparing the values themselves, which every device does the same
//   way, so the copies always converge.
//
// SETTINGS:
//   The synced settings (BACKUP_SETTINGS_FIELDS) work the same way,
//   with their times kept in config.settingsFieldTimes.
//
// DELETION:
//   Slate never hard-deletes a clinical record from the UI (it archives
//   — a field change, which merges like any other), so there are no
//   tombstones. Erasing a device is local only; see SettingsScreen.
//
// FILE LOCATION:
//   src/data/syncMerge.ts
// ============================================================

export const EPOCH = "1970-01-01T00:00:00.000Z";

export type FieldTimes = Record<string, string>;

/** The sync bookkeeping a clinical row carries alongside its fields. */
export interface SyncMeta {
  uid?: string;
  uidMigrated?: 1;
  fieldTimes?: FieldTimes;
}

// A row as the merge sees it: any fields, plus the bookkeeping.
type Row = Record<string, unknown> & SyncMeta;

// Keys that are bookkeeping or device-local rather than clinical fields,
// so they are never merged field by field.
const META_KEYS = new Set([
  "id", "profileId", "uid", "uidMigrated", "fieldTimes", "createdAt", "updatedAt",
]);

export function syncStamp(): string {
  return new Date().toISOString();
}

/**
 * Slate's own createdAt/updatedAt are local time to the minute, with no
 * offset ("YYYY-MM-DDThh:mm"). That parses as local time, so it converts
 * to a comparable UTC stamp. Anything unreadable counts as the epoch.
 */
export function legacyStamp(local: unknown): string {
  if (typeof local !== "string" || !local) return EPOCH;
  const t = new Date(local).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : EPOCH;
}

function syncedFields(row: Row): string[] {
  return Object.keys(row).filter((k) => !META_KEYS.has(k));
}

function earlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// Arbitrary but identical on every device, so tied copies converge.
function pickTied(a: unknown, b: unknown): unknown {
  return JSON.stringify(a ?? null) >= JSON.stringify(b ?? null) ? a : b;
}

/**
 * Gives a row without per-field times a fixed time for every field: its
 * own updatedAt. Done once (database upgrade, or a legacy backup on its
 * way in) so a later edit to one field can't make the row's untouched
 * fields look newly edited too.
 */
export function withLegacyFieldTimes<T extends Row>(row: T): T {
  if (row.fieldTimes) return row;
  const stamp = legacyStamp(row.updatedAt);
  const fieldTimes: FieldTimes = {};
  for (const f of syncedFields(row)) fieldTimes[f] = stamp;
  return { ...row, fieldTimes };
}

/** Bookkeeping for a brand-new row: a fresh uid, every field stamped now. */
export function newRowMeta(fields: Record<string, unknown>): Required<Pick<SyncMeta, "uid" | "fieldTimes">> {
  const now = syncStamp();
  const fieldTimes: FieldTimes = {};
  for (const f of syncedFields(fields)) fieldTimes[f] = now;
  return { uid: crypto.randomUUID(), fieldTimes };
}

/**
 * The fieldTimes a row should have after `changes` is applied to it:
 * only fields whose value actually changes are stamped, so saving a
 * whole form doesn't claim every field was just edited.
 */
export function stampChanges(existing: Row | undefined, changes: Record<string, unknown>): FieldTimes {
  const base = existing ? withLegacyFieldTimes(existing).fieldTimes ?? {} : {};
  const fieldTimes: FieldTimes = { ...base };
  const now = syncStamp();
  for (const [f, value] of Object.entries(changes)) {
    if (META_KEYS.has(f)) continue;
    if (!existing || JSON.stringify(existing[f] ?? null) !== JSON.stringify(value ?? null)) {
      fieldTimes[f] = now;
    }
  }
  return fieldTimes;
}

/** Gives a row arriving from a backup without a uid (older Slate) one. */
export function normaliseIncoming<T extends Row>(row: T): T {
  const withTimes = withLegacyFieldTimes(row);
  if (withTimes.uid) return withTimes;
  return { ...withTimes, uid: crypto.randomUUID(), uidMigrated: 1 };
}

function fieldTime(row: Row, field: string): string {
  return row.fieldTimes?.[field] ?? legacyStamp(row.updatedAt);
}

/** Merges two copies of the same row, field by field. */
export function mergeRow<T extends Row>(a: T, b: T): T {
  const merged: Row = {};
  const fieldTimes: FieldTimes = {};
  const fields = new Set([...syncedFields(a), ...syncedFields(b)]);
  for (const f of fields) {
    const ta = fieldTime(a, f);
    const tb = fieldTime(b, f);
    merged[f] = ta > tb ? a[f] : tb > ta ? b[f] : pickTied(a[f], b[f]);
    const t = later(ta, tb);
    if (t && t !== EPOCH) fieldTimes[f] = t;
  }
  const out: Row = { ...merged, fieldTimes };
  const uid = earlier(a.uid, b.uid);
  if (uid) out.uid = uid;
  if (a.uidMigrated || b.uidMigrated) out.uidMigrated = 1;
  const createdAt = earlier(a.createdAt as string | undefined, b.createdAt as string | undefined);
  if (createdAt !== undefined) out.createdAt = createdAt;
  const updatedAt = later(a.updatedAt as string | undefined, b.updatedAt as string | undefined);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  return out as T;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)))
      : v
  );
}

export function sameRow(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function legacyKey(row: Row): string {
  return `${String(row.nhi ?? "")}|${String(row.createdAt ?? "")}`;
}

export interface ModuleMerge<T> {
  /** Rows whose merged value differs from this device's (carry `id`). */
  changed: T[];
  /** Rows that only exist in the other copy (no `id`). */
  added: T[];
}

/**
 * Merges this device's rows of one module with the other copy's.
 * `local` rows carry their device `id` (and profileId), which the
 * merged row keeps so it updates in place rather than duplicating.
 */
export function mergeModule<T extends Row>(local: T[], remote: T[]): ModuleMerge<T> {
  // Collapse any duplicate uids in the incoming copy first.
  const incoming = new Map<string, T>();
  for (const raw of remote) {
    const row = normaliseIncoming(raw);
    const uid = row.uid as string;
    const seen = incoming.get(uid);
    incoming.set(uid, seen ? mergeRow(seen, row) : row);
  }

  const byUid = new Map<string, T>();
  const byLegacy = new Map<string, T>();
  for (const row of local) {
    if (row.uid && !byUid.has(row.uid)) byUid.set(row.uid, row);
    if (row.uidMigrated) {
      const key = legacyKey(row);
      if (!byLegacy.has(key)) byLegacy.set(key, row);
    }
  }

  const used = new Set<T>();
  const changed: T[] = [];
  const added: T[] = [];

  for (const row of incoming.values()) {
    let match = byUid.get(row.uid as string);
    if (match && used.has(match)) match = undefined;
    // Only legacy rows may match on NHI + createdAt: anything created since
    // uids were introduced is told apart by its uid alone.
    if (!match && row.uidMigrated) {
      const candidate = byLegacy.get(legacyKey(row));
      if (candidate && !used.has(candidate)) match = candidate;
    }

    if (!match) {
      // Device-local keys from wherever the row came from mean nothing here.
      const { id: _id, profileId: _pid, ...fresh } = row;
      void _id; void _pid;
      added.push(fresh as T);
      continue;
    }

    used.add(match);
    const merged = { ...mergeRow(match, row), id: match.id, profileId: match.profileId } as T;
    if (!sameRow(merged, match)) changed.push(merged);
  }

  return { changed, added };
}

/** Merges patients, which are matched on NHI. */
export function mergePatients<T extends Row & { nhi: string }>(local: T[], remote: T[]): ModuleMerge<T> {
  const byNhi = new Map(local.map((p) => [p.nhi, p] as const));
  const changed: T[] = [];
  const added: T[] = [];
  for (const row of remote) {
    const match = byNhi.get(row.nhi);
    if (!match) {
      const { profileId: _pid, ...fresh } = row;
      void _pid;
      added.push(fresh as T);
      continue;
    }
    const merged = { ...mergeRow(match, row), profileId: match.profileId } as T;
    if (!sameRow(merged, match)) {
      changed.push(merged);
      byNhi.set(row.nhi, merged);
    }
  }
  return { changed, added };
}

/**
 * Merges the synced settings, each going to whichever device changed it
 * last. With no times on either side (settings never edited since sync
 * arrived) this device keeps its own value, unless it still holds the
 * default — a new device should take the other copy's settings.
 */
export function mergeSettings(
  local: Record<string, unknown>,
  localTimes: FieldTimes,
  remote: Record<string, unknown>,
  remoteTimes: FieldTimes,
  defaults: Record<string, unknown>,
  fields: readonly string[]
): { changes: Record<string, unknown>; fieldTimes: FieldTimes } {
  const changes: Record<string, unknown> = {};
  const fieldTimes: FieldTimes = { ...localTimes };
  for (const f of fields) {
    if (!(f in remote)) continue;
    const tl = localTimes[f] ?? EPOCH;
    const tr = remoteTimes[f] ?? EPOCH;
    const take =
      tr > tl ||
      (tr === tl && sameRow(local[f], defaults[f]) && !sameRow(remote[f], defaults[f]));
    if (take && !sameRow(local[f], remote[f])) changes[f] = remote[f];
    const t = later(tl, tr);
    if (t && t !== EPOCH) fieldTimes[f] = t;
  }
  return { changes, fieldTimes };
}

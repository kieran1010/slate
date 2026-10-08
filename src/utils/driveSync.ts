// ============================================================
// Slate — utils/driveSync.ts
// ============================================================
// Two-way Google Drive sync, modelled on Tribulator's
// (kieran1010/Tribulator, web/src/lib/sync.js).
//
// ONE ACTION — SYNC:
//   Reads the encrypted copy in Drive, merges it into this device
//   (data/syncMerge.ts: per field, latest edit wins; settings too),
//   then writes the merged result back. There is no separate backup /
//   restore: a new device simply syncs, and receives everything.
//   If another device wrote to Drive while this one was merging, the
//   file's version will have moved on, so it re-reads and merges again
//   rather than overwrite that device's changes.
//
// AUTOMATIC (when "Sync automatically" is on):
//   • on opening Slate (a couple of seconds after launch), and when it
//     returns to the foreground after a while;
//   • shortly after each change to patients, records or settings;
//   • when the device comes back online;
//   • pending changes are flushed when the app is hidden, if a Drive
//     token is already in hand.
//
// AUTH:
//   Automatic syncs ask Google for a token silently (prompt "none") —
//   no popup, no re-authenticating. If Google won't issue one without
//   a tap (e.g. access was revoked), the sync stops quietly with state
//   "needs-reconnect", and the next Sync now tap fixes it.
//
// PASSPHRASE:
//   The Drive copy is encrypted with the passphrase saved on this
//   device. If it won't open the Drive copy (state "wrong-passphrase"),
//   nothing is overwritten; the user can correct the passphrase, or
//   explicitly replace the Drive copy (replaceDriveCopy).
//
// FILE LOCATION:
//   src/utils/driveSync.ts
// ============================================================

import Dexie from "dexie";
import { db } from "../data/db";
import { getConfig, saveConfig, applySyncPayload, isSyncTransaction, type ImportPayload } from "../data/repository";
import { BACKUP_SETTINGS_FIELDS } from "../data/models";
import { buildEncryptedPayload, decryptBackup } from "./exportImport";
import { WrongPassphraseError } from "./crypto";
import {
  isDriveConfigured,
  getDriveToken,
  peekDriveToken,
  findBackupFile,
  getFileMetadata,
  readBackupFile,
  writeBackupFile,
  DriveNotFoundError,
  type DriveFile,
} from "./googleDrive";

export type DriveSyncState =
  | "off"              // sync switched off
  | "idle"             // on, nothing pending
  | "pending"          // changes waiting for the debounce
  | "syncing"
  | "synced"
  | "needs-reconnect"  // Google wouldn't issue a token without a tap
  | "wrong-passphrase" // this device's passphrase can't open the Drive copy
  | "error";

export interface DriveSyncStatus {
  state: DriveSyncState;
  lastSyncedAt: number | null;
  message: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  settingsChanged: boolean;
  at: number;
}

/** A device that hasn't synced for this long is prompted to reconnect. */
export const DRIVE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when sync is on and this device last synced over 7 days ago. With
 * automatic sync working that never happens, so in practice it means
 * automatic sync has been failing (or is off and Sync now wasn't used).
 * A device that has never synced is not "overdue".
 */
export function isDriveSyncStale(
  config: { driveBackupEnabled: boolean; driveLastSyncedAt: number },
  now = Date.now()
): boolean {
  return (
    config.driveBackupEnabled &&
    config.driveLastSyncedAt > 0 &&
    now - config.driveLastSyncedAt > DRIVE_STALE_MS
  );
}

// ── Status store (for useSyncExternalStore) ───────────────────

let status: DriveSyncStatus = { state: "idle", lastSyncedAt: null, message: "" };
const listeners = new Set<() => void>();

function setStatus(next: Partial<DriveSyncStatus>): void {
  status = { ...status, message: "", ...next };
  listeners.forEach((l) => l());
}

export function subscribeDriveSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getDriveSyncStatus(): DriveSyncStatus {
  return status;
}

// ── The sync itself ───────────────────────────────────────────

class NeedsReconnectError extends Error {}

// How long a silent (automatic) sync waits for Google before giving up.
const SILENT_TOKEN_TIMEOUT_MS = 8000;

async function resolveFile(token: string, knownId: string): Promise<DriveFile | null> {
  if (knownId) {
    try {
      return await getFileMetadata(token, knownId);
    } catch (err) {
      // Deleted from Drive, or a different Google account now — look it
      // up by name instead. Anything else (offline, refused) is real.
      if (!(err instanceof DriveNotFoundError)) throw err;
    }
  }
  return findBackupFile(token);
}

async function readRemote(token: string, file: DriveFile, passphrase: string): Promise<ImportPayload> {
  const text = await readBackupFile(token, file.id);
  return decryptBackup(text, passphrase);
}

async function runSync(interactive: boolean): Promise<SyncResult> {
  if (!isDriveConfigured()) throw new Error("Google Drive sync isn't set up in this version of Slate.");
  if (!navigator.onLine) throw new Error("You're offline. Slate will sync when you're back online.");

  // The token comes first: an interactive request must reach Google while
  // the tap that started it still counts as a user gesture.
  let token: string;
  try {
    token = await getDriveToken({ interactive, timeoutMs: interactive ? undefined : SILENT_TOKEN_TIMEOUT_MS });
  } catch (err) {
    if (interactive) throw err;
    throw new NeedsReconnectError(err instanceof Error ? err.message : "Couldn't reach Google.");
  }

  const config = await getConfig();
  const passphrase = config.encryptionPassphrase;
  if (!passphrase.trim()) throw new Error("Set an encryption passphrase in Settings before syncing.");

  let file = await resolveFile(token, config.driveFileId);
  const totals = { added: 0, updated: 0, settingsChanged: false };

  // Merge, then make sure no other device wrote meanwhile; if one did,
  // merge its version too. Twice is plenty in practice.
  for (let round = 0; round < 3; round++) {
    const remote = file ? await readRemote(token, file, passphrase) : null;
    const stats = await applySyncPayload(remote);
    totals.added += stats.added;
    totals.updated += stats.updated;
    totals.settingsChanged ||= stats.settingsChanged;
    if (!file) break;
    const current = await getFileMetadata(token, file.id);
    if (current.version === file.version) break;
    file = current;
  }

  const encrypted = await buildEncryptedPayload(passphrase);
  const written = await writeBackupFile(token, encrypted, file?.id ?? null);
  const at = Date.now();
  await saveConfig({ driveFileId: written.id, driveLastSyncedAt: at });
  return { ...totals, at };
}

let inFlight: Promise<SyncResult> | null = null;
let dirty = false; // changes made since the last sync started

/**
 * Syncs with Drive now. Concurrent callers share one run. Interactive
 * calls (from a tap) may show Google's consent popup; automatic ones
 * never do. Rejects with the reason on failure (status says it too).
 */
export async function syncNow({ interactive = true } = {}): Promise<SyncResult> {
  if (inFlight) {
    if (!interactive) return inFlight;
    // A silent run may fail for want of a token that this tap can get.
    await inFlight.catch(() => {});
    if (inFlight) return inFlight;
  }
  if (timer) { clearTimeout(timer); timer = null; }
  dirty = false;
  setStatus({ state: "syncing" });
  lastAttemptAt = Date.now();
  const run = runSync(interactive);
  inFlight = run;
  try {
    const result = await run;
    setStatus({ state: dirty ? "pending" : "synced", lastSyncedAt: result.at });
    if (dirty) schedule(DEBOUNCE_MS);
    return result;
  } catch (err) {
    dirty = true; // whatever was waiting still is
    const message = err instanceof Error ? err.message : "Sync failed.";
    if (err instanceof NeedsReconnectError) setStatus({ state: "needs-reconnect", message });
    else if (err instanceof WrongPassphraseError) setStatus({ state: "wrong-passphrase", message });
    else setStatus({ state: "error", message });
    if (!(err instanceof NeedsReconnectError) && !(err instanceof WrongPassphraseError)) {
      console.error("Drive sync failed:", err);
    }
    throw err;
  } finally {
    inFlight = null;
  }
}

/**
 * Overwrites the Drive copy with this device's data, without reading it
 * first. Only for when this device's passphrase can't open the Drive
 * copy and the user has confirmed they want to replace it. Interactive.
 */
export async function replaceDriveCopy(): Promise<void> {
  const token = await getDriveToken({ interactive: true });
  const config = await getConfig();
  if (!config.encryptionPassphrase.trim()) throw new Error("Set an encryption passphrase first.");
  const file = await resolveFile(token, config.driveFileId);
  const encrypted = await buildEncryptedPayload(config.encryptionPassphrase);
  const written = await writeBackupFile(token, encrypted, file?.id ?? null);
  const at = Date.now();
  await saveConfig({ driveFileId: written.id, driveLastSyncedAt: at });
  dirty = false;
  setStatus({ state: "synced", lastSyncedAt: at });
}

// ── Automatic sync ────────────────────────────────────────────

const DEBOUNCE_MS = 10_000;
// After launch, wait until there's something on screen: a silent token
// refresh can briefly flash Google's page, which reads as the app opening
// to the wrong thing if it lands before the first paint.
const LAUNCH_DELAY_MS = 2500;
// Returning to the foreground re-syncs if it's been at least this long.
const RESUME_AFTER_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let lastAttemptAt = 0;

async function autoSyncAllowed(): Promise<boolean> {
  if (!isDriveConfigured() || !navigator.onLine) return false;
  try {
    const c = await getConfig();
    return c.driveBackupEnabled && c.driveAutoSyncEnabled && !!c.encryptionPassphrase.trim();
  } catch {
    return false; // no profile yet, or mid-erase
  }
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      if (!(await autoSyncAllowed())) return;
      // A passphrase that can't open the Drive copy won't fix itself.
      if (status.state === "wrong-passphrase") return;
      syncNow({ interactive: false }).catch(() => {
        if (status.state === "error") schedule(RETRY_MS);
      });
    })();
  }, delay);
}

function onLocalChange(): void {
  dirty = true;
  // Hooks run inside the edit's own transaction, which can't read config;
  // step outside it before looking anything up.
  void Dexie.ignoreTransaction(() => autoSyncAllowed()).then((ok) => {
    if (!ok) return;
    if (status.state !== "syncing" && status.state !== "wrong-passphrase") {
      setStatus({ state: "pending", message: status.state === "needs-reconnect" ? status.message : "" });
    }
    schedule(DEBOUNCE_MS);
  });
}

/** Registers the change hooks and the launch sync. Call once, after the profile is ready. */
export function startDriveSync(): void {
  if (started) return;
  started = true;

  for (const table of [db.patients, db.acute, db.preAssess, db.followUp]) {
    table.hook("creating", (_key, _obj, tx) => { if (!isSyncTransaction(tx)) onLocalChange(); });
    table.hook("updating", (_mods, _key, _obj, tx) => { if (!isSyncTransaction(tx)) onLocalChange(); });
    table.hook("deleting", (_key, _obj, tx) => { if (!isSyncTransaction(tx)) onLocalChange(); });
  }
  // Settings travel with the sync too, but the config row also holds
  // per-device bookkeeping (e.g. the last-synced time) that mustn't
  // trigger a sync of its own.
  db.config.hook("updating", (mods, _key, _obj, tx) => {
    if (isSyncTransaction(tx)) return;
    if (BACKUP_SETTINGS_FIELDS.some((f) => f in (mods as Record<string, unknown>))) onLocalChange();
  });

  window.addEventListener("online", () => {
    void autoSyncAllowed().then((ok) => { if (ok && (dirty || status.state !== "synced")) schedule(0); });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // Flush waiting changes before the app is closed — but only with a
      // token already in hand, since a hidden page can't reach Google.
      if (dirty && timer && peekDriveToken()) schedule(0);
    } else if (Date.now() - lastAttemptAt > RESUME_AFTER_MS) {
      schedule(LAUNCH_DELAY_MS);
    }
  });

  getConfig()
    .then((c) => {
      if (c.driveLastSyncedAt) setStatus({ state: status.state, lastSyncedAt: c.driveLastSyncedAt });
      if (!c.driveBackupEnabled) setStatus({ state: "off" });
    })
    .catch(console.error);

  lastAttemptAt = Date.now();
  schedule(LAUNCH_DELAY_MS);
}

/** Call when sync or its automatic option is switched on or off. */
export function driveSyncSettingsChanged(enabled: boolean, auto: boolean): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!enabled) { dirty = false; setStatus({ state: "off" }); return; }
  if (status.state === "off") setStatus({ state: "idle" });
  // Switching automatic sync back on catches up on anything edited
  // while it was off.
  if (auto) schedule(0);
}

/** Call after this device's data has been erased. */
export function resetDriveSync(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  dirty = false;
  setStatus({ state: "off", lastSyncedAt: null });
}

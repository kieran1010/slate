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
// AUTOMATIC (always, while sync is on):
//   • on opening Slate (a couple of seconds after launch), and when it
//     returns to the foreground after a while;
//   • shortly after each change to patients, records or settings;
//   • when the device comes back online;
//   • pending changes are flushed when the app is hidden, if a Drive
//     token is already in hand.
//
// AUTH:
//   Automatic syncs ask Google for a token silently (prompt "none").
//   Tokens last about an hour, and are kept (googleDrive.ts) so that
//   reopening Slate within that hour syncs without asking Google again.
//   Google renews one through a small window of its own,
//   which a browser only lets open from a tap — so a background renewal
//   is usually blocked (always, in practice, on Android). The sync then
//   stops with state "needs-reconnect", and the header shows a "Tap to
//   sync" button (components/Brand.tsx): that tap, or Sync now in
//   Settings, gets a new token and syncs. Taps that save a change
//   (Save, Archive, Delete, Restore) also renew an expired token on the
//   way (renewDriveAccessOnTap), so the button is rarely needed. Failed
//   syncs (state "error") show the same button. Changes made meanwhile
//   wait, and sync then.
//
//   BACKGROUND SYNC: once a device is connected to the Hypnos sign-in
//   server (done when Drive sync is switched on; utils/driveLink.ts), its tokens
//   come from the server instead, with no window and no tap, so all of
//   the above is only the fallback for when the server can't help.
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
  preloadGoogleSignIn,
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

// Whether sync and automatic sync are on, as last read from settings.
// Kept in memory for renewDriveAccessOnTap, which has to ask Google
// within the tap and can't wait for the database first.
let autoOn = false;

// Sync is always automatic while it's on (there's no longer a switch for
// it); config.driveAutoSyncEnabled is ignored.
function autoFromConfig(c: { driveBackupEnabled: boolean; encryptionPassphrase: string }): boolean {
  return c.driveBackupEnabled && !!c.encryptionPassphrase.trim();
}

async function autoSyncAllowed(): Promise<boolean> {
  if (!isDriveConfigured() || !navigator.onLine) return false;
  try {
    autoOn = autoFromConfig(await getConfig());
    return autoOn;
  } catch {
    return false; // no profile yet, or mid-erase
  }
}

// After a tap renews Google access, sync this soon (the change the tap
// saved would otherwise wait for the usual 10-second debounce).
const TAP_SYNC_DELAY_MS = 1500;
let renewing = false;

/**
 * Call at the very start of a tap that saves a change — Save, Archive,
 * Delete, Restore — before any await (a confirm() first is fine). If
 * automatic sync is on and Google's access has run out, this uses the
 * tap to renew it: Google only lets its sign-in window open from a tap,
 * which is why a background renewal fails. It asks silently (prompt
 * "none"), so Google's window just flashes up and closes; if Google
 * wants more than that (e.g. a password), it gives up quietly and the
 * header's "Tap to sync" stays. Does nothing while access is valid.
 */
export function renewDriveAccessOnTap(): void {
  if (!autoOn || renewing || !isDriveConfigured() || !navigator.onLine || peekDriveToken()) return;
  renewing = true;
  getDriveToken({ interactive: false, timeoutMs: SILENT_TOKEN_TIMEOUT_MS })
    .then(() => { schedule(TAP_SYNC_DELAY_MS); })
    .catch(() => { /* see above: the header's Tap to sync remains */ })
    .finally(() => { renewing = false; });
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
    // Only a healthy state becomes "pending". A failure stays on show
    // (in Settings and the header) until a sync actually succeeds:
    // "Changes will sync shortly" would be untrue while Google needs a tap.
    if (status.state === "idle" || status.state === "synced") setStatus({ state: "pending" });
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
      autoOn = autoFromConfig(c);
      // Have Google's script ready for renewDriveAccessOnTap.
      if (autoOn && isDriveConfigured()) preloadGoogleSignIn();
    })
    .catch(console.error);

  lastAttemptAt = Date.now();
  schedule(LAUNCH_DELAY_MS);
}

/** Call when sync is switched on or off. */
export function driveSyncSettingsChanged(enabled: boolean): void {
  if (timer) { clearTimeout(timer); timer = null; }
  autoOn = enabled;
  if (!enabled) { dirty = false; setStatus({ state: "off" }); return; }
  if (status.state === "off") setStatus({ state: "idle" });
}

/** Call after this device's data has been erased. */
export function resetDriveSync(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  autoOn = false;
  dirty = false;
  setStatus({ state: "off", lastSyncedAt: null });
}

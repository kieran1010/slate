// ============================================================
// Slate — utils/driveAutoSync.ts
// ============================================================
// Automatic Google Drive sync, when "Sync with Google Drive" and its
// "Sync automatically" option are both on.
//
// TRIGGER:
//   Any change to patients / acute / pre-assess / follow-up schedules
//   an upload 30 s after the last change (debounced). Pending changes
//   are also flushed as soon as the app is hidden or closed.
//
// AUTH:
//   The Drive token is kept in memory only and Google's consent popup
//   needs a tap, so auto-sync never asks for a token. It uploads only
//   while a valid token exists (after a manual Sync now / Restore this
//   session, ~1 hour). When the token lapses it stops and reports
//   "needs-reconnect"; the user taps Reconnect on the Backup screen.
//
// CONFLICTS:
//   Drive holds one backup file. If it isn't the one this device last
//   wrote or restored (driveFileId), auto-sync never overwrites it: it
//   pauses with status "conflict" until the user resolves it with
//   Sync now (which shows the overwrite confirm) or Restore.
//
// FILE LOCATION:
//   src/utils/driveAutoSync.ts
// ============================================================

import { db } from "../data/db";
import { getConfig, saveConfig } from "../data/repository";
import { buildEncryptedPayload } from "./exportImport";
import { findBackupFile, peekDriveToken, writeBackupFile } from "./googleDrive";

export type AutoSyncState =
  | "off"             // toggle off, or no passphrase saved
  | "idle"            // enabled, nothing pending
  | "pending"         // changes waiting for the debounce
  | "syncing"
  | "synced"
  | "needs-reconnect" // changes waiting, no valid Drive token
  | "conflict"        // Drive holds a backup this device didn't write
  | "error";

export interface AutoSyncStatus {
  state: AutoSyncState;
  lastSyncedAt: number | null;
  message: string;
}

const DEBOUNCE_MS = 30_000;

/** A device that hasn't synced for this long is prompted to reconnect. */
export const DRIVE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** True when sync is on but this device hasn't synced in over 7 days (or ever). */
export function isDriveSyncStale(
  config: { driveBackupEnabled: boolean; driveLastSyncedAt: number },
  now = Date.now()
): boolean {
  return config.driveBackupEnabled && now - config.driveLastSyncedAt > DRIVE_STALE_MS;
}

let status: AutoSyncStatus = { state: "idle", lastSyncedAt: null, message: "" };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let dirty = false;   // changes not yet uploaded
let running = false;
let autoEnabled = true; // mirrors config.driveAutoSyncEnabled

function setStatus(next: Partial<AutoSyncStatus>): void {
  status = { ...status, message: "", ...next };
  listeners.forEach((l) => l());
}

export function subscribeAutoSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getAutoSyncStatus(): AutoSyncStatus {
  return status;
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void runAutoSync(); }, delay);
}

function onDataChanged(): void {
  if (!autoEnabled) return;
  dirty = true;
  // A paused (conflict) or errored sync stays visible until resolved.
  if (status.state !== "conflict") setStatus({ state: "pending", lastSyncedAt: status.lastSyncedAt });
  schedule(DEBOUNCE_MS);
}

async function runAutoSync(manual = false): Promise<void> {
  if (running || !dirty) return;
  if (!manual && !autoEnabled) { dirty = false; return; }
  running = true;
  try {
    const config = await getConfig();
    if (!config.driveBackupEnabled || !config.encryptionPassphrase.trim()) {
      dirty = false;
      setStatus({ state: "off", lastSyncedAt: status.lastSyncedAt });
      return;
    }
    const token = peekDriveToken();
    if (!token) {
      setStatus({ state: "needs-reconnect", lastSyncedAt: status.lastSyncedAt });
      return;
    }
    setStatus({ state: "syncing", lastSyncedAt: status.lastSyncedAt });
    const existing = await findBackupFile(token);
    if (existing && existing.id !== config.driveFileId) {
      setStatus({ state: "conflict", lastSyncedAt: status.lastSyncedAt });
      return;
    }
    // Clear before building so a change made mid-upload re-marks dirty.
    dirty = false;
    try {
      const encrypted = await buildEncryptedPayload(config.encryptionPassphrase);
      const file = await writeBackupFile(token, encrypted, existing?.id ?? null);
      await saveConfig({ driveFileId: file.id, driveLastSyncedAt: Date.now() });
    } catch (err) {
      dirty = true;
      throw err;
    }
    setStatus({ state: dirty ? "pending" : "synced", lastSyncedAt: Date.now() });
  } catch (err) {
    console.error("Drive auto-sync failed:", err);
    setStatus({
      state: "error",
      lastSyncedAt: status.lastSyncedAt,
      message: err instanceof Error ? err.message : "Auto-sync failed.",
    });
    schedule(5 * 60_000); // retry later; dirty is still set
  } finally {
    running = false;
    if (dirty && status.state === "pending") schedule(DEBOUNCE_MS);
  }
}

/** Registers the change hooks. Call once, after the profile is ready. */
export function startDriveAutoSync(): void {
  if (started) return;
  started = true;
  getConfig()
    .then((c) => { autoEnabled = c.driveAutoSyncEnabled; })
    .catch(console.error);
  for (const table of [db.patients, db.acute, db.preAssess, db.followUp]) {
    table.hook("creating", () => { onDataChanged(); });
    table.hook("updating", () => { onDataChanged(); });
    table.hook("deleting", () => { onDataChanged(); });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dirty) {
      if (timer) clearTimeout(timer);
      void runAutoSync();
    }
  });
}

/** Call after a manual backup or restore: Drive and this device now agree. */
export function noteDriveSynced(): void {
  saveConfig({ driveLastSyncedAt: Date.now() }).catch((err) => console.error("Saving sync time failed:", err));
  dirty = false;
  if (timer) clearTimeout(timer);
  setStatus({ state: "synced", lastSyncedAt: Date.now() });
}

/**
 * Syncs immediately, whether or not anything changed. Needs a valid token
 * (call getDriveToken from a tap first). Resolves to the resulting state:
 * "synced", "conflict" (Drive holds another device's backup), "off" (no
 * passphrase saved) or "error".
 */
export async function syncDriveNow(): Promise<AutoSyncState> {
  dirty = true;
  if (timer) clearTimeout(timer);
  if (status.state === "conflict") setStatus({ state: "idle", lastSyncedAt: status.lastSyncedAt });
  await runAutoSync(true);
  return status.state;
}

/** Call after the user reconnects (fresh token) to flush waiting changes. */
export function resumeAutoSync(): void {
  if (status.state === "conflict") setStatus({ state: "idle", lastSyncedAt: status.lastSyncedAt });
  if (dirty) schedule(0);
}

/**
 * Call when the "Sync automatically" toggle changes. Turning it on marks
 * the device as having changes to send, so the next run catches up on
 * anything edited while it was off.
 */
export function setAutoSyncEnabled(enabled: boolean): void {
  autoEnabled = enabled;
  if (timer) clearTimeout(timer);
  if (enabled) {
    dirty = true;
    setStatus({ state: "pending", lastSyncedAt: status.lastSyncedAt });
    schedule(DEBOUNCE_MS);
  } else {
    dirty = false;
    setStatus({ state: "idle", lastSyncedAt: status.lastSyncedAt });
  }
}

/** Call when the toggle is switched off. */
export function stopAutoSync(): void {
  dirty = false;
  if (timer) clearTimeout(timer);
  setStatus({ state: "off", lastSyncedAt: status.lastSyncedAt });
}

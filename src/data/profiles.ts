// ============================================================
// Charted PWA — profiles.ts
// ============================================================
// Minimal management of LOCAL PROFILES (per-device multi-user).
// This is the small layer that answers: "who is the active
// clinician on this device, and what profiles exist?"
//
// It deliberately knows nothing about patients or records — it
// only manages the profile list and the active selection. The
// repository (next step) will read the active profile id from
// here and scope every patient/record query to it.
//
// Nothing here uses localStorage: the active selection is kept
// in the `meta` table in IndexedDB, so it survives reloads and
// is testable outside a browser.
//
// FILE LOCATION:
//   src/data/profiles.ts
// ============================================================

import { db, type Profile } from "./db";

// The meta-table key under which we store the active profile id.
const ACTIVE_PROFILE_KEY = "activeProfileId";

// ── listProfiles ─────────────────────────────────────────────
// All profiles on this device, sorted by name for display.
export async function listProfiles(): Promise<Profile[]> {
  return db.profiles.orderBy("name").toArray();
}

// ── createProfile ────────────────────────────────────────────
// Create a new profile and return it. Does NOT change which
// profile is active — the caller decides that.
export async function createProfile(name: string): Promise<Profile> {
  const profile: Profile = {
    id: crypto.randomUUID(), // available in browsers and Node 18+
    name: name.trim(),
    createdAt: new Date().toISOString(), // system metadata; UTC is fine
  };
  await db.profiles.add(profile);
  return profile;
}

// ── getActiveProfileId ───────────────────────────────────────
// The id of the active profile, or null if none is set yet.
export async function getActiveProfileId(): Promise<string | null> {
  const row = await db.meta.get(ACTIVE_PROFILE_KEY);
  return row?.value ?? null;
}

// ── setActiveProfileId ───────────────────────────────────────
// Record which profile is active (upsert into the meta table).
export async function setActiveProfileId(id: string): Promise<void> {
  await db.meta.put({ key: ACTIVE_PROFILE_KEY, value: id });
}

// ── ensureActiveProfile ──────────────────────────────────────
// Guarantees there is a usable active profile and returns it.
// Logic, in order:
//   1. If an active id is set AND that profile still exists → use it.
//   2. Else if any profiles exist → activate the first one.
//   3. Else → create a starter profile and activate it.
// Call this once at app startup, before showing any data.
export async function ensureActiveProfile(
  starterName = "Default profile"
): Promise<Profile> {
  const activeId = await getActiveProfileId();
  if (activeId) {
    const existing = await db.profiles.get(activeId);
    if (existing) return existing;
  }

  const all = await db.profiles.orderBy("name").toArray();
  const profile = all[0] ?? (await createProfile(starterName));
  await setActiveProfileId(profile.id);
  return profile;
}

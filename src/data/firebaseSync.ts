// ============================================================
// Slate — data/firebaseSync.ts
// ============================================================
// Reads and writes the current user's settings to Firestore.
//
// WHAT IS SYNCED:
//   AppConfig fields — clinician profile, app defaults, AI key
//   toggle + key, and whether Google Drive backup is switched on.
//
// WHAT IS NEVER SYNCED:
//   Patient data. All clinical records remain in IndexedDB on
//   the local device. Firestore is used ONLY for user settings.
//   The backup passphrase and Drive file ID are also kept off
//   the server (LOCAL_ONLY_CONFIG_FIELDS) — stripped here in both
//   directions, whatever the caller passes.
//
// LEGACY FIELDS:
//   Earlier versions synced the passphrase and a Google Doc ID.
//   loadRemoteSettings() deletes those from Firestore the first
//   time it sees them.
//
// FIRESTORE PATH:
//   userSettings/{uid}   (one document per user)
//
// SECURITY:
//   Firestore rules allow read/write only when
//   request.auth.uid == userId, so users only access their own
//   document.
//
// FILE LOCATION:
//   src/data/firebaseSync.ts
// ============================================================

import { deleteField, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { firestoreDb } from "../firebase";
import { LOCAL_ONLY_CONFIG_FIELDS, type AppConfig } from "./models";

// Fields older versions of Slate wrote to Firestore that must not
// stay there: the plaintext backup passphrase, and the old Google Docs
// backup settings.
const LEGACY_REMOTE_FIELDS = ["encryptionPassphrase", "gdocsEnabled", "gdocsDocId"];

function withoutLocalOnly(settings: Partial<AppConfig>): Partial<AppConfig> {
  const copy: Record<string, unknown> = { ...settings };
  for (const f of [...LOCAL_ONLY_CONFIG_FIELDS, ...LEGACY_REMOTE_FIELDS]) delete copy[f];
  return copy as Partial<AppConfig>;
}

async function purgeLegacyFields(uid: string, data: Record<string, unknown>): Promise<void> {
  const legacy = LEGACY_REMOTE_FIELDS.filter((f) => f in data);
  if (legacy.length === 0) return;
  try {
    await updateDoc(
      doc(firestoreDb, "userSettings", uid),
      Object.fromEntries(legacy.map((f) => [f, deleteField()]))
    );
  } catch (err) {
    // Retried on the next load; never blocks reading settings.
    console.error("Failed to remove legacy settings from Firestore:", err);
  }
}

/**
 * Deletes legacy fields (notably the old plaintext passphrase) from the
 * user's Firestore document. App runs this once per signed-in session so
 * the cleanup doesn't wait for the user to open Settings.
 */
export async function purgeLegacyRemoteSettings(uid: string): Promise<void> {
  try {
    const snap = await getDoc(doc(firestoreDb, "userSettings", uid));
    if (snap.exists()) await purgeLegacyFields(uid, snap.data());
  } catch (err) {
    console.error("Legacy settings check failed:", err);
  }
}

export async function loadRemoteSettings(
  uid: string
): Promise<Partial<AppConfig>> {
  try {
    const ref = doc(firestoreDb, "userSettings", uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return {};
    const data = snap.data();
    await purgeLegacyFields(uid, data);
    return withoutLocalOnly(data as Partial<AppConfig>);
  } catch (err) {
    // Fail silently (e.g. offline) — callers use local defaults.
    console.error("Failed to load remote settings:", err);
    return {};
  }
}

export async function saveRemoteSettings(
  uid: string,
  settings: Partial<AppConfig>
): Promise<void> {
  const ref = doc(firestoreDb, "userSettings", uid);
  // merge: true leaves any extra fields in Firestore untouched
  // (safe when adding new fields in later batches).
  await setDoc(ref, withoutLocalOnly(settings), { merge: true });
}

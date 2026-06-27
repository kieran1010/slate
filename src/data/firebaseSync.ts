// ============================================================
// Slate — data/firebaseSync.ts
// ============================================================
// Reads and writes the current user's settings to Firestore.
//
// WHAT IS SYNCED:
//   All AppConfig fields — clinician profile, app defaults,
//   AI key toggle + key. Future batches will add the encryption
//   passphrase and GDocs integration settings here too.
//
// WHAT IS NEVER SYNCED:
//   Patient data. All clinical records remain in IndexedDB on
//   the local device. Firestore is used ONLY for user settings.
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

import { doc, getDoc, setDoc } from "firebase/firestore";
import { firestoreDb } from "../firebase";
import type { AppConfig } from "./models";

export async function loadRemoteSettings(
  uid: string
): Promise<Partial<AppConfig>> {
  try {
    const ref = doc(firestoreDb, "userSettings", uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return {};
    return snap.data() as Partial<AppConfig>;
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
  await setDoc(ref, settings, { merge: true });
}

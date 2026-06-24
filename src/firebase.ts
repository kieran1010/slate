// ============================================================
// Slate — firebase.ts
// ============================================================
// Initialises the Firebase app and exports the Auth and
// Firestore instances used throughout the app.
//
// The config values below are safe to commit — Firebase
// security is enforced by Auth and Firestore security rules,
// not by keeping these values secret.
//
// WHAT FIREBASE IS USED FOR IN SLATE:
//   • Auth    — email/password + Google sign-in
//   • Firestore — one document per user (userSettings/{uid})
//                 storing settings only. Patient data NEVER
//                 leaves the device.
//
// FILE LOCATION:
//   src/firebase.ts
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBXd4H83BWkvZgDbfWwgDneLPGypF9K1e0",
  authDomain: "slate-9bae0.firebaseapp.com",
  projectId: "slate-9bae0",
  storageBucket: "slate-9bae0.firebasestorage.app",
  messagingSenderId: "747803477750",
  appId: "1:747803477750:web:9d9e24f3455f2152b90ed7",
};

const app = initializeApp(firebaseConfig);

// Firebase Authentication instance.
export const firebaseAuth = getAuth(app);

// Firestore instance — used only for settings sync.
// Exported as `firestoreDb` to avoid naming collision with the
// Dexie `db` export from src/data/db.ts.
export const firestoreDb = getFirestore(app);

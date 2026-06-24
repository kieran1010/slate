// ============================================================
// Slate — hooks/useAuth.ts
// ============================================================
// Subscribes to Firebase Auth state and returns the current
// user (or null) and a loading flag.
//
// The loading flag is true only on initial mount while Firebase
// resolves the persisted session — it drops false within a
// fraction of a second. Components use it to avoid flashing the
// "sign in" form before Firebase has restored the session.
//
// FILE LOCATION:
//   src/hooks/useAuth.ts
// ============================================================

import { useState, useEffect } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { firebaseAuth } from "../firebase";

export interface AuthState {
  user: User | null;
  loading: boolean;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true, // assume loading until Firebase responds
  });

  useEffect(() => {
    // onAuthStateChanged fires immediately with the current
    // persisted session (or null), then on every auth change.
    const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
      setState({ user, loading: false });
    });
    return unsubscribe; // cleans up the listener on unmount
  }, []);

  return state;
}

// ============================================================
// Charted PWA — hooks/useConfig.ts
// ============================================================
// A thin wrapper around useLiveQuery so any screen can read the
// current AppConfig reactively — it re-renders whenever the
// config row in IndexedDB changes (e.g. after the user saves
// Settings). No prop-drilling or React Context needed.
//
// Returns DEFAULT_APP_CONFIG while the first query is in flight
// (a fraction of a second on app load) so callers always get a
// fully-typed object, never undefined.
//
// FILE LOCATION:
//   src/hooks/useConfig.ts
// ============================================================

import { useLiveQuery } from "dexie-react-hooks";
import { getConfig } from "../data/repository";
import { DEFAULT_APP_CONFIG } from "../data/models";
import type { AppConfig } from "../data/models";

export function useConfig(): AppConfig {
  return (
    useLiveQuery(() => getConfig(), [], DEFAULT_APP_CONFIG) ??
    DEFAULT_APP_CONFIG
  );
}

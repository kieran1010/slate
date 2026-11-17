// ============================================================
// Slate — hooks/usePatientLookup.ts
// ============================================================
// The NHI lookup behind components/PatientFields.tsx.
//
// FILE LOCATION:
//   src/hooks/usePatientLookup.ts
// ============================================================

import { useEffect, useRef, useState } from "react";
import { getPatient } from "../data/repository";
import type { Patient } from "../data/models";

export type PatientStatus = "idle" | "found" | "new";

/**
 * Looks the NHI up (400 ms after typing stops) and reports whether it
 * belongs to a known patient. When the NHI changes to one that is known,
 * onFound gets that patient so the form can show their details. Starts
 * once `ready` (the record has loaded): the NHI the form holds then is
 * the one its details already belong to, so the first lookup doesn't
 * overwrite them.
 */
export function usePatientLookup(
  nhi: string,
  ready: boolean,
  onFound: (patient: Patient) => void
): PatientStatus {
  const key = nhi.trim().toUpperCase();
  const [result, setResult] = useState<{ key: string; found: boolean } | null>(null);
  // The NHI whose details the form currently shows.
  const shownFor = useRef<string | null>(null);
  const onFoundRef = useRef(onFound);
  useEffect(() => { onFoundRef.current = onFound; });

  useEffect(() => {
    if (!ready) return;
    if (shownFor.current === null) shownFor.current = key;
    if (key.length < 3) return;
    const timer = setTimeout(async () => {
      const patient = await getPatient(key);
      setResult({ key, found: !!patient });
      if (patient && key !== shownFor.current) onFoundRef.current(patient);
      shownFor.current = key;
    }, 400);
    return () => clearTimeout(timer);
  }, [key, ready]);

  if (key.length < 3 || !result || result.key !== key) return "idle";
  return result.found ? "found" : "new";
}

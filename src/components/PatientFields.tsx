// ============================================================
// Slate — components/PatientFields.tsx
// ============================================================
// The Patient section of every record (acute, pre-assessment,
// follow-up): NHI, surname, given name and date of birth, always
// editable — on new records and existing ones.
//
// WHERE EDITS GO:
//   • Name and date of birth belong to the patient (the master row
//     keyed on NHI), so saving them updates every record with that NHI.
//   • The NHI belongs to the record: changing it moves the record to
//     that patient. If the NHI is already known, that patient's name
//     and date of birth fill in (usePatientLookup below).
// The screens' own Save does the writing (upsertPatient + the record).
//
// FILE LOCATION:
//   src/components/PatientFields.tsx
// ============================================================

import { useEffect, useRef, useState } from "react";
import { getPatient } from "../data/repository";
import { calculateAge, type Patient } from "../data/models";
import { capitalCase } from "../utils/format";

export type PatientStatus = "idle" | "found" | "new";

type IdentityField = "nhi" | "surname" | "givenName" | "dob";

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

interface PatientFieldsProps {
  /** Prefix for the inputs' ids, unique per screen. */
  idPrefix: string;
  nhi: string;
  surname: string;
  givenName: string;
  dob: string;
  onChange: (field: IdentityField, value: string) => void;
  status: PatientStatus;
  /** The NHI the saved record has; undefined for a record not yet saved. */
  savedNhi?: string;
  nhiError?: string;
}

export function PatientFields({
  idPrefix, nhi, surname, givenName, dob, onChange, status, savedNhi, nhiError,
}: PatientFieldsProps) {
  const age = dob ? calculateAge(dob) : "";
  const moving = savedNhi !== undefined && nhi.trim().toUpperCase() !== savedNhi;

  let nhiNote: { found: boolean; text: string } | null = null;
  if (savedNhi === undefined) {
    if (status === "found") nhiNote = { found: true, text: "✓ Existing patient" };
    if (status === "new") nhiNote = { found: false, text: "New patient — enter name below" };
  } else if (moving) {
    if (status === "found") nhiNote = { found: true, text: "✓ Existing patient — this record moves to them when you save" };
    if (status === "new") nhiNote = { found: false, text: "New NHI — this record moves to it when you save" };
  }

  return (
    <section className="form-section" aria-label="Patient identity">
      <div className="form-section-title">Patient</div>

      <div className={`form-field${nhiError ? " form-field-error" : ""}`}>
        <label className="form-label form-label-req" htmlFor={`${idPrefix}-nhi`}>NHI</label>
        <input id={`${idPrefix}-nhi`} className="form-input" type="text"
          placeholder="e.g. ABC1234"
          value={nhi}
          onChange={(e) => onChange("nhi", e.target.value.toUpperCase())}
          autoCapitalize="characters" autoCorrect="off" spellCheck={false}
          style={{ letterSpacing: "0.04em" }}
        />
        {nhiNote && (
          <span className={`nhi-status ${nhiNote.found ? "nhi-status-found" : "nhi-status-new"}`}>
            {nhiNote.text}
          </span>
        )}
        {nhiError && <span className="form-error" role="alert">{nhiError}</span>}
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-surname`}>Surname</label>
        <input id={`${idPrefix}-surname`} className="form-input" type="text"
          placeholder="Patient surname" value={surname}
          onChange={(e) => onChange("surname", e.target.value)}
          onBlur={() => onChange("surname", capitalCase(surname))}
          autoCapitalize="words" />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-given`}>Given name</label>
        <input id={`${idPrefix}-given`} className="form-input" type="text"
          placeholder="Given name" value={givenName}
          onChange={(e) => onChange("givenName", e.target.value)}
          onBlur={() => onChange("givenName", capitalCase(givenName))}
          autoCapitalize="words" />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-dob`}>Date of birth</label>
        <input id={`${idPrefix}-dob`} className="form-input" type="date"
          value={dob} onChange={(e) => onChange("dob", e.target.value)} />
        {age && <span className="form-hint">{age}</span>}
        {status === "found" && (
          <span className="form-hint">
            Name and date of birth are shared by every record with this NHI — changes here update them all.
          </span>
        )}
      </div>
    </section>
  );
}

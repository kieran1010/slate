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
//   • An AI import's [UNCERTAIN] tag shows in red (UncertainHighlight).
//   • The NHI belongs to the record: changing it moves the record to
//     that patient. If the NHI is already known, that patient's name
//     and date of birth fill in (hooks/usePatientLookup.ts).
// The screens' own Save does the writing (upsertPatient + the record).
//
// FILE LOCATION:
//   src/components/PatientFields.tsx
// ============================================================

import { calculateAge } from "../data/models";
import type { PatientStatus } from "../hooks/usePatientLookup";
import { capitalCase } from "../utils/format";
import { TagInput } from "./UncertainHighlight";

// A date of birth the date picker can show. Anything else (e.g. an AI
// import's "[UNCERTAIN] 1978-03-14") is shown as text, tag in red,
// until it has been corrected.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type IdentityField = "nhi" | "surname" | "givenName" | "dob";

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
  const dobIsDate = !dob || ISO_DATE.test(dob);
  const age = dob && dobIsDate ? calculateAge(dob) : "";
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
        <TagInput id={`${idPrefix}-nhi`} className="form-input" type="text"
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
        <TagInput id={`${idPrefix}-surname`} className="form-input" type="text"
          placeholder="Patient surname" value={surname}
          onChange={(e) => onChange("surname", e.target.value)}
          onBlur={() => onChange("surname", capitalCase(surname))}
          autoCapitalize="words" />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-given`}>Given name</label>
        <TagInput id={`${idPrefix}-given`} className="form-input" type="text"
          placeholder="Given name" value={givenName}
          onChange={(e) => onChange("givenName", e.target.value)}
          onBlur={() => onChange("givenName", capitalCase(givenName))}
          autoCapitalize="words" />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-dob`}>Date of birth</label>
        {dobIsDate ? (
          <input id={`${idPrefix}-dob`} className="form-input" type="date"
            value={dob} onChange={(e) => onChange("dob", e.target.value)} />
        ) : (
          <TagInput id={`${idPrefix}-dob`} className="form-input" type="text"
            value={dob} onChange={(e) => onChange("dob", e.target.value)} />
        )}
        {age && <span className="form-hint">{age}</span>}
      </div>
    </section>
  );
}

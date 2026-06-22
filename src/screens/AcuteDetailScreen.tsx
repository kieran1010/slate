// ============================================================
// Charted PWA — AcuteDetailScreen.tsx
// ============================================================
// Both the "create new referral" form (id === 'new') and the
// "view / edit existing referral" form (id === number).
//
// KEY FLOWS:
//
//   Create (id === 'new'):
//     1. User types NHI. After 400ms idle, we look up the patient.
//     2. If found → name/DOB shown read-only (can't accidentally
//        change another patient's identity).
//     3. If not found → name/DOB editable so the patient record
//        can be created on first save.
//     4. Save: upserts Patient master (if name was provided) then
//        creates AcuteRecord.
//
//   Edit (id === number):
//     1. Record + patient loaded from IndexedDB on mount.
//     2. All fields editable EXCEPT nhi (identity is fixed once
//        the referral exists — changing NHI mid-referral would
//        mean swapping to a different patient).
//     3. Save: upserts Patient (allows correcting a name typo),
//        updates AcuteRecord.
//     4. Extra actions: Archive, Move to Follow-up (wired when
//        the Follow-up module is built — TODO comment below).
//
// VALIDATION: lightweight inline rules, no library.
//   • NHI required
//   • At least one of: location, taskToComplete
//
// FILE LOCATION:
//   src/screens/AcuteDetailScreen.tsx
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, Archive, ArrowRight } from "lucide-react";
import { db } from "../data/db";
import {
  getPatient,
  upsertPatient,
  createAcute,
  updateAcute,
  archiveRecord,
} from "../data/repository";
import {
  URGENCIES,
  URGENCY_LABELS,
  RECORD_STATUSES,
  RECORD_STATUS_LABELS,
  calculateAge,
} from "../data/models";
import type { Urgency, RecordStatus } from "../data/models";
import { AutoTextarea } from "../components/AutoTextarea";
import type { NavigateFn } from "../types/nav";

// ── Types ─────────────────────────────────────────────────────

interface AcuteDetailScreenProps {
  id: number | "new";
  navigate: NavigateFn;
  goBack: () => void;
}

// The local form state. Managed fields (archived, timestamps)
// are never in the form — the repository adds those on save.
interface FormState {
  nhi: string;
  surname: string;
  givenName: string;
  dob: string;
  location: string;
  background: string;
  taskToComplete: string;
  urgency: Urgency;
  status: RecordStatus;
  notes: string;
}

const DEFAULT_FORM: FormState = {
  nhi: "",
  surname: "",
  givenName: "",
  dob: "",
  location: "",
  background: "",
  taskToComplete: "",
  urgency: "ROUTINE",
  status: "PENDING",
  notes: "",
};

// Whether a string looks roughly like an NHI (3 letters + 4 chars
// is the NZ format, but we're permissive — just needs something).
function nhiLooksComplete(nhi: string): boolean {
  return nhi.trim().length >= 3;
}

// ── Component ─────────────────────────────────────────────────

export function AcuteDetailScreen({
  id,
  navigate,
  goBack,
}: AcuteDetailScreenProps) {
  const isNew = id === "new";

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [patientStatus, setPatientStatus] = useState<
    "idle" | "found" | "new"
  >("idle");
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [saving, setSaving] = useState(false);
  // Prevents the edit-mode form from being overwritten if the DB
  // updates while the user is in the middle of editing.
  const [initialized, setInitialized] = useState(false);

  // ── Load existing record (edit mode only) ───────────────────
  const existing = useLiveQuery(async () => {
    if (isNew) return null;
    const [rec, patients] = await Promise.all([
      db.acute.get(id as number),
      // Get all patients; getPatient() re-queries on every render
      // which is fine, but batching keeps it to one round-trip.
      db.patients.toArray(),
    ]);
    if (!rec) return null;
    const patient = patients.find((p) => p.nhi === rec.nhi);
    return { rec, patient };
  }, [id, isNew]);

  // Populate form from loaded data, but only once (initialized
  // flag stops it overwriting mid-edit).
  useEffect(() => {
    if (!existing || initialized) return;
    const { rec, patient } = existing;
    setForm({
      nhi: rec.nhi,
      surname: patient?.surname ?? "",
      givenName: patient?.givenName ?? "",
      dob: patient?.dob ?? "",
      location: rec.location,
      background: rec.background,
      taskToComplete: rec.taskToComplete,
      urgency: rec.urgency,
      status: rec.status,
      notes: rec.notes,
    });
    setPatientStatus(patient ? "found" : "idle");
    setInitialized(true);
  }, [existing, initialized]);

  // ── NHI patient lookup (create mode only) ───────────────────
  // Debounced: fires 400ms after the user stops typing the NHI.
  // If the NHI looks complete, we query IndexedDB. We do NOT
  // do the lookup in edit mode (NHI is locked there).
  useEffect(() => {
    if (!isNew) return;
    const nhi = form.nhi.trim().toUpperCase();
    if (!nhiLooksComplete(nhi)) {
      setPatientStatus("idle");
      return;
    }
    const timer = setTimeout(async () => {
      const p = await getPatient(nhi);
      if (p) {
        // Patient already exists: pre-fill identity fields read-only.
        setForm((f) => ({
          ...f,
          surname: p.surname,
          givenName: p.givenName,
          dob: p.dob,
        }));
        setPatientStatus("found");
      } else {
        setPatientStatus("new");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [form.nhi, isNew]);

  // ── Field change helper ──────────────────────────────────────
  const set = useCallback(
    <K extends keyof FormState>(field: K, value: FormState[K]) => {
      setForm((f) => ({ ...f, [field]: value }));
      // Clear that field's error as soon as the user edits it.
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    []
  );

  // ── Validation ───────────────────────────────────────────────
  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.nhi.trim()) {
      next.nhi = "NHI is required.";
    }
    if (!form.location.trim() && !form.taskToComplete.trim()) {
      next.taskToComplete = "Enter at least a location or a task to complete.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  // ── Save ─────────────────────────────────────────────────────
  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      const nhi = form.nhi.trim().toUpperCase();

      // Upsert the Patient master record if we have identity data.
      // This creates a new patient or corrects an existing name.
      if (form.surname.trim() || form.givenName.trim()) {
        await upsertPatient({
          nhi,
          surname: form.surname.trim(),
          givenName: form.givenName.trim(),
          dob: form.dob.trim(),
        });
      }

      const clinical = {
        nhi,
        location: form.location.trim(),
        background: form.background.trim(),
        taskToComplete: form.taskToComplete.trim(),
        urgency: form.urgency,
        status: form.status,
        notes: form.notes.trim(),
      };

      if (isNew) {
        await createAcute(clinical);
      } else {
        await updateAcute(id as number, clinical);
      }

      goBack();
    } catch (err) {
      console.error("Save failed:", err);
      alert("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Archive ──────────────────────────────────────────────────
  async function handleArchive() {
    if (isNew) return;
    if (!confirm("Archive this referral? It will be removed from the active list but can be restored.")) {
      return;
    }
    await archiveRecord("ACUTE", id as number);
    goBack();
  }

  // ── Move to Follow-up ────────────────────────────────────────
  // Navigates to the follow-up detail screen pre-filled with the
  // carry-over draft (intervention ← taskToComplete, date ← createdAt).
  // The atomic commit (archive this record + create follow-up) happens
  // in FollowUpDetailScreen when the user taps Save there, so they
  // can review and edit the draft first.
  async function handleMoveToFollowUp() {
    if (isNew) return;
    navigate({
      tab: "follow-up",
      view: "detail",
      id: "new",
      draftSource: { module: "ACUTE", sourceId: id as number },
    });
  }

  // ── Loading state (edit mode only) ──────────────────────────
  // Show a spinner until the record loads; avoids a flash of the
  // blank default form followed by the real data.
  if (!isNew && !initialized) {
    if (existing === null) {
      // Record not found (deleted or wrong id).
      return (
        <div className="loading-screen">
          Referral not found.{" "}
          <button className="btn btn-ghost" onClick={goBack}>
            Back
          </button>
        </div>
      );
    }
    if (existing === undefined) {
      return <div className="loading-screen">Loading…</div>;
    }
  }

  // ── Computed display values ──────────────────────────────────
  const age = form.dob ? calculateAge(form.dob) : "";
  const patientKnown = patientStatus === "found" || (!!form.surname && !isNew);

  // In create mode, identity fields are editable unless the NHI
  // resolved to an existing patient (then they're read-only to
  // avoid corrupting another patient's record).
  const identityReadOnly = !isNew || patientStatus === "found";

  const title = isNew ? "New referral" : "Acute referral";

  // ── Render ───────────────────────────────────────────────────
  return (
    <div>
      {/* ── Screen header ──────────────────────────────────── */}
      <div className="screen-header">
        <button
          className="btn btn-ghost"
          onClick={goBack}
          aria-label="Back to referrals list"
          style={{ padding: "6px 4px" }}
        >
          <ChevronLeft size={20} aria-hidden />
          Back
        </button>
        <h1 className="screen-header-title">{title}</h1>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
          aria-busy={saving}
          style={{ minWidth: 60 }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* ── Form body ──────────────────────────────────────── */}
      <div className="form-body">

        {/* ── Patient section ──────────────────────────────── */}
        <section className="form-section" aria-label="Patient identity">
          <div className="form-section-title">Patient</div>

          {/* NHI */}
          <div className={`form-field${errors.nhi ? " form-field-error" : ""}`}>
            <label className="form-label form-label-req" htmlFor="field-nhi">
              NHI
            </label>
            <input
              id="field-nhi"
              className="form-input"
              type="text"
              placeholder="e.g. ABC1234"
              value={form.nhi}
              disabled={!isNew} // NHI is fixed once the referral exists
              onChange={(e) => set("nhi", e.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              style={{ fontFamily: "var(--font-body)", letterSpacing: "0.04em" }}
            />
            {/* Inline NHI status feedback (create mode only) */}
            {isNew && patientStatus === "found" && (
              <span className="nhi-status nhi-status-found">
                ✓ Existing patient
              </span>
            )}
            {isNew && patientStatus === "new" && (
              <span className="nhi-status nhi-status-new">
                New patient — enter name below
              </span>
            )}
            {errors.nhi && (
              <span className="form-error" role="alert">
                {errors.nhi}
              </span>
            )}
          </div>

          {/* Patient info strip (existing patient, read-only) */}
          {patientKnown && identityReadOnly && (
            <div className="patient-info-strip">
              <span className="patient-info-strip-name">
                {form.surname}, {form.givenName}
              </span>
              {form.dob && (
                <span className="patient-info-strip-sub">
                  DOB: {form.dob}
                  {age && ` · ${age}`}
                </span>
              )}
            </div>
          )}

          {/* Editable identity fields (new patient only) */}
          {(!identityReadOnly || (isNew && patientStatus === "new")) && (
            <>
              <div className="form-field">
                <label className="form-label" htmlFor="field-surname">
                  Surname
                </label>
                <input
                  id="field-surname"
                  className="form-input"
                  type="text"
                  placeholder="Patient surname"
                  value={form.surname}
                  onChange={(e) => set("surname", e.target.value)}
                  autoCapitalize="words"
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="field-given">
                  Given name
                </label>
                <input
                  id="field-given"
                  className="form-input"
                  type="text"
                  placeholder="Given name"
                  value={form.givenName}
                  onChange={(e) => set("givenName", e.target.value)}
                  autoCapitalize="words"
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="field-dob">
                  Date of birth
                </label>
                <input
                  id="field-dob"
                  className="form-input"
                  type="date"
                  value={form.dob}
                  onChange={(e) => set("dob", e.target.value)}
                />
                {form.dob && age && (
                  <span className="form-hint">{age}</span>
                )}
              </div>
            </>
          )}
        </section>

        {/* ── Referral section ─────────────────────────────── */}
        <section className="form-section" aria-label="Referral details">
          <div className="form-section-title">Referral</div>

          {/* Location */}
          <div className="form-field">
            <label className="form-label" htmlFor="field-location">
              Location
            </label>
            <input
              id="field-location"
              className="form-input"
              type="text"
              placeholder="e.g. Ward 6B, ED Bay 3"
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
            />
          </div>

          {/* Urgency */}
          <div className="form-field">
            <label className="form-label form-label-req" htmlFor="field-urgency">
              Urgency
            </label>
            <select
              id="field-urgency"
              className="form-select"
              value={form.urgency}
              onChange={(e) => set("urgency", e.target.value as Urgency)}
            >
              {URGENCIES.map((u) => (
                <option key={u} value={u}>
                  {URGENCY_LABELS[u]}
                </option>
              ))}
            </select>
          </div>

          {/* Status */}
          <div className="form-field">
            <label className="form-label" htmlFor="field-status">
              Status
            </label>
            <select
              id="field-status"
              className="form-select"
              value={form.status}
              onChange={(e) => set("status", e.target.value as RecordStatus)}
            >
              {RECORD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {RECORD_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {/* Background */}
          <div className="form-field">
            <label className="form-label" htmlFor="field-background">
              Background
            </label>
            <AutoTextarea
              id="field-background"
              className="form-textarea"
              placeholder="Brief clinical background…"
              value={form.background}
              onChange={(e) => set("background", e.target.value)}
            />
          </div>

          {/* Task to complete */}
          <div
            className={`form-field${
              errors.taskToComplete ? " form-field-error" : ""
            }`}
          >
            <label
              className="form-label form-label-req"
              htmlFor="field-task"
            >
              Task to complete
            </label>
            <AutoTextarea
              id="field-task"
              className="form-textarea"
              placeholder="What needs to be done…"
              value={form.taskToComplete}
              onChange={(e) => set("taskToComplete", e.target.value)}
            />
            {errors.taskToComplete && (
              <span className="form-error" role="alert">
                {errors.taskToComplete}
              </span>
            )}
          </div>

          {/* Notes */}
          <div className="form-field">
            <label className="form-label" htmlFor="field-notes">
              Notes
            </label>
            <AutoTextarea
              id="field-notes"
              className="form-textarea"
              placeholder="Any additional notes…"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </section>

        {/* ── Actions (existing records only) ──────────────── */}
        {!isNew && (
          <div className="form-actions">
            <div className="form-actions-row">
              <button
                className="btn btn-secondary"
                onClick={handleMoveToFollowUp}
              >
                <ArrowRight size={15} aria-hidden />
                Move to follow-up
              </button>
              <button
                className="btn btn-danger-soft"
                onClick={handleArchive}
              >
                <Archive size={15} aria-hidden />
                Archive
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

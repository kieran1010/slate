// ============================================================
// Charted PWA — PreAssessDetailScreen.tsx
// ============================================================
// Create and edit pre-assessment records. Same structural
// pattern as AcuteDetailScreen (patient gate, initialized flag,
// NHI debounce lookup) — only the clinical field set differs.
//
// dateOfSurgery is stored as "YYYY-MM-DDThh:mm" (ISO, no offset).
// A native <input type="datetime-local"> emits exactly that
// format, so no conversion is needed in either direction.
//
// FILE LOCATION:
//   src/screens/PreAssessDetailScreen.tsx
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, Archive, ArrowRight, Clipboard, Check } from "lucide-react";
import { db } from "../data/db";
import {
  getPatient,
  upsertPatient,
  createPreAssess,
  updatePreAssess,
  archiveRecord,
} from "../data/repository";
import {
  RECORD_STATUSES,
  RECORD_STATUS_LABELS,
  calculateAge,
} from "../data/models";
import type { RecordStatus } from "../data/models";
import { AutoTextarea } from "../components/AutoTextarea";
import { DateTimeField } from "../components/DateTimeField";
import { useConfig } from "../hooks/useConfig";
import { formatPreAssess } from "../utils/export";
import type { NavigateFn } from "../types/nav";

interface PreAssessDetailScreenProps {
  id: number | "new";
  navigate: NavigateFn;
  goBack: () => void;
}

interface FormState {
  // Patient identity
  nhi: string;
  surname: string;
  givenName: string;
  dob: string;
  // Surgery
  dateOfSurgery: string; // "YYYY-MM-DDThh:mm" or ""
  procedure: string;
  surgeon: string;
  indicationForSurgery: string;
  // History
  pastMedicalHistory: string;
  anaestheticHistory: string;
  socialHistory: string;
  functionalStatus: string;
  // Investigations
  investigations: string;
  medications: string;
  allergies: string;
  // Measurements
  weight: string;
  height: string;
  // Assessment
  airwayAssessment: string;
  notes: string;
  // Admin
  status: RecordStatus;
}

const DEFAULT_FORM: FormState = {
  nhi: "", surname: "", givenName: "", dob: "",
  dateOfSurgery: "", procedure: "", surgeon: "", indicationForSurgery: "",
  pastMedicalHistory: "", anaestheticHistory: "", socialHistory: "", functionalStatus: "",
  investigations: "", medications: "", allergies: "",
  weight: "", height: "",
  airwayAssessment: "", notes: "",
  status: "PENDING",
};

export function PreAssessDetailScreen({
  id,
  navigate,
  goBack,
}: PreAssessDetailScreenProps) {
  const isNew = id === "new";

  const config = useConfig();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [patientStatus, setPatientStatus] = useState<"idle" | "found" | "new">("idle");
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // ── Load existing record ─────────────────────────────────────
  const existing = useLiveQuery(async () => {
    if (isNew) return null;
    const rec = await db.preAssess.get(id as number);
    if (!rec) return null;
    const patient = await getPatient(rec.nhi);
    return { rec, patient };
  }, [id, isNew]);

  useEffect(() => {
    if (!existing || initialized) return;
    const { rec, patient } = existing;
    setForm({
      nhi: rec.nhi,
      surname: patient?.surname ?? "",
      givenName: patient?.givenName ?? "",
      dob: patient?.dob ?? "",
      dateOfSurgery: rec.dateOfSurgery,
      procedure: rec.procedure,
      surgeon: rec.surgeon,
      indicationForSurgery: rec.indicationForSurgery,
      pastMedicalHistory: rec.pastMedicalHistory,
      anaestheticHistory: rec.anaestheticHistory,
      socialHistory: rec.socialHistory,
      functionalStatus: rec.functionalStatus,
      investigations: rec.investigations,
      medications: rec.medications,
      allergies: rec.allergies,
      weight: rec.weight,
      height: rec.height,
      airwayAssessment: rec.airwayAssessment,
      notes: rec.notes,
      status: rec.status,
    });
    setPatientStatus(patient ? "found" : "idle");
    setInitialized(true);
  }, [existing, initialized]);

  // ── NHI patient lookup (create mode) ────────────────────────
  useEffect(() => {
    if (!isNew) return;
    const nhi = form.nhi.trim().toUpperCase();
    if (nhi.length < 3) { setPatientStatus("idle"); return; }
    const timer = setTimeout(async () => {
      const p = await getPatient(nhi);
      if (p) {
        setForm((f) => ({ ...f, surname: p.surname, givenName: p.givenName, dob: p.dob }));
        setPatientStatus("found");
      } else {
        setPatientStatus("new");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [form.nhi, isNew]);

  const set = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }, []);

  // ── Copy to clipboard ────────────────────────────────────────
  // Formats the current form state as plain text and copies it.
  // Works from the form state rather than re-querying the DB, so
  // it reflects any unsaved edits the user has made.
  async function handleCopy() {
    const text = formatPreAssess(
      {
        nhi: form.nhi,
        surname: form.surname,
        givenName: form.givenName,
        dob: form.dob,
      },
      form,
      config.clinicianName,
      config.clinicianRole
    );
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS dev environment).
      // Fall back to a textarea select-all so the user can copy manually.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  // ── Validation ───────────────────────────────────────────────
  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.nhi.trim()) next.nhi = "NHI is required.";
    if (!form.procedure.trim() && !form.dateOfSurgery)
      next.procedure = "Enter at least a procedure or surgery date.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  // ── Save ─────────────────────────────────────────────────────
  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      const nhi = form.nhi.trim().toUpperCase();
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
        dateOfSurgery: form.dateOfSurgery,
        procedure: form.procedure.trim(),
        surgeon: form.surgeon.trim(),
        indicationForSurgery: form.indicationForSurgery.trim(),
        pastMedicalHistory: form.pastMedicalHistory.trim(),
        anaestheticHistory: form.anaestheticHistory.trim(),
        socialHistory: form.socialHistory.trim(),
        functionalStatus: form.functionalStatus.trim(),
        investigations: form.investigations.trim(),
        medications: form.medications.trim(),
        allergies: form.allergies.trim(),
        weight: form.weight.trim(),
        height: form.height.trim(),
        airwayAssessment: form.airwayAssessment.trim(),
        notes: form.notes.trim(),
        status: form.status,
      };
      if (isNew) {
        await createPreAssess(clinical);
      } else {
        await updatePreAssess(id as number, clinical);
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
    if (!confirm("Archive this assessment? It can be restored later.")) return;
    await archiveRecord("PRE_ASSESSMENT", id as number);
    goBack();
  }

  // ── Move to Follow-up ────────────────────────────────────────
  // Navigates to the follow-up detail screen pre-filled with the
  // carry-over draft (intervention ← procedure, date ← dateOfSurgery).
  // The atomic commit happens in FollowUpDetailScreen on Save.
  async function handleMoveToFollowUp() {
    if (isNew) return;
    navigate({
      tab: "follow-up",
      view: "detail",
      id: "new",
      draftSource: { module: "PRE_ASSESSMENT", sourceId: id as number },
    });
  }

  // ── Loading state ────────────────────────────────────────────
  if (!isNew && !initialized) {
    if (existing === null)
      return (
        <div className="loading-screen">
          Assessment not found.{" "}
          <button className="btn btn-ghost" onClick={goBack}>Back</button>
        </div>
      );
    if (existing === undefined)
      return <div className="loading-screen">Loading…</div>;
  }

  const age = form.dob ? calculateAge(form.dob) : "";
  const identityReadOnly = !isNew || patientStatus === "found";

  // ── Render ───────────────────────────────────────────────────
  return (
    <div>
      {/* ── Screen header ──────────────────────────────────── */}
      <div className="screen-header">
        <button className="btn btn-ghost" onClick={goBack}
          aria-label="Back to pre-assessment list" style={{ padding: "6px 4px" }}>
          <ChevronLeft size={20} aria-hidden />
          Back
        </button>
        <h1 className="screen-header-title">
          {isNew ? "New assessment" : "Pre-assessment"}
        </h1>
        <button className="btn btn-primary" onClick={handleSave}
          disabled={saving} aria-busy={saving} style={{ minWidth: 60 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="form-body">

        {/* ── Patient ──────────────────────────────────────── */}
        <section className="form-section" aria-label="Patient identity">
          <div className="form-section-title">Patient</div>

          <div className={`form-field${errors.nhi ? " form-field-error" : ""}`}>
            <label className="form-label form-label-req" htmlFor="pa-nhi">NHI</label>
            <input id="pa-nhi" className="form-input" type="text"
              placeholder="e.g. ABC1234"
              value={form.nhi}
              disabled={!isNew}
              onChange={(e) => set("nhi", e.target.value.toUpperCase())}
              autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              style={{ letterSpacing: "0.04em" }}
            />
            {isNew && patientStatus === "found" && (
              <span className="nhi-status nhi-status-found">✓ Existing patient</span>
            )}
            {isNew && patientStatus === "new" && (
              <span className="nhi-status nhi-status-new">New patient — enter name below</span>
            )}
            {errors.nhi && <span className="form-error" role="alert">{errors.nhi}</span>}
          </div>

          {/* Existing patient strip */}
          {identityReadOnly && (form.surname || form.givenName) && (
            <div className="patient-info-strip">
              <span className="patient-info-strip-name">
                {form.surname}, {form.givenName}
              </span>
              {form.dob && (
                <span className="patient-info-strip-sub">
                  DOB: {form.dob}{age && ` · ${age}`}
                </span>
              )}
            </div>
          )}

          {/* Editable identity (new patient) */}
          {!identityReadOnly && (
            <>
              <div className="form-field">
                <label className="form-label" htmlFor="pa-surname">Surname</label>
                <input id="pa-surname" className="form-input" type="text"
                  placeholder="Patient surname" value={form.surname}
                  onChange={(e) => set("surname", e.target.value)}
                  autoCapitalize="words" />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="pa-given">Given name</label>
                <input id="pa-given" className="form-input" type="text"
                  placeholder="Given name" value={form.givenName}
                  onChange={(e) => set("givenName", e.target.value)}
                  autoCapitalize="words" />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="pa-dob">Date of birth</label>
                <input id="pa-dob" className="form-input" type="date"
                  value={form.dob} onChange={(e) => set("dob", e.target.value)} />
                {form.dob && age && <span className="form-hint">{age}</span>}
              </div>
            </>
          )}
        </section>

        {/* ── Surgery ──────────────────────────────────────── */}
        <section className="form-section" aria-label="Surgery details">
          <div className="form-section-title">Surgery</div>

          <div className={`form-field${errors.procedure ? " form-field-error" : ""}`}>
            <label className="form-label form-label-req" htmlFor="pa-procedure">
              Procedure
            </label>
            <input id="pa-procedure" className="form-input" type="text"
              placeholder="Planned surgical procedure"
              value={form.procedure}
              onChange={(e) => set("procedure", e.target.value)} />
            {errors.procedure && (
              <span className="form-error" role="alert">{errors.procedure}</span>
            )}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-dos">
              Date &amp; time of surgery
            </label>
            <DateTimeField id="pa-dos"
              value={form.dateOfSurgery}
              onChange={(v) => set("dateOfSurgery", v)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-surgeon">Surgeon</label>
            <input id="pa-surgeon" className="form-input" type="text"
              placeholder="Operating surgeon"
              value={form.surgeon}
              onChange={(e) => set("surgeon", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-indication">
              Indication for surgery
            </label>
            <AutoTextarea id="pa-indication" className="form-textarea"
              placeholder="Indication…"
              value={form.indicationForSurgery}
              onChange={(e) => set("indicationForSurgery", e.target.value)} />
          </div>
        </section>

        {/* ── History ──────────────────────────────────────── */}
        <section className="form-section" aria-label="Patient history">
          <div className="form-section-title">History</div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-pmh">Past medical history</label>
            <AutoTextarea id="pa-pmh" className="form-textarea"
              placeholder="Relevant past medical history…"
              value={form.pastMedicalHistory}
              onChange={(e) => set("pastMedicalHistory", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-anaes">Anaesthetic history</label>
            <AutoTextarea id="pa-anaes" className="form-textarea"
              placeholder="Previous anaesthetics, complications, family history…"
              value={form.anaestheticHistory}
              onChange={(e) => set("anaestheticHistory", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-social">Social history</label>
            <AutoTextarea id="pa-social" className="form-textarea"
              placeholder="Smoking, alcohol, home situation…"
              value={form.socialHistory}
              onChange={(e) => set("socialHistory", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-functional">Functional status</label>
            <AutoTextarea id="pa-functional" className="form-textarea"
              placeholder="Exercise tolerance, ADLs (e.g. >4 METs)…"
              value={form.functionalStatus}
              onChange={(e) => set("functionalStatus", e.target.value)} />
          </div>
        </section>

        {/* ── Investigations ───────────────────────────────── */}
        <section className="form-section" aria-label="Investigations and medications">
          <div className="form-section-title">Investigations &amp; medications</div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-ix">Investigations</label>
            <AutoTextarea id="pa-ix" className="form-textarea"
              placeholder="ECG, echo, bloods, lung function…"
              value={form.investigations}
              onChange={(e) => set("investigations", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-meds">Medications</label>
            <AutoTextarea id="pa-meds" className="form-textarea"
              placeholder="Current medications and doses…"
              value={form.medications}
              onChange={(e) => set("medications", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-allergies">Allergies</label>
            <AutoTextarea id="pa-allergies" className="form-textarea"
              placeholder="e.g. NKDA, penicillin, latex"
              value={form.allergies}
              onChange={(e) => set("allergies", e.target.value)} />
          </div>
        </section>

        {/* ── Measurements ─────────────────────────────────── */}
        <section className="form-section" aria-label="Measurements">
          <div className="form-section-title">Measurements</div>

          {/* Weight and height sit side by side */}
          <div style={{ display: "flex" }}>
            <div className="form-field" style={{ flex: 1, borderRight: "1px solid var(--border)" }}>
              <label className="form-label" htmlFor="pa-weight">Weight (kg)</label>
              <input id="pa-weight" className="form-input" type="text"
                inputMode="decimal" placeholder="kg"
                value={form.weight}
                onChange={(e) => set("weight", e.target.value)} />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label" htmlFor="pa-height">Height (cm)</label>
              <input id="pa-height" className="form-input" type="text"
                inputMode="decimal" placeholder="cm"
                value={form.height}
                onChange={(e) => set("height", e.target.value)} />
            </div>
          </div>
        </section>

        {/* ── Assessment ───────────────────────────────────── */}
        <section className="form-section" aria-label="Anaesthetic assessment">
          <div className="form-section-title">Assessment</div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-airway">Airway assessment</label>
            <AutoTextarea id="pa-airway" className="form-textarea"
              placeholder="Mallampati, mouth opening, neck mobility, dentition…"
              value={form.airwayAssessment}
              onChange={(e) => set("airwayAssessment", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-notes">Notes</label>
            <AutoTextarea id="pa-notes" className="form-textarea"
              placeholder="Anaesthetic plan, considerations, actions required…"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pa-status">Status</label>
            <select id="pa-status" className="form-select"
              value={form.status}
              onChange={(e) => set("status", e.target.value as RecordStatus)}>
              {RECORD_STATUSES.map((s) => (
                <option key={s} value={s}>{RECORD_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
        </section>

        {/* ── Actions (existing records only) ──────────────── */}
        {!isNew && (
          <div className="form-actions">
            {/* Copy summary — the primary output action for pre-assess */}
            <button
              className="btn btn-secondary"
              style={{ width: "100%" }}
              onClick={handleCopy}
            >
              {copied ? (
                <><Check size={15} aria-hidden /> Copied!</>
              ) : (
                <><Clipboard size={15} aria-hidden /> Copy pre-assessment summary</>
              )}
            </button>
            <div className="form-actions-row">
              <button className="btn btn-secondary" onClick={handleMoveToFollowUp}>
                <ArrowRight size={15} aria-hidden />
                Move to follow-up
              </button>
              <button className="btn btn-danger-soft" onClick={handleArchive}>
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

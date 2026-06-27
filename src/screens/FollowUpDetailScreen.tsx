// ============================================================
// Charted PWA — FollowUpDetailScreen.tsx
// ============================================================
// Handles three distinct modes:
//
//   1. NEW (id === 'new', no draftSource)
//      Blank form — user enters everything manually.
//      Save calls createFollowUp().
//
//   2. NEW FROM DRAFT (id === 'new', draftSource present)
//      Arrived via "Move to Follow-up" from Acute or Pre-assess.
//      On mount, calls buildMoveToFollowUpDraft() to get the
//      pre-filled carry-over values (intervention, interventionDate).
//      User edits before saving.
//      Save calls commitMoveToFollowUp() — a single transaction
//      that archives the source record AND creates the follow-up,
//      so the two never get out of step.
//
//   3. EDIT (id === number)
//      Loads existing follow-up record. Save calls updateFollowUp().
//      Actions: Archive.
//
// FOLLOW-UP TYPE drives the followUpDue field:
//   AD_HOC   — no due date; followUpDue is hidden and cleared.
//   OFFSET   — followUpDue auto-calculated from interventionDate +
//              defaultFollowUpHours (from AppConfig). Shown read-only
//              but editable if the user wants to adjust.
//   SPECIFIC — user picks an exact datetime.
//
// FILE LOCATION:
//   src/screens/FollowUpDetailScreen.tsx
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, Archive } from "lucide-react";
import { db } from "../data/db";
import {
  getPatient,
  upsertPatient,
  createFollowUp,
  updateFollowUp,
  archiveRecord,
  getConfig,
  buildMoveToFollowUpDraft,
  commitMoveToFollowUp,
} from "../data/repository";
import {
  FOLLOW_UP_TYPES,
  FOLLOW_UP_TYPE_LABELS,
  RECORD_STATUSES,
  RECORD_STATUS_LABELS,
  calculateAge,
} from "../data/models";
import type { FollowUpType, RecordStatus } from "../data/models";
import { dateAddHours } from "../data/dates";
import { AutoTextarea } from "../components/AutoTextarea";
import { DateTimeField } from "../components/DateTimeField";
import type { NavigateFn } from "../types/nav";

interface FollowUpDetailScreenProps {
  id: number | "new";
  // Present when arriving via move flow — see mode 2 above.
  draftSource?: { module: "ACUTE" | "PRE_ASSESSMENT"; sourceId: number };
  navigate: NavigateFn;
  goBack: () => void;
}

interface FormState {
  // Patient identity
  nhi: string;
  surname: string;
  givenName: string;
  dob: string;
  // Intervention
  intervention: string;
  interventionDate: string;
  phoneNumber: string;
  // Follow-up
  followUpType: FollowUpType;
  followUpDue: string;
  outcome: string;
  notes: string;
  status: RecordStatus;
}

const DEFAULT_FORM: FormState = {
  nhi: "", surname: "", givenName: "", dob: "",
  intervention: "", interventionDate: "", phoneNumber: "",
  followUpType: "OFFSET", followUpDue: "",
  outcome: "", notes: "", status: "PENDING",
};

export function FollowUpDetailScreen({
  id,
  draftSource,
  goBack,
}: FollowUpDetailScreenProps) {
  const isNew = id === "new";
  const isDraft = isNew && !!draftSource;

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [patientStatus, setPatientStatus] = useState<"idle" | "found" | "new">("idle");
  const [defaultFollowUpHours, setDefaultFollowUpHours] = useState(24);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // ── Read config for default follow-up offset ─────────────────
  useEffect(() => {
    getConfig().then((c) => setDefaultFollowUpHours(c.defaultFollowUpHours));
  }, []);

  // ── Load existing record (edit mode) ─────────────────────────
  const existing = useLiveQuery(async () => {
    if (isNew) return null;
    const rec = await db.followUp.get(id as number);
    if (!rec) return null;
    const patient = await getPatient(rec.nhi);
    return { rec, patient };
  }, [id, isNew]);

  // ── Populate form: edit mode ──────────────────────────────────
  useEffect(() => {
    if (isNew || !existing || initialized) return;
    const { rec, patient } = existing;
    setForm({
      nhi: rec.nhi,
      surname: patient?.surname ?? "",
      givenName: patient?.givenName ?? "",
      dob: patient?.dob ?? "",
      intervention: rec.intervention,
      interventionDate: rec.interventionDate,
      phoneNumber: rec.phoneNumber,
      followUpType: rec.followUpType,
      followUpDue: rec.followUpDue,
      outcome: rec.outcome,
      notes: rec.notes,
      status: rec.status,
    });
    setPatientStatus(patient ? "found" : "idle");
    setInitialized(true);
  }, [existing, initialized, isNew]);

  // ── Populate form: draft mode (move from Acute / Pre-assess) ──
  useEffect(() => {
    if (!isDraft || initialized) return;
    const { module, sourceId } = draftSource!;
    buildMoveToFollowUpDraft(module, sourceId).then((draft) => {
      setForm((f) => ({
        ...f,
        nhi: draft.nhi,
        intervention: draft.intervention,
        interventionDate: draft.interventionDate,
        followUpType: draft.followUpType,
        followUpDue: draft.followUpDue,
        phoneNumber: draft.phoneNumber,
        notes: draft.notes,
      }));
      // Also look up the patient to show their name.
      getPatient(draft.nhi).then((p) => {
        if (p) {
          setForm((f) => ({
            ...f,
            surname: p.surname,
            givenName: p.givenName,
            dob: p.dob,
          }));
          setPatientStatus("found");
        }
      });
      setInitialized(true);
    });
  }, [isDraft, draftSource, initialized]);

  // ── NHI patient lookup (plain-new mode only) ──────────────────
  useEffect(() => {
    if (!isNew || isDraft) return; // draft already resolved patient
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
  }, [form.nhi, isNew, isDraft]);

  // ── Auto-calculate followUpDue when type is OFFSET ───────────
  useEffect(() => {
    if (form.followUpType !== "OFFSET") return;
    if (!form.interventionDate) return;
    const calculated = dateAddHours(form.interventionDate, defaultFollowUpHours);
    if (calculated) {
      setForm((f) => ({ ...f, followUpDue: calculated }));
    }
  }, [form.interventionDate, form.followUpType, defaultFollowUpHours]);

  // ── Clear followUpDue when type is AD_HOC ─────────────────────
  useEffect(() => {
    if (form.followUpType === "AD_HOC") {
      setForm((f) => ({ ...f, followUpDue: "" }));
    }
  }, [form.followUpType]);

  const set = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }, []);

  // ── Validation ───────────────────────────────────────────────
  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.nhi.trim()) next.nhi = "NHI is required.";
    if (!form.intervention.trim() && !form.interventionDate)
      next.intervention = "Enter at least an intervention or intervention date.";
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
        intervention: form.intervention.trim(),
        interventionDate: form.interventionDate,
        phoneNumber: form.phoneNumber.trim(),
        followUpType: form.followUpType,
        followUpDue: form.followUpDue,
        outcome: form.outcome.trim(),
        notes: form.notes.trim(),
        status: form.status,
      };

      if (isDraft) {
        // Atomic: archive source record + create follow-up
        await commitMoveToFollowUp(
          draftSource!.module,
          draftSource!.sourceId,
          {
            nhi,
            originModule: draftSource!.module,
            intervention: clinical.intervention,
            interventionDate: clinical.interventionDate,
            followUpDue: clinical.followUpDue,
            followUpType: clinical.followUpType,
            phoneNumber: clinical.phoneNumber,
            notes: clinical.notes,
          }
        );
      } else if (isNew) {
        await createFollowUp(clinical);
      } else {
        await updateFollowUp(id as number, clinical);
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
    if (!confirm("Archive this follow-up? It can be restored later.")) return;
    await archiveRecord("FOLLOW_UP", id as number);
    goBack();
  }

  // ── Loading states ───────────────────────────────────────────
  if (!isNew && !initialized) {
    if (existing === null)
      return (
        <div className="loading-screen">
          Follow-up not found.{" "}
          <button className="btn btn-ghost" onClick={goBack}>Back</button>
        </div>
      );
    if (existing === undefined)
      return <div className="loading-screen">Loading…</div>;
  }

  // Draft mode: wait for the draft to load before rendering the form
  if (isDraft && !initialized) {
    return <div className="loading-screen">Loading follow-up details…</div>;
  }

  const age = form.dob ? calculateAge(form.dob) : "";
  // In draft mode the patient is resolved from the source record;
  // treat them as found (identity is read-only).
  const identityReadOnly = !isNew || patientStatus === "found" || isDraft;

  const title = isDraft
    ? "Move to follow-up"
    : isNew
      ? "New follow-up"
      : "Follow-up";

  // ── Render ───────────────────────────────────────────────────
  return (
    <div>
      {/* ── Screen header ──────────────────────────────────── */}
      <div className="screen-header">
        <button className="btn btn-ghost" onClick={goBack}
          aria-label="Back" style={{ padding: "6px 4px" }}>
          <ChevronLeft size={20} aria-hidden />
          Back
        </button>
        <h1 className="screen-header-title">{title}</h1>
        <button className="btn btn-primary" onClick={handleSave}
          disabled={saving} aria-busy={saving} style={{ minWidth: 60 }}>
          {saving ? "Saving…" : isDraft ? "Confirm" : "Save"}
        </button>
      </div>

      {/* Draft mode banner */}
      {isDraft && (
        <div style={{
          background: "var(--pale)",
          borderBottom: "1px solid var(--border)",
          padding: "10px 16px",
          fontSize: "0.82rem",
          color: "var(--teal)",
        }}>
          Review and edit the details below, then tap <strong>Confirm</strong> to
          archive the source record and create this follow-up.
        </div>
      )}

      <div className="form-body">

        {/* ── Patient ──────────────────────────────────────── */}
        <section className="form-section" aria-label="Patient identity">
          <div className="form-section-title">Patient</div>

          <div className={`form-field${errors.nhi ? " form-field-error" : ""}`}>
            <label className="form-label form-label-req" htmlFor="fu-nhi">NHI</label>
            <input id="fu-nhi" className="form-input" type="text"
              placeholder="e.g. ABC1234"
              value={form.nhi}
              disabled={!isNew || isDraft} // locked in edit and draft modes
              onChange={(e) => set("nhi", e.target.value.toUpperCase())}
              autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              style={{ letterSpacing: "0.04em" }}
            />
            {!isDraft && isNew && patientStatus === "found" && (
              <span className="nhi-status nhi-status-found">✓ Existing patient</span>
            )}
            {!isDraft && isNew && patientStatus === "new" && (
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

          {/* Editable identity (plain-new, unknown patient) */}
          {!identityReadOnly && (
            <>
              <div className="form-field">
                <label className="form-label" htmlFor="fu-surname">Surname</label>
                <input id="fu-surname" className="form-input" type="text"
                  placeholder="Patient surname" value={form.surname}
                  onChange={(e) => set("surname", e.target.value)}
                  autoCapitalize="words" />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="fu-given">Given name</label>
                <input id="fu-given" className="form-input" type="text"
                  placeholder="Given name" value={form.givenName}
                  onChange={(e) => set("givenName", e.target.value)}
                  autoCapitalize="words" />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="fu-dob">Date of birth</label>
                <input id="fu-dob" className="form-input" type="date"
                  value={form.dob} onChange={(e) => set("dob", e.target.value)} />
                {form.dob && age && <span className="form-hint">{age}</span>}
              </div>
            </>
          )}
        </section>

        {/* ── Intervention ─────────────────────────────────── */}
        <section className="form-section" aria-label="Intervention details">
          <div className="form-section-title">Intervention</div>

          <div className={`form-field${errors.intervention ? " form-field-error" : ""}`}>
            <label className="form-label form-label-req" htmlFor="fu-intervention">
              Intervention
            </label>
            <input id="fu-intervention" className="form-input" type="text"
              placeholder="What was done, e.g. ISB nerve block"
              value={form.intervention}
              onChange={(e) => set("intervention", e.target.value)} />
            {errors.intervention && (
              <span className="form-error" role="alert">{errors.intervention}</span>
            )}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="fu-idate">
              Date &amp; time of intervention
            </label>
            <DateTimeField id="fu-idate"
              value={form.interventionDate}
              onChange={(v) => set("interventionDate", v)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="fu-phone">Phone number</label>
            <input id="fu-phone" className="form-input" type="tel"
              placeholder="For calling the patient"
              value={form.phoneNumber}
              onChange={(e) => set("phoneNumber", e.target.value)} />
          </div>
        </section>

        {/* ── Follow-up ────────────────────────────────────── */}
        <section className="form-section" aria-label="Follow-up schedule">
          <div className="form-section-title">Follow-up</div>

          <div className="form-field">
            <label className="form-label" htmlFor="fu-type">Follow-up type</label>
            <select id="fu-type" className="form-select"
              value={form.followUpType}
              onChange={(e) => set("followUpType", e.target.value as FollowUpType)}>
              {FOLLOW_UP_TYPES.map((t) => (
                <option key={t} value={t}>{FOLLOW_UP_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          {/* followUpDue is shown for OFFSET and SPECIFIC, hidden for AD_HOC */}
          {form.followUpType !== "AD_HOC" && (
            <div className="form-field">
              <label className="form-label" htmlFor="fu-due">
                Follow-up due
                {form.followUpType === "OFFSET" && (
                  <span className="form-hint" style={{ marginLeft: 6 }}>
                    (auto from intervention + {defaultFollowUpHours}h)
                  </span>
                )}
              </label>
              <DateTimeField id="fu-due"
                value={form.followUpDue}
                onChange={(v) => set("followUpDue", v)} />
            </div>
          )}

          <div className="form-field">
            <label className="form-label" htmlFor="fu-outcome">Outcome</label>
            <AutoTextarea id="fu-outcome" className="form-textarea"
              placeholder="Findings at follow-up…"
              value={form.outcome}
              onChange={(e) => set("outcome", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="fu-notes">Notes</label>
            <AutoTextarea id="fu-notes" className="form-textarea"
              placeholder="Additional notes…"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)} />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="fu-status">Status</label>
            <select id="fu-status" className="form-select"
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
            <div className="form-actions-row">
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

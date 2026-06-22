// ============================================================
// Charted PWA — ImportScreen.tsx
// ============================================================
// The AI document import flow. One component handles all three
// modules — only the system prompt and field layout differ.
//
// Stages:
//   idle     → file/photo picker UI
//   loading  → spinner while the Anthropic API call runs
//   done     → extracted fields shown for review; uncertain
//              values (prefixed "[UNCERTAIN]") highlighted amber
//   error    → error message with a retry option
//
// "Create record and review" creates the record in IndexedDB
// (upserts the patient master first if identity was found) then
// navigates to the detail/edit screen so the user can review
// every field, correct uncertainties, and save.
//
// The [UNCERTAIN] prefix is preserved in stored values so it
// remains visible in the edit form. The user removes it when
// they're satisfied the value is correct.
//
// FILE LOCATION:
//   src/screens/ImportScreen.tsx
// ============================================================

import { useRef, useState } from "react";
import { ChevronLeft, Camera, FileUp, AlertTriangle, RefreshCw } from "lucide-react";
import {
  getSystemPrompt,
  fileToBase64,
  callImportApi,
  normaliseDob,
  isUncertain,
  displayValue,
  type ImportModule,
  type ExtractedData,
} from "../utils/importAi";
import {
  upsertPatient,
  createAcute,
  createPreAssess,
  createFollowUp,
} from "../data/repository";
import { useConfig } from "../hooks/useConfig";
import type { NavigateFn } from "../types/nav";

// ── Types ─────────────────────────────────────────────────────

interface ImportScreenProps {
  module: ImportModule;
  navigate: NavigateFn;
  goBack: () => void;
}

type Stage = "idle" | "loading" | "done" | "error";

// ── Per-module metadata ───────────────────────────────────────
// Field definitions drive the preview: label, key, and whether
// to show it in the summary (all keys are stored but only
// labelled ones are previewed — avoids showing null fields).

interface FieldDef { label: string; key: string }

const MODULE_TITLE: Record<ImportModule, string> = {
  "acute":      "Import acute referral",
  "pre-assess": "Import pre-assessment",
  "follow-up":  "Import follow-up",
};

const MODULE_FIELDS: Record<ImportModule, FieldDef[]> = {
  "acute": [
    { label: "NHI",             key: "nhi" },
    { label: "Surname",         key: "surname" },
    { label: "Given name",      key: "givenName" },
    { label: "Date of birth",   key: "dob" },
    { label: "Location",        key: "location" },
    { label: "Background",      key: "background" },
    { label: "Task to complete",key: "taskToComplete" },
  ],
  "pre-assess": [
    { label: "NHI",                   key: "nhi" },
    { label: "Surname",               key: "surname" },
    { label: "Given name",            key: "givenName" },
    { label: "Date of birth",         key: "dob" },
    { label: "Procedure",             key: "procedure" },
    { label: "Surgeon",               key: "surgeon" },
    { label: "Indication",            key: "indicationForSurgery" },
    { label: "Past medical history",  key: "pastMedicalHistory" },
    { label: "Anaesthetic history",   key: "anaestheticHistory" },
    { label: "Social history",        key: "socialHistory" },
    { label: "Functional status",     key: "functionalStatus" },
    { label: "Investigations",        key: "investigations" },
    { label: "Medications",           key: "medications" },
    { label: "Allergies",             key: "allergies" },
    { label: "Weight (kg)",           key: "weight" },
    { label: "Height (cm)",           key: "height" },
    { label: "Airway assessment",     key: "airwayAssessment" },
    { label: "Notes",                 key: "notes" },
  ],
  "follow-up": [
    { label: "NHI",               key: "nhi" },
    { label: "Surname",           key: "surname" },
    { label: "Given name",        key: "givenName" },
    { label: "Date of birth",     key: "dob" },
    { label: "Intervention",      key: "intervention" },
    { label: "Intervention date", key: "interventionDate" },
    { label: "Phone number",      key: "phoneNumber" },
    { label: "Outcome",           key: "outcome" },
  ],
};

// ── Component ─────────────────────────────────────────────────

export function ImportScreen({ module, navigate, goBack }: ImportScreenProps) {
  const config = useConfig();
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef  = useRef<HTMLInputElement>(null);

  const [stage, setStage]       = useState<Stage>("idle");
  const [extracted, setExtracted] = useState<ExtractedData>({});
  const [errorMsg, setErrorMsg] = useState("");
  const [creating, setCreating] = useState(false);

  // ── File handling ───────────────────────────────────────────

  async function handleFile(file: File | undefined) {
    if (!file) return;

    // Basic file type check
    const ok = file.type.startsWith("image/") || file.type === "application/pdf";
    if (!ok) {
      setErrorMsg("Please choose an image (JPEG, PNG, WEBP) or a PDF.");
      setStage("error");
      return;
    }

    // Size guard — Anthropic's limit is generous but large files slow things down
    if (file.size > 10 * 1024 * 1024) {
      setErrorMsg("File is too large (maximum 10 MB). Try a smaller or compressed version.");
      setStage("error");
      return;
    }

    setStage("loading");
    try {
      const base64 = await fileToBase64(file);
      const prompt = getSystemPrompt(module);
      const result = await callImportApi(
        config.anthropicApiKey,
        prompt,
        base64,
        file.type
      );
      setExtracted(result);
      setStage("done");
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Import failed — please try again."
      );
      setStage("error");
    }
  }

  // ── Create record ───────────────────────────────────────────

  async function handleCreate() {
    setCreating(true);
    try {
      const nhi = ((extracted.nhi as string) || "").trim().toUpperCase();

      // Upsert patient master record if we have identity fields
      if (nhi && (extracted.surname || extracted.givenName)) {
        await upsertPatient({
          nhi,
          surname: ((extracted.surname as string) || "").trim(),
          givenName: ((extracted.givenName as string) || "").trim(),
          dob: normaliseDob(extracted.dob as string),
        });
      }

      // Create the module-specific record and navigate to edit it
      const safe = (key: string): string =>
        ((extracted[key] as string) || "").trim();

      if (module === "acute") {
        const id = await createAcute({
          nhi: nhi || "UNKNOWN",
          location:       safe("location"),
          background:     safe("background"),
          taskToComplete: safe("taskToComplete"),
          urgency: "ROUTINE",
          status:  "PENDING",
          notes:   "",
        });
        navigate({ tab: "acute", view: "detail", id });

      } else if (module === "pre-assess") {
        const id = await createPreAssess({
          nhi: nhi || "UNKNOWN",
          dateOfSurgery:        "",
          procedure:            safe("procedure"),
          surgeon:              safe("surgeon"),
          indicationForSurgery: safe("indicationForSurgery"),
          pastMedicalHistory:   safe("pastMedicalHistory"),
          anaestheticHistory:   safe("anaestheticHistory"),
          socialHistory:        safe("socialHistory"),
          functionalStatus:     safe("functionalStatus"),
          investigations:       safe("investigations"),
          medications:          safe("medications"),
          allergies:            safe("allergies"),
          weight:               safe("weight"),
          height:               safe("height"),
          airwayAssessment:     safe("airwayAssessment"),
          notes:                safe("notes"),
          status: "PENDING",
        });
        navigate({ tab: "pre-assess", view: "detail", id });

      } else {
        const id = await createFollowUp({
          nhi: nhi || "UNKNOWN",
          intervention:    safe("intervention"),
          interventionDate: safe("interventionDate"),
          followUpType:    "OFFSET",
          followUpDue:     "",
          outcome:         safe("outcome"),
          phoneNumber:     safe("phoneNumber"),
          notes:           "",
          status: "PENDING",
        });
        navigate({ tab: "follow-up", view: "detail", id });
      }
    } catch (err) {
      console.error("Create record failed:", err);
      alert("Failed to create record — please try again.");
      setCreating(false);
    }
    // Note: don't reset creating on success — we're navigating away
  }

  // ── Render ───────────────────────────────────────────────────

  const fields = MODULE_FIELDS[module];
  // Count how many fields were actually extracted (non-null, non-empty)
  const extractedCount = fields.filter(
    (f) => extracted[f.key] !== null && extracted[f.key] !== undefined && extracted[f.key] !== ""
  ).length;
  // Count uncertain fields for the warning banner
  const uncertainCount = fields.filter((f) => isUncertain(extracted[f.key])).length;

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="screen-header">
        <button
          className="btn btn-ghost"
          onClick={goBack}
          style={{ padding: "6px 4px" }}
          aria-label="Back"
        >
          <ChevronLeft size={20} aria-hidden />
          Back
        </button>
        <h1 className="screen-header-title">{MODULE_TITLE[module]}</h1>
        <div style={{ minWidth: 56 }} />
      </div>

      {/* ── STAGE: idle ────────────────────────────────────── */}
      {stage === "idle" && (
        <div className="form-body">
          <div
            style={{
              background: "#fff",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "24px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              alignItems: "center",
              textAlign: "center",
            }}
          >
            <FileUp size={36} color="var(--teal)" aria-hidden />
            <p style={{ fontWeight: 500, color: "var(--navy)", fontSize: "0.95rem" }}>
              Choose a document to import
            </p>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", lineHeight: 1.6 }}>
              The document will be sent to the Anthropic API using your API key.
              Clinical information will be extracted and pre-filled into a new record
              for you to review before saving.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>
              {/* Camera button — opens device camera on mobile */}
              <button
                className="btn btn-primary"
                onClick={() => photoRef.current?.click()}
              >
                <Camera size={16} aria-hidden />
                Take photo
              </button>
              {/* File button — opens file browser (also shows camera option on mobile) */}
              <button
                className="btn btn-secondary"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp size={16} aria-hidden />
                Choose file
              </button>
            </div>
            <p style={{ fontSize: "0.75rem", color: "var(--dim)", marginTop: 4 }}>
              Accepts JPEG, PNG, WEBP, or PDF · max 10 MB
            </p>
          </div>

          {/* Hidden file inputs */}
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            style={{ display: "none" }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
      )}

      {/* ── STAGE: loading ─────────────────────────────────── */}
      {stage === "loading" && (
        <div
          className="loading-screen"
          style={{ flexDirection: "column", gap: 16 }}
          aria-live="polite"
        >
          <div
            style={{
              width: 40,
              height: 40,
              border: "3px solid var(--border)",
              borderTopColor: "var(--teal)",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
            aria-hidden
          />
          <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
            Analysing document…
          </p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ── STAGE: error ───────────────────────────────────── */}
      {stage === "error" && (
        <div className="form-body">
          <div
            style={{
              background: "#FEE2E2",
              border: "1px solid #FECACA",
              borderRadius: 10,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <p
              style={{
                fontWeight: 500,
                color: "#991B1B",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: "0.9rem",
              }}
            >
              <AlertTriangle size={16} aria-hidden />
              Import failed
            </p>
            <p style={{ fontSize: "0.82rem", color: "#7F1D1D", lineHeight: 1.6 }}>
              {errorMsg}
            </p>
            <button
              className="btn btn-secondary"
              onClick={() => { setStage("idle"); setErrorMsg(""); }}
              style={{ alignSelf: "flex-start" }}
            >
              <RefreshCw size={14} aria-hidden />
              Try again
            </button>
          </div>
        </div>
      )}

      {/* ── STAGE: done ────────────────────────────────────── */}
      {stage === "done" && (
        <div className="form-body">

          {/* Summary banner */}
          <div
            style={{
              background: "var(--pale)",
              border: "1px solid #b2dce2",
              borderRadius: 10,
              padding: "12px 16px",
              fontSize: "0.82rem",
              color: "var(--teal)",
              lineHeight: 1.6,
            }}
          >
            {extractedCount} field{extractedCount !== 1 ? "s" : ""} extracted.
            {uncertainCount > 0 && (
              <> <span style={{ color: "#92400E", fontWeight: 500 }}>
                {uncertainCount} marked uncertain
              </span> — please review these carefully.</>
            )}
          </div>

          {/* Uncertain fields warning */}
          {uncertainCount > 0 && (
            <div className="ai-warning">
              <p className="ai-warning-title">
                <AlertTriangle size={16} aria-hidden />
                Review required
              </p>
              <p>
                Fields highlighted in amber could not be determined with confidence.
                They are pre-filled but marked <strong>[UNCERTAIN]</strong> — please
                verify and correct them before saving.
              </p>
            </div>
          )}

          {/* Extracted field preview */}
          <section className="form-section" aria-label="Extracted data">
            <div className="form-section-title">Extracted data</div>
            {fields.map((f) => {
              const raw = extracted[f.key];
              if (raw === null || raw === undefined || raw === "") return null;
              const uncertain = isUncertain(raw);
              const value = displayValue(raw);
              return (
                <div
                  key={f.key}
                  className="form-field"
                  style={
                    uncertain
                      ? { background: "#FFFBEB", borderLeftColor: "#F59E0B" }
                      : undefined
                  }
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span className="form-label" style={uncertain ? { color: "#92400E" } : undefined}>
                      {f.label}
                    </span>
                    {uncertain && (
                      <span
                        style={{
                          fontSize: "0.62rem",
                          fontWeight: 600,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "#92400E",
                          background: "#FEF3C7",
                          borderRadius: 4,
                          padding: "1px 6px",
                          flexShrink: 0,
                        }}
                      >
                        Uncertain
                      </span>
                    )}
                  </div>
                  <p
                    style={{
                      fontSize: "0.9rem",
                      color: uncertain ? "#92400E" : "var(--text)",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                    }}
                  >
                    {value}
                  </p>
                </div>
              );
            })}
          </section>

          {/* Actions */}
          <div className="form-actions">
            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleCreate}
              disabled={creating}
              aria-busy={creating}
            >
              {creating ? "Creating record…" : "Create record and review →"}
            </button>
            <button
              className="btn btn-secondary"
              style={{ width: "100%" }}
              onClick={() => { setStage("idle"); setExtracted({}); }}
            >
              <RefreshCw size={14} aria-hidden />
              Import a different document
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

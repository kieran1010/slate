// ============================================================
// Charted PWA — ImportScreen.tsx
// ============================================================
// The AI document import flow. One component handles all three
// modules — only the system prompt and field layout differ.
//
// Stages:
//   idle     → file/photo picker UI
//   loading  → spinner while the Anthropic API call runs, then
//              while the record is created
//   error    → error message with a retry option
//
// There is no review step: once the document is read, the record is
// created in IndexedDB (upserting the patient master first if identity
// was found) and the detail/edit screen opens on it, so the user
// reviews every field there, corrects uncertainties, and saves.
//
// The [UNCERTAIN] prefix is preserved in stored values so it
// remains visible in the edit form, where it is shown in red
// (components/UncertainHighlight.tsx). The user removes it when they're satisfied
// the value is correct.
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

type Stage = "idle" | "loading" | "error";

// ── Per-module metadata ───────────────────────────────────────

const MODULE_TITLE: Record<ImportModule, string> = {
  "acute":      "Import acute referral",
  "pre-assess": "Import pre-assessment",
  "follow-up":  "Import follow-up",
};

// ── Component ─────────────────────────────────────────────────

export function ImportScreen({ module, navigate, goBack }: ImportScreenProps) {
  const config = useConfig();
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef  = useRef<HTMLInputElement>(null);

  const [stage, setStage]       = useState<Stage>("idle");
  const [loadingMsg, setLoadingMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

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

    setLoadingMsg("Analysing document…");
    setStage("loading");
    let extracted: ExtractedData;
    try {
      const base64 = await fileToBase64(file);
      const prompt = getSystemPrompt(module);
      extracted = await callImportApi(
        config.anthropicApiKey,
        prompt,
        base64,
        file.type
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Import failed — please try again."
      );
      setStage("error");
      return;
    }

    // Nothing usable read: say so, rather than open an empty record.
    const anything = Object.values(extracted).some(
      (v) => v !== null && v !== undefined && String(v).trim() !== ""
    );
    if (!anything) {
      setErrorMsg(
        "No details could be read from this document. Try a clearer photo or a different file."
      );
      setStage("error");
      return;
    }

    setLoadingMsg("Creating record…");
    try {
      await createRecord(extracted);
    } catch (err) {
      console.error("Create record failed:", err);
      setErrorMsg("The document was read, but the record couldn't be created. Please try again.");
      setStage("error");
    }
    // On success we've navigated to the new record — nothing to reset.
  }

  // ── Create record ───────────────────────────────────────────
  // Creates the record from the extracted fields and opens it.

  async function createRecord(extracted: ExtractedData) {
    // The model is asked for strings but may send a number (e.g. weight).
    const safe = (key: string): string => {
      const v = extracted[key];
      return v === null || v === undefined ? "" : String(v).trim();
    };
    const nhi = safe("nhi").toUpperCase();

    // Upsert patient master record if we have identity fields
    if (nhi && (safe("surname") || safe("givenName"))) {
      await upsertPatient({
        nhi,
        surname: safe("surname"),
        givenName: safe("givenName"),
        dob: normaliseDob(safe("dob")),
      });
    }

    // Create the module-specific record and navigate to edit it.
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
  }

  // ── Render ───────────────────────────────────────────────────

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
              Clinical information will be extracted into a new record, which opens
              for you to check and correct.
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
            {loadingMsg}
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

    </div>
  );
}

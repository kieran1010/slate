// ============================================================
// Charted PWA — ImportScreen.tsx
// ============================================================
// The AI document import flow. One component handles all three
// modules — only the system prompt and field layout differ. The
// pre-assessment module also offers "Operating list" mode, which reads
// a whole theatre list (screens/OperatingListImport.tsx).
//
// Stages (single document):
//   idle     → file/photo picker UI
//   loading  → spinner while the Anthropic API call runs, then
//              while the record is created or updated
//   match    → the patient (by NHI) already has an active record in
//              this module: add the document to it, or create a new one
//   error    → error message with a retry option
//
// There is no review step: once the document is read, the record is
// created (or added to) in IndexedDB and the detail/edit screen opens
// on it, so the user reviews every field there, corrects
// uncertainties, and saves.
//
// Patient identity: a stored name/DOB is never overwritten by an AI
// read — only blanks are filled (repository.fillPatientBlanks). A
// difference is shown as a warning on the match stage.
//
// Adding to an existing record follows utils/importMerge.ts: blanks
// are filled, differing text is appended under an "Imported" marker,
// nothing already there is removed.
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
import { ChevronLeft, Camera, FileUp, AlertTriangle, FilePlus2, FilePen } from "lucide-react";
import {
  getSystemPrompt,
  fileToBase64,
  callImportApi,
  normaliseDob,
  type ImportModule,
  type ExtractedData,
} from "../utils/importAi";
import {
  normaliseNhi,
  identityMismatches,
  buildMergeChanges,
} from "../utils/importMerge";
import { hasUncertainTag } from "../utils/uncertain";
import {
  getPatient,
  fillPatientBlanks,
  createAcute,
  createPreAssess,
  createFollowUp,
  updateAcute,
  updatePreAssess,
  updateFollowUp,
  listActiveAcuteForNhi,
  listActivePreAssessForNhi,
  listActiveFollowUpForNhi,
} from "../data/repository";
import type { StoredAcute, StoredPreAssess, StoredFollowUp } from "../data/db";
import type { Patient } from "../data/models";
import { todayIsoDate } from "../data/dates";
import { capitalCase, formatDateTime, formatDateDMY } from "../utils/format";
import { useConfig } from "../hooks/useConfig";
import type { NavigateFn } from "../types/nav";
import { OperatingListImport } from "./OperatingListImport";
import { Spinner, ImportError } from "../components/ImportStatus";

// ── Types ─────────────────────────────────────────────────────

interface ImportScreenProps {
  module: ImportModule;
  navigate: NavigateFn;
  goBack: () => void;
}

type Stage = "idle" | "loading" | "match" | "error";
type Mode = "single" | "list";

type AnyStored = StoredAcute | StoredPreAssess | StoredFollowUp;

// What the document was read as: every field a trimmed string.
type ReadFields = Record<string, string>;

interface MatchState {
  read: ReadFields;
  nhi: string;              // normalised NHI the records were found under
  nhiUncertain: boolean;
  matches: AnyStored[];
  patient: Patient | undefined;
  mismatches: string[];
}

// ── Per-module metadata ───────────────────────────────────────

const MODULE_TITLE: Record<ImportModule, string> = {
  "acute":      "Import acute referral",
  "pre-assess": "Import pre-assessment",
  "follow-up":  "Import follow-up",
};

const MODULE_NOUN: Record<ImportModule, string> = {
  "acute":      "acute referral",
  "pre-assess": "pre-assessment",
  "follow-up":  "follow-up",
};

// ── Helpers ───────────────────────────────────────────────────

// The model is asked for strings but may send a number (e.g. weight).
function toReadFields(extracted: ExtractedData): ReadFields {
  const out: ReadFields = {};
  for (const [k, v] of Object.entries(extracted)) {
    out[k] = v === null || v === undefined ? "" : String(v).trim();
  }
  return out;
}

// NHI as stored on a new record: normalised, keeping the [UNCERTAIN]
// tag (so the detail screen shows it in red) when the read was unsure.
function nhiForStorage(raw: string): string {
  const nhi = normaliseNhi(raw);
  if (!nhi) return "";
  return hasUncertainTag(raw) ? `[UNCERTAIN] ${nhi}` : nhi;
}

function listActiveForNhi(module: ImportModule, nhi: string): Promise<AnyStored[]> {
  switch (module) {
    case "acute":      return listActiveAcuteForNhi(nhi);
    case "pre-assess": return listActivePreAssessForNhi(nhi);
    case "follow-up":  return listActiveFollowUpForNhi(nhi);
  }
}

// Two short lines describing an existing record, for the match stage.
function recordSummary(module: ImportModule, rec: AnyStored): string[] {
  const firstLine = (s: string) => s.split("\n")[0].trim();
  if (module === "acute") {
    const r = rec as StoredAcute;
    return [firstLine(r.taskToComplete) || "No task entered", r.location || "No location"];
  }
  if (module === "pre-assess") {
    const r = rec as StoredPreAssess;
    return [
      r.procedure || "No procedure entered",
      r.dateOfSurgery ? `Surgery ${formatDateTime(r.dateOfSurgery)}` : "No date of surgery",
    ];
  }
  const r = rec as StoredFollowUp;
  return [
    r.intervention || "No intervention entered",
    r.interventionDate ? formatDateTime(r.interventionDate) : "No intervention date",
  ];
}

// ── Component ─────────────────────────────────────────────────

export function ImportScreen({ module, navigate, goBack }: ImportScreenProps) {
  const config = useConfig();
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef  = useRef<HTMLInputElement>(null);

  const [mode, setMode]         = useState<Mode>("single");
  const [stage, setStage]       = useState<Stage>("idle");
  const [loadingMsg, setLoadingMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [match, setMatch]       = useState<MatchState | null>(null);

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
    const read = toReadFields(extracted);
    if (!Object.values(read).some((v) => v !== "")) {
      setErrorMsg(
        "No details could be read from this document. Try a clearer photo or a different file."
      );
      setStage("error");
      return;
    }

    // Does this patient already have an active record in this module?
    const lookupNhi = normaliseNhi(read.nhi);
    if (lookupNhi) {
      try {
        const matches = await listActiveForNhi(module, lookupNhi);
        if (matches.length > 0) {
          const patient = await getPatient(lookupNhi);
          setMatch({
            read,
            nhi: lookupNhi,
            nhiUncertain: hasUncertainTag(read.nhi),
            matches,
            patient,
            mismatches: patient
              ? identityMismatches(patient, {
                  surname: read.surname ?? "",
                  givenName: read.givenName ?? "",
                  dob: read.dob ?? "",
                })
              : [],
          });
          setStage("match");
          return;
        }
      } catch (err) {
        // The lookup is a convenience: if it fails, carry on and create.
        console.error("Existing-record lookup failed:", err);
      }
    }

    await createAndOpen(read);
  }

  // ── Create record ───────────────────────────────────────────
  // Creates the record from the extracted fields and opens it.

  async function createAndOpen(read: ReadFields) {
    setLoadingMsg("Creating record…");
    setStage("loading");
    try {
      await createRecord(read);
    } catch (err) {
      console.error("Create record failed:", err);
      setErrorMsg("The document was read, but the record couldn't be created. Please try again.");
      setStage("error");
    }
    // On success we've navigated to the new record — nothing to reset.
  }

  async function saveIdentity(nhi: string, read: ReadFields) {
    const surname = read.surname ?? "";
    const givenName = read.givenName ?? "";
    if (nhi && (surname || givenName)) {
      await fillPatientBlanks({ nhi, surname, givenName, dob: normaliseDob(read.dob) });
    }
  }

  async function createRecord(read: ReadFields) {
    const safe = (key: string): string => read[key] ?? "";
    const nhi = nhiForStorage(safe("nhi"));

    await saveIdentity(nhi, read);

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

  // ── Add to an existing record ───────────────────────────────

  async function addToExisting(rec: AnyStored) {
    if (!match) return;
    setLoadingMsg("Adding to record…");
    setStage("loading");
    try {
      await saveIdentity(match.nhi, match.read);
      const { changes } = buildMergeChanges(
        module,
        rec as unknown as Record<string, unknown>,
        match.read,
        formatDateDMY(todayIsoDate())
      );
      const id = rec.id!;
      const changed = Object.keys(changes).length > 0;
      if (module === "acute") {
        if (changed) await updateAcute(id, changes);
        navigate({ tab: "acute", view: "detail", id });
      } else if (module === "pre-assess") {
        if (changed) await updatePreAssess(id, changes);
        navigate({ tab: "pre-assess", view: "detail", id });
      } else {
        if (changed) await updateFollowUp(id, changes);
        navigate({ tab: "follow-up", view: "detail", id });
      }
    } catch (err) {
      console.error("Add to record failed:", err);
      setErrorMsg("The document was read, but it couldn't be added to the record. Please try again.");
      setStage("error");
    }
  }

  function reset() {
    setStage("idle");
    setErrorMsg("");
    setMatch(null);
  }

  // ── Render ───────────────────────────────────────────────────

  const listMode = module === "pre-assess" && mode === "list";
  const title = listMode ? "Import operating list" : MODULE_TITLE[module];

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
        <h1 className="screen-header-title">{title}</h1>
        <div style={{ minWidth: 56 }} />
      </div>

      {/* ── Mode switch (pre-assessment only, before reading) ── */}
      {module === "pre-assess" && stage === "idle" && (
        <div className="import-mode" role="group" aria-label="What to import">
          <button
            className={`import-mode-btn${mode === "single" ? " import-mode-btn-on" : ""}`}
            aria-pressed={mode === "single"}
            onClick={() => setMode("single")}
          >
            One patient
          </button>
          <button
            className={`import-mode-btn${mode === "list" ? " import-mode-btn-on" : ""}`}
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            Operating list
          </button>
        </div>
      )}

      {listMode && (
        <OperatingListImport
          apiKey={config.anthropicApiKey}
          navigate={navigate}
          onBusyChange={(busy) => setStage(busy ? "loading" : "idle")}
        />
      )}

      {/* ── STAGE: idle ────────────────────────────────────── */}
      {!listMode && stage === "idle" && (
        <div className="form-body">
          <div className="import-card" style={{ alignItems: "center", textAlign: "center" }}>
            <FileUp size={36} color="var(--teal)" aria-hidden />
            <p style={{ fontWeight: 500, color: "var(--navy)", fontSize: "0.95rem" }}>
              Choose a document to import
            </p>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", lineHeight: 1.6 }}>
              The document will be sent to the Anthropic API using your API key.
              Clinical information will be extracted into a new record, which opens
              for you to check and correct. If the patient already has an active{" "}
              {MODULE_NOUN[module]}, you can add the information to it instead.
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
            onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            style={{ display: "none" }}
            onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }}
          />
        </div>
      )}

      {/* ── STAGE: loading ─────────────────────────────────── */}
      {!listMode && stage === "loading" && <Spinner message={loadingMsg} />}

      {/* ── STAGE: match ───────────────────────────────────── */}
      {!listMode && stage === "match" && match && (
        <div className="form-body">
          <div className="import-card">
            <p className="import-card-title">
              {match.patient
                ? `${capitalCase(match.patient.surname)}, ${capitalCase(match.patient.givenName)} · ${match.nhi}`
                : match.nhi}
            </p>
            <p className="import-card-text">
              This patient already has {match.matches.length === 1
                ? `an active ${MODULE_NOUN[module]}`
                : `${match.matches.length} active ${MODULE_NOUN[module]}s`}.
              You can add what was read from this document to{" "}
              {match.matches.length === 1 ? "it" : "one of them"}, or create a separate record.
            </p>

            {(match.nhiUncertain || match.mismatches.length > 0) && (
              <div className="import-warning" role="alert">
                <p className="import-warning-title">
                  <AlertTriangle size={15} aria-hidden />
                  Check this is the same patient
                </p>
                {match.nhiUncertain && (
                  <p>The NHI on the document was hard to read.</p>
                )}
                {match.mismatches.map((m) => <p key={m}>{m}</p>)}
                <p>The stored name and date of birth will not be changed.</p>
              </div>
            )}

            <ul className="import-match-list">
              {match.matches.map((rec) => {
                const [line1, line2] = recordSummary(module, rec);
                return (
                  <li key={rec.id} className="import-match">
                    <div style={{ minWidth: 0 }}>
                      <p className="import-match-main">{line1}</p>
                      <p className="import-match-meta">
                        {line2} · updated {formatDateTime(rec.updatedAt)}
                      </p>
                    </div>
                    <button className="btn btn-primary" onClick={() => addToExisting(rec)}>
                      <FilePen size={15} aria-hidden />
                      Add to this
                    </button>
                  </li>
                );
              })}
            </ul>

            <p className="import-card-note">
              Adding fills in empty fields. Where a field already holds different text, the new
              text is added underneath, after a line saying "Imported" and today's date. Differing
              one-line details (e.g. procedure, weight, dates) are listed in Notes instead.
              Nothing already in the record is removed.
            </p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn btn-secondary" onClick={() => createAndOpen(match.read)}>
                <FilePlus2 size={15} aria-hidden />
                Create new record
              </button>
              <button className="btn btn-ghost" onClick={reset}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── STAGE: error ───────────────────────────────────── */}
      {!listMode && stage === "error" && (
        <ImportError message={errorMsg} onRetry={reset} />
      )}

    </div>
  );
}

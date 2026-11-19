// ============================================================
// Slate — screens/OperatingListImport.tsx
// ============================================================
// "Operating list" mode of the pre-assessment import screen
// (screens/ImportScreen.tsx): reads a whole theatre list and creates
// a pre-assessment for each patient on it.
//
// Stages:
//   pages    → the user adds the list's pages: photos taken one at a
//              time, and/or several files (images or PDFs) at once
//   loading  → all pages go to the Anthropic API in ONE request, so the
//              model sees the whole list (a header on page 1 can carry
//              the date and surgeon for every page)
//   review   → a checklist of every patient read. Each row can be
//              unticked, its NHI corrected, and — when the patient
//              already has an active pre-assessment — set to "add to
//              existing" (the default) or "create new"
//   saving   → records created / added to, one row at a time
//   done     → a summary, then back to the pre-assessment list
//   error    → message, with "Try again" back to the pages
//
// SAFETY DEFAULTS — rows start UNTICKED when:
//   • no NHI was read (it can't be imported until one is typed in —
//     a record without an NHI would have no name attached);
//   • the NHI was hard to read ([UNCERTAIN]);
//   • the name/DOB read differs from the patient Slate already has
//     under that NHI (could be a misread NHI → wrong patient);
//   • the list marks the case as cancelled.
// The stored name/DOB is never overwritten (fillPatientBlanks), and
// adding to a record never removes anything (utils/importMerge.ts).
//
// FILE LOCATION:
//   src/screens/OperatingListImport.tsx
// ============================================================

import { useEffect, useRef, useState } from "react";
import { Camera, FileUp, X, AlertTriangle, ListChecks, CheckCircle2 } from "lucide-react";
import {
  fileToBase64,
  callOperatingListApi,
  normaliseDob,
  type ExtractedData,
} from "../utils/importAi";
import { normaliseNhi, identityMismatches, buildMergeChanges } from "../utils/importMerge";
import { hasUncertainTag } from "../utils/uncertain";
import {
  getPatient,
  fillPatientBlanks,
  createPreAssess,
  updatePreAssess,
  listActivePreAssessForNhi,
} from "../data/repository";
import type { StoredPreAssess } from "../data/db";
import type { Patient } from "../data/models";
import { todayIsoDate } from "../data/dates";
import { capitalCase, formatDateTime, formatDateDMY } from "../utils/format";
import type { NavigateFn } from "../types/nav";
import { Spinner, ImportError } from "../components/ImportStatus";

// ── Limits ────────────────────────────────────────────────────
// The API takes up to 32 MB per request, and base64 adds a third,
// so the pages together are kept to 20 MB.
const MAX_PAGES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

// ── Types ─────────────────────────────────────────────────────

interface Props {
  apiKey: string;
  navigate: NavigateFn;
  /** True once the user has moved past adding pages (hides the mode switch). */
  onBusyChange: (busy: boolean) => void;
}

type Stage = "pages" | "loading" | "review" | "saving" | "done" | "error";

interface Page {
  id: number;
  file: File;
}

type ReadFields = Record<string, string>;

interface Row {
  key: number;
  read: ReadFields;            // as read, [UNCERTAIN] tags included
  nhi: string;                 // editable; normalised
  nhiUncertain: boolean;
  cancelled: boolean;
  include: boolean;
  target: number | "new";      // record id to add to, or a new record
  lookedUpFor: string | null;  // the NHI `matches`/`patient` belong to
  matches: StoredPreAssess[];
  patient: Patient | undefined;
  mismatches: string[];
}

interface Lookup {
  matches: StoredPreAssess[];
  patient: Patient | undefined;
  mismatches: string[];
}

interface Outcome {
  created: number;
  added: number;
  failed: string[];
}

// ── Helpers ───────────────────────────────────────────────────

const TAG = /\[UNCERTAIN\]\s*/gi;

function toReadFields(p: ExtractedData): ReadFields {
  const out: ReadFields = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = v === null || v === undefined ? "" : String(v).trim();
  }
  return out;
}

function rowName(read: ReadFields): string {
  const surname = capitalCase(read.surname ?? "").replace(TAG, "");
  const given = capitalCase(read.givenName ?? "").replace(TAG, "");
  return [surname, given].filter(Boolean).join(", ");
}

async function lookup(nhi: string, read: ReadFields): Promise<Lookup> {
  if (!nhi) return { matches: [], patient: undefined, mismatches: [] };
  const [matches, patient] = await Promise.all([
    listActivePreAssessForNhi(nhi),
    getPatient(nhi),
  ]);
  const mismatches = patient
    ? identityMismatches(patient, {
        surname: read.surname ?? "",
        givenName: read.givenName ?? "",
        dob: read.dob ?? "",
      })
    : [];
  return { matches, patient, mismatches };
}

// Folds a lookup into a row. A row whose name/DOB disagrees with the
// stored patient is unticked, so it needs a deliberate tick.
function applyLookup(row: Row, nhi: string, res: Lookup): Row {
  const target =
    row.target !== "new" && res.matches.some((m) => m.id === row.target)
      ? row.target
      : res.matches[0]?.id ?? "new";
  return {
    ...row,
    ...res,
    target,
    lookedUpFor: nhi,
    include: res.mismatches.length > 0 ? false : row.include,
  };
}

// The pre-assessment fields an operating list provides. A case the
// user imports although the list marks it cancelled says so in Notes.
function listFields(row: Row): ReadFields {
  const r = row.read;
  const notes = [r.notes ?? "", row.cancelled ? "Marked as cancelled on the operating list" : ""]
    .filter(Boolean)
    .join("\n");
  return {
    procedure: r.procedure ?? "",
    surgeon: r.surgeon ?? "",
    dateOfSurgery: r.dateOfSurgery ?? "",
    indicationForSurgery: r.indicationForSurgery ?? "",
    allergies: r.allergies ?? "",
    notes,
  };
}

/** A read value with its [UNCERTAIN] tag shown as a red "(?)". */
function Val({ v }: { v: string }) {
  if (!hasUncertainTag(v)) return <>{v}</>;
  return (
    <span className="import-uncertain" title="Hard to read — check this">
      {v.replace(TAG, "")} (?)
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────

export function OperatingListImport({ apiKey, navigate, onBusyChange }: Props) {
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextPageId = useRef(1);

  const [stage, setStageRaw] = useState<Stage>("pages");
  const [pages, setPages] = useState<Page[]>([]);
  const [pageError, setPageError] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  function setStage(s: Stage) {
    setStageRaw(s);
    onBusyChange(s !== "pages");
  }

  // ── Pages ───────────────────────────────────────────────────

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const problems: string[] = [];
    const added: Page[] = [];
    let total = pages.reduce((n, p) => n + p.file.size, 0);
    for (const file of Array.from(list)) {
      if (!(file.type.startsWith("image/") || file.type === "application/pdf")) {
        problems.push(`${file.name}: not an image or PDF.`);
      } else if (file.size > MAX_FILE_BYTES) {
        problems.push(`${file.name}: larger than 10 MB.`);
      } else if (pages.length + added.length >= MAX_PAGES) {
        problems.push(`${file.name}: a list can have at most ${MAX_PAGES} pages.`);
      } else if (total + file.size > MAX_TOTAL_BYTES) {
        problems.push(`${file.name}: the pages together would be larger than 20 MB.`);
      } else {
        total += file.size;
        added.push({ id: nextPageId.current++, file });
      }
    }
    setPages((prev) => [...prev, ...added]);
    setPageError(problems.join(" "));
  }

  function removePage(id: number) {
    setPages((prev) => prev.filter((p) => p.id !== id));
    setPageError("");
  }

  // ── Read the list ───────────────────────────────────────────

  async function readList() {
    if (pages.length === 0) return;
    setStage("loading");
    let read: ExtractedData[];
    try {
      const docs = await Promise.all(
        pages.map(async ({ file }) => ({ base64: await fileToBase64(file), mediaType: file.type }))
      );
      read = await callOperatingListApi(apiKey, docs, todayIsoDate());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Import failed — please try again.");
      setStage("error");
      return;
    }

    if (read.length === 0) {
      setErrorMsg("No patients could be read from this list. Try clearer photos or a different file.");
      setStage("error");
      return;
    }

    try {
      const initial: Row[] = read.map((p, i) => {
        const fields = toReadFields(p);
        const nhi = normaliseNhi(fields.nhi);
        const nhiUncertain = hasUncertainTag(fields.nhi);
        const cancelled = fields.cancelled === "true";
        return {
          key: i,
          read: fields,
          nhi,
          nhiUncertain,
          cancelled,
          include: !!nhi && !nhiUncertain && !cancelled,
          target: "new",
          lookedUpFor: null,
          matches: [],
          patient: undefined,
          mismatches: [],
        };
      });
      const looked = await Promise.all(
        initial.map(async (r) => applyLookup(r, r.nhi, await lookup(r.nhi, r.read)))
      );
      setRows(looked);
      setStage("review");
    } catch (err) {
      console.error("Operating list lookup failed:", err);
      setErrorMsg("The list was read, but Slate couldn't check it against your records. Please try again.");
      setStage("error");
    }
  }

  // ── Review: re-check a row whose NHI was edited ─────────────

  useEffect(() => {
    if (stage !== "review") return;
    const stale = rows.filter((r) => r.lookedUpFor !== r.nhi);
    if (stale.length === 0) return;
    const timer = setTimeout(async () => {
      const results = await Promise.all(
        stale.map(async (r) => ({ key: r.key, nhi: r.nhi, res: await lookup(r.nhi, r.read) }))
      );
      setRows((prev) =>
        prev.map((r) => {
          const hit = results.find((x) => x.key === r.key && x.nhi === r.nhi);
          return hit ? applyLookup(r, hit.nhi, hit.res) : r;
        })
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [rows, stage]);

  function updateRow(key: number, change: (r: Row) => Row) {
    setRows((prev) => prev.map((r) => (r.key === key ? change(r) : r)));
  }

  function editNhi(key: number, value: string) {
    const nhi = normaliseNhi(value);
    updateRow(key, (r) => ({
      ...r,
      nhi,
      // The user is checking it now; an emptied NHI can't be imported.
      nhiUncertain: false,
      include: nhi ? r.include : false,
    }));
  }

  const ready = (r: Row) => !!r.nhi && r.lookedUpFor === r.nhi;
  const selected = rows.filter((r) => r.include);
  const anyStale = selected.some((r) => !ready(r));
  const nhiCounts = rows.reduce<Record<string, number>>((acc, r) => {
    if (r.nhi) acc[r.nhi] = (acc[r.nhi] ?? 0) + 1;
    return acc;
  }, {});

  function setAll(include: boolean) {
    setRows((prev) => prev.map((r) => ({ ...r, include: include && ready(r) })));
  }

  // ── Save ────────────────────────────────────────────────────

  async function save() {
    const todo = rows.filter((r) => r.include && ready(r));
    if (todo.length === 0) return;
    setStage("saving");
    const importedOn = formatDateDMY(todayIsoDate());
    const result: Outcome = { created: 0, added: 0, failed: [] };

    for (const [i, row] of todo.entries()) {
      setProgress(`Saving ${i + 1} of ${todo.length}…`);
      const label = rowName(row.read) || row.nhi;
      try {
        const surname = row.read.surname ?? "";
        const givenName = row.read.givenName ?? "";
        const dob = normaliseDob(row.read.dob);
        if (surname || givenName || dob) {
          await fillPatientBlanks({ nhi: row.nhi, surname, givenName, dob });
        }

        const fields = listFields(row);
        if (row.target === "new") {
          await createPreAssess({
            nhi: row.nhi,
            dateOfSurgery: fields.dateOfSurgery,
            procedure: fields.procedure,
            surgeon: fields.surgeon,
            indicationForSurgery: fields.indicationForSurgery,
            pastMedicalHistory: "",
            anaestheticHistory: "",
            socialHistory: "",
            functionalStatus: "",
            investigations: "",
            medications: "",
            allergies: fields.allergies,
            weight: "",
            height: "",
            airwayAssessment: "",
            notes: fields.notes,
            status: "PENDING",
          });
          result.created += 1;
        } else {
          // Re-read the record now: an earlier row on this list (the same
          // patient twice) may just have changed it.
          const current = (await listActivePreAssessForNhi(row.nhi)).find(
            (r) => r.id === row.target
          );
          if (!current) throw new Error("The record is no longer active.");
          const { changes } = buildMergeChanges(
            "pre-assess",
            current as unknown as Record<string, unknown>,
            fields,
            importedOn
          );
          if (Object.keys(changes).length > 0) await updatePreAssess(current.id!, changes);
          result.added += 1;
        }
      } catch (err) {
        console.error("Operating list row failed:", err);
        result.failed.push(label);
      }
    }

    setOutcome(result);
    setStage("done");
  }

  function startAgain() {
    setRows([]);
    setOutcome(null);
    setErrorMsg("");
    setStage("pages");
  }

  // ── Render ───────────────────────────────────────────────────

  if (stage === "loading") {
    return <Spinner message={`Reading operating list (${pages.length} page${pages.length === 1 ? "" : "s"})…`} />;
  }
  if (stage === "saving") return <Spinner message={progress} />;
  if (stage === "error") return <ImportError message={errorMsg} onRetry={startAgain} />;

  if (stage === "done" && outcome) {
    return (
      <div className="form-body">
        <div className="import-card">
          <p className="import-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CheckCircle2 size={18} color="var(--teal)" aria-hidden />
            Operating list imported
          </p>
          <ul className="import-summary">
            {outcome.created > 0 && (
              <li>{outcome.created} new pre-assessment{outcome.created === 1 ? "" : "s"} created</li>
            )}
            {outcome.added > 0 && (
              <li>{outcome.added} existing pre-assessment{outcome.added === 1 ? "" : "s"} added to</li>
            )}
          </ul>
          {outcome.failed.length > 0 && (
            <div className="import-warning" role="alert">
              <p className="import-warning-title">
                <AlertTriangle size={15} aria-hidden />
                {outcome.failed.length} could not be saved
              </p>
              <p>{outcome.failed.join("; ")}. Please add {outcome.failed.length === 1 ? "this patient" : "these patients"} by hand.</p>
            </div>
          )}
          <p className="import-card-note">
            Open each record to check it. Details that were hard to read are marked [UNCERTAIN]
            in red. Information added to an existing record sits under an "Imported" line.
          </p>
          <button
            className="btn btn-primary"
            style={{ alignSelf: "flex-start" }}
            onClick={() => navigate({ tab: "pre-assess", view: "list" })}
          >
            View pre-assessments
          </button>
        </div>
      </div>
    );
  }

  if (stage === "review") {
    return (
      <div className="form-body">
        <div className="import-card">
          <p className="import-card-title">
            {rows.length} patient{rows.length === 1 ? "" : "s"} found
          </p>
          <p className="import-card-text">
            Check each patient against the list. Untick any you don't want to import, and
            correct an NHI if it was misread.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-import" onClick={() => setAll(true)}>Tick all</button>
            <button className="btn-import" onClick={() => setAll(false)}>Untick all</button>
          </div>
        </div>

        <ul className="import-rows">
          {rows.map((row) => {
            const r = row.read;
            const name = rowName(r);
            const nameUncertain = hasUncertainTag(r.surname) || hasUncertainTag(r.givenName);
            const otherUncertain = ["procedure", "surgeon", "dateOfSurgery", "dob", "indicationForSurgery", "allergies", "notes"]
              .some((k) => hasUncertainTag(r[k]));
            const checkboxId = `oplist-row-${row.key}`;
            const nhiId = `oplist-nhi-${row.key}`;
            const dob = normaliseDob((r.dob ?? "").replace(TAG, ""));
            const warnings: string[] = [];
            if (row.cancelled) warnings.push("The list marks this case as cancelled.");
            if (!row.nhi) warnings.push("No NHI was read. Type it in to import this patient.");
            if (row.nhiUncertain) warnings.push("The NHI was hard to read. Check it against the list.");
            warnings.push(...row.mismatches);
            if (row.mismatches.length > 0) warnings.push("The stored name and date of birth will not be changed.");
            if (row.nhi && (nhiCounts[row.nhi] ?? 0) > 1) warnings.push("This NHI appears more than once on the list.");

            return (
              <li key={row.key} className={`import-row${row.include ? " import-row-on" : ""}`}>
                <div className="import-row-top">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    className="import-row-check"
                    checked={row.include}
                    disabled={!ready(row)}
                    onChange={(e) => updateRow(row.key, (x) => ({ ...x, include: e.target.checked }))}
                  />
                  <label htmlFor={checkboxId} className="import-row-name">
                    {name ? (
                      <span className={nameUncertain ? "import-uncertain" : undefined}>
                        {name}{nameUncertain ? " (?)" : ""}
                      </span>
                    ) : (
                      "Name not read"
                    )}
                  </label>
                </div>

                <div className="import-row-nhi">
                  <label htmlFor={nhiId}>NHI</label>
                  <input
                    id={nhiId}
                    className="form-input"
                    value={row.nhi}
                    placeholder="Enter NHI"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => editNhi(row.key, e.target.value)}
                  />
                  {dob && <span className="import-row-meta">DOB {formatDateDMY(dob)}</span>}
                </div>

                {r.procedure && <p className="import-row-proc"><Val v={r.procedure} /></p>}
                {(r.dateOfSurgery || r.surgeon) && (
                  <p className="import-row-meta">
                    {r.dateOfSurgery && (
                      <Val v={hasUncertainTag(r.dateOfSurgery) ? r.dateOfSurgery : formatDateTime(r.dateOfSurgery)} />
                    )}
                    {r.dateOfSurgery && r.surgeon && " · "}
                    {r.surgeon && <Val v={r.surgeon} />}
                  </p>
                )}
                {otherUncertain && (
                  <p className="import-row-meta">
                    <span className="import-uncertain">(?)</span> Some details were hard to read. They
                    will be marked [UNCERTAIN] in the record.
                  </p>
                )}

                {warnings.length > 0 && (
                  <div className="import-warning">
                    {warnings.map((w) => (
                      <p key={w} style={{ display: "flex", gap: 6 }}>
                        <AlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                        {w}
                      </p>
                    ))}
                  </div>
                )}

                {row.lookedUpFor === row.nhi && row.matches.length > 0 && (
                  <div className="import-row-target">
                    <label htmlFor={`oplist-target-${row.key}`}>
                      Already has an active pre-assessment
                    </label>
                    <select
                      id={`oplist-target-${row.key}`}
                      className="form-select"
                      value={String(row.target)}
                      onChange={(e) =>
                        updateRow(row.key, (x) => ({
                          ...x,
                          target: e.target.value === "new" ? "new" : Number(e.target.value),
                        }))
                      }
                    >
                      {row.matches.map((m) => (
                        <option key={m.id} value={m.id}>
                          Add to existing: {m.procedure || "no procedure"}
                          {m.dateOfSurgery ? `, ${formatDateTime(m.dateOfSurgery)}` : ""}
                        </option>
                      ))}
                      <option value="new">Create a new pre-assessment</option>
                    </select>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="import-card">
          <p className="import-card-note">
            Adding to an existing pre-assessment fills in empty fields. Where a field already
            holds different text, the new text is added underneath, after a line saying
            "Imported" and today's date. A different procedure, surgeon or date of surgery is
            listed in Notes instead. Nothing already in the record is removed.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              disabled={selected.length === 0 || anyStale}
              onClick={save}
            >
              <ListChecks size={16} aria-hidden />
              Import {selected.length} patient{selected.length === 1 ? "" : "s"}
            </button>
            <button className="btn btn-ghost" onClick={startAgain}>
              Start again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Stage: pages ────────────────────────────────────────────
  return (
    <div className="form-body">
      <div className="import-card" style={{ alignItems: "center", textAlign: "center" }}>
        <FileUp size={36} color="var(--teal)" aria-hidden />
        <p style={{ fontWeight: 500, color: "var(--navy)", fontSize: "0.95rem" }}>
          Add the pages of the operating list
        </p>
        <p style={{ fontSize: "0.82rem", color: "var(--muted)", lineHeight: 1.6 }}>
          Take a photo of each page, or choose a PDF or several images. All the pages are sent
          together to the Anthropic API using your API key. You'll see every patient found and
          choose which to import before any record is created.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>
          <button className="btn btn-primary" onClick={() => photoRef.current?.click()}>
            <Camera size={16} aria-hidden />
            {pages.length > 0 ? "Photo of next page" : "Take photo"}
          </button>
          <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
            <FileUp size={16} aria-hidden />
            Choose files
          </button>
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--dim)", marginTop: 4 }}>
          JPEG, PNG, WEBP or PDF · up to {MAX_PAGES} pages, 10 MB each, 20 MB in total
        </p>
      </div>

      {pageError && (
        <div className="import-warning" role="alert">
          <p>{pageError}</p>
        </div>
      )}

      {pages.length > 0 && (
        <div className="import-card">
          <ol className="import-pages">
            {pages.map((p, i) => (
              <li key={p.id}>
                <span className="import-page-name">
                  Page {i + 1} · {p.file.name}
                </span>
                <button
                  className="btn-icon-sm"
                  onClick={() => removePage(p.id)}
                  aria-label={`Remove page ${i + 1}`}
                >
                  <X size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          <button className="btn btn-primary" style={{ alignSelf: "flex-start" }} onClick={readList}>
            <ListChecks size={16} aria-hidden />
            Read list ({pages.length} page{pages.length === 1 ? "" : "s"})
          </button>
        </div>
      )}

      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: "none" }}
        onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
      />
    </div>
  );
}

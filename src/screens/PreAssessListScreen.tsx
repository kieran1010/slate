// ============================================================
// Charted PWA — PreAssessListScreen.tsx
// ============================================================
// Shows all ACTIVE pre-assessment records for the current
// profile. Sort order (applied in the repository):
//   • Date of surgery DESCENDING (most recent date at top)
//   • Time of surgery ASCENDING within a date (running order)
//   • Records with no surgery date at the very bottom
//
// Each card shows patient name, procedure (italic teal),
// surgery date/time, and status badge.
//
// FILE LOCATION:
//   src/screens/PreAssessListScreen.tsx
// ============================================================

import { useLiveQuery } from "dexie-react-hooks";
import { Plus, ClipboardList, FileUp } from "lucide-react";
import { listActivePreAssess, listPatients } from "../data/repository";
import { useConfig } from "../hooks/useConfig";
import { calculateAge } from "../data/models";
import { formatDateTime } from "../utils/format";
import type { RecordStatus } from "../data/models";
import type { NavigateFn } from "../types/nav";

interface PreAssessListScreenProps {
  navigate: NavigateFn;
}

function statusCls(s: RecordStatus): string {
  return {
    PENDING: "badge-pending",
    IN_PROGRESS: "badge-in-progress",
    COMPLETE: "badge-complete",
    NEEDS_REVIEW: "badge-needs-review",
  }[s];
}

function statusLabel(s: RecordStatus): string {
  return {
    PENDING: "Pending",
    IN_PROGRESS: "In progress",
    COMPLETE: "Complete",
    NEEDS_REVIEW: "Needs review",
  }[s];
}

export function PreAssessListScreen({ navigate }: PreAssessListScreenProps) {
  const config = useConfig();
  const aiReady = config.aiEnabled && !!config.anthropicApiKey;
  const rows = useLiveQuery(async () => {
    const [records, patients] = await Promise.all([
      listActivePreAssess(),
      listPatients(),
    ]);
    const byNhi = new Map(patients.map((p) => [p.nhi, p]));
    return records.map((rec) => ({ rec, patient: byNhi.get(rec.nhi) }));
  }, []);

  if (rows === undefined) {
    return <div className="loading-screen">Loading assessments…</div>;
  }

  return (
    <div>
      <div className="list-header">
        <h1 className="list-header-title">Pre-assessment</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {aiReady && (
            <button
              className="btn-import"
              onClick={() => navigate({ tab: "pre-assess", view: "import" })}
              aria-label="Import pre-assessment from document"
            >
              <FileUp size={15} aria-hidden />
              Import
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => navigate({ tab: "pre-assess", view: "detail", id: "new" })}
            aria-label="New pre-assessment"
          >
            <Plus size={16} aria-hidden />
            New
          </button>
        </div>
      </div>

      {rows.length === 0 && (
        <div className="empty-state">
          <ClipboardList size={36} color="var(--dim)" aria-hidden />
          <p className="empty-state-title">No active assessments</p>
          <p>Tap <strong>New</strong> to add a pre-assessment.</p>
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map(({ rec, patient }) => {
          const name = patient
            ? `${patient.surname}, ${patient.givenName}`
            : rec.nhi;
          const age = patient?.dob ? calculateAge(patient.dob) : "";
          const surgeryDisplay = rec.dateOfSurgery
            ? formatDateTime(rec.dateOfSurgery)
            : null;

          return (
            <li key={rec.id}>
              <div
                className="patient-card"
                role="button"
                tabIndex={0}
                aria-label={`${name} — ${rec.procedure || "No procedure entered"}`}
                onClick={() =>
                  navigate({ tab: "pre-assess", view: "detail", id: rec.id! })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    navigate({ tab: "pre-assess", view: "detail", id: rec.id! });
                }}
              >
                <div className="patient-card-top">
                  <span className="patient-card-name">{name}</span>
                  <span className="patient-card-nhi">{rec.nhi}</span>
                </div>

                {rec.procedure && (
                  <div className="patient-card-task">{rec.procedure}</div>
                )}

                <div
                  className="patient-card-meta"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginTop: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  {surgeryDisplay ? (
                    <span>Surgery {surgeryDisplay}</span>
                  ) : (
                    <span style={{ color: "var(--dim)", fontStyle: "italic" }}>
                      No surgery date
                    </span>
                  )}
                  {age && <span>· {age}</span>}
                  <span className={`badge ${statusCls(rec.status)}`}>
                    {statusLabel(rec.status)}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

    </div>
  );
}

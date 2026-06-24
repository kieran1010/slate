// ============================================================
// Charted PWA — FollowUpListScreen.tsx
// ============================================================
// Shows all ACTIVE follow-up records for the current profile,
// sorted by intervention date DESCENDING (most recent first),
// with blank intervention dates at the bottom (repository handles
// the sort; this screen just renders the result).
//
// Each card shows patient name, intervention, intervention date,
// follow-up due date (if set), phone number (if set), and status.
//
// FILE LOCATION:
//   src/screens/FollowUpListScreen.tsx
// ============================================================

import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Bell, Phone, FileUp } from "lucide-react";
import { listActiveFollowUp, listPatients } from "../data/repository";
import { useConfig } from "../hooks/useConfig";
import { formatDateTime } from "../utils/format";
import type { RecordStatus } from "../data/models";
import type { NavigateFn } from "../types/nav";

interface FollowUpListScreenProps {
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

export function FollowUpListScreen({ navigate }: FollowUpListScreenProps) {
  const config = useConfig();
  const aiReady = config.aiEnabled && !!config.anthropicApiKey;
  const rows = useLiveQuery(async () => {
    const [records, patients] = await Promise.all([
      listActiveFollowUp(),
      listPatients(),
    ]);
    const byNhi = new Map(patients.map((p) => [p.nhi, p]));
    return records.map((rec) => ({ rec, patient: byNhi.get(rec.nhi) }));
  }, []);

  if (rows === undefined) {
    return <div className="loading-screen">Loading follow-ups…</div>;
  }

  return (
    <div>
      <div className="list-header">
        <h1 className="list-header-title">Follow-up</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {aiReady && (
            <button
              className="btn-import"
              onClick={() => navigate({ tab: "follow-up", view: "import" })}
              aria-label="Import follow-up from document"
            >
              <FileUp size={15} aria-hidden />
              Import
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => navigate({ tab: "follow-up", view: "detail", id: "new" })}
            aria-label="New follow-up"
          >
            <Plus size={16} aria-hidden />
            New
          </button>
        </div>
      </div>

      {rows.length === 0 && (
        <div className="empty-state">
          <Bell size={36} color="var(--dim)" aria-hidden />
          <p className="empty-state-title">No active follow-ups</p>
          <p>
            Follow-ups appear here when a patient is moved from Acute or
            Pre-assessment, or tap <strong>New</strong> to add one directly.
          </p>
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map(({ rec, patient }) => {
          const name = patient
            ? `${patient.surname}, ${patient.givenName}`
            : rec.nhi;

          return (
            <li key={rec.id}>
              <div
                className="patient-card"
                role="button"
                tabIndex={0}
                aria-label={`${name} — ${rec.intervention || "No intervention entered"}`}
                onClick={() =>
                  navigate({ tab: "follow-up", view: "detail", id: rec.id! })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    navigate({ tab: "follow-up", view: "detail", id: rec.id! });
                }}
              >
                <div className="patient-card-top">
                  <span className="patient-card-name">{name}</span>
                  <span className="patient-card-nhi">{rec.nhi}</span>
                </div>

                {rec.intervention && (
                  <div className="patient-card-task">{rec.intervention}</div>
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
                  {rec.interventionDate ? (
                    <span>{formatDateTime(rec.interventionDate)}</span>
                  ) : (
                    <span style={{ color: "var(--dim)", fontStyle: "italic" }}>
                      No intervention date
                    </span>
                  )}

                  {rec.followUpDue && (
                    <span style={{ color: "var(--muted)" }}>
                      · Follow-up {formatDateTime(rec.followUpDue)}
                    </span>
                  )}

                  {rec.phoneNumber && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "3px",
                        color: "var(--muted)",
                      }}
                    >
                      <Phone size={11} aria-hidden />
                      {rec.phoneNumber}
                    </span>
                  )}

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

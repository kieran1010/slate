// ============================================================
// Charted PWA — AcuteListScreen.tsx
// ============================================================
// Shows all ACTIVE acute referrals for the current profile,
// sorted by urgency (Emergency → Urgent → Routine) then by
// oldest-waiting-first within an urgency level. That sort is
// applied in the repository; this screen just renders the result.
//
// Each row shows the patient name (if known), NHI, urgency badge,
// location, and task to complete. Tapping a row opens the detail
// screen; the + button opens a new blank referral.
//
// Data is loaded with useLiveQuery, which re-renders this
// component automatically whenever the underlying IndexedDB
// tables change — no manual refresh needed.
//
// FILE LOCATION:
//   src/screens/AcuteListScreen.tsx
// ============================================================

import { useLiveQuery } from "dexie-react-hooks";
import { Plus, AlertCircle, FileUp } from "lucide-react";
import { listActiveAcute, listPatients } from "../data/repository";
import { useConfig } from "../hooks/useConfig";
import type { Urgency, RecordStatus } from "../data/models";
import type { NavigateFn } from "../types/nav";

interface AcuteListScreenProps {
  navigate: NavigateFn;
}

// ── Badge helpers ─────────────────────────────────────────────
// Converts the stored enum string to the CSS class and the
// human-readable label defined in models.ts, kept local to this
// file so there's no cross-screen coupling yet.

function urgencyCls(u: Urgency): string {
  return { EMERGENCY: "badge-emergency", URGENT: "badge-urgent", ROUTINE: "badge-routine" }[u];
}

function urgencyLabel(u: Urgency): string {
  return { EMERGENCY: "Emergency", URGENT: "Urgent", ROUTINE: "Routine" }[u];
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

// ── Component ─────────────────────────────────────────────────

export function AcuteListScreen({ navigate }: AcuteListScreenProps) {
  const config = useConfig();
  const aiReady = config.aiEnabled && !!config.anthropicApiKey;
  // Single live query that joins records + patients so each row
  // has both clinical and identity data. Re-runs automatically
  // when either table changes.
  const rows = useLiveQuery(async () => {
    const [records, patients] = await Promise.all([
      listActiveAcute(),
      listPatients(),
    ]);
    const byNhi = new Map(patients.map((p) => [p.nhi, p]));
    return records.map((rec) => ({ rec, patient: byNhi.get(rec.nhi) }));
  }, []);

  // useLiveQuery returns undefined while the first query is in
  // flight; treat it as loading rather than empty.
  if (rows === undefined) {
    return (
      <div className="loading-screen" aria-live="polite">
        Loading referrals…
      </div>
    );
  }

  return (
    <div>
      {/* ── Header ─────────────────────────────────────── */}
      <div className="list-header">
        <h1 className="list-header-title">Acute referrals</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {aiReady && (
            // TODO (next step): navigate to import flow instead of alert
            <button
              className="btn-import"
              onClick={() => navigate({ tab: "acute", view: "import" })}
              aria-label="Import acute referral from document"
            >
              <FileUp size={15} aria-hidden />
              Import
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => navigate({ tab: "acute", view: "detail", id: "new" })}
            aria-label="New acute referral"
          >
            <Plus size={16} aria-hidden />
            New
          </button>
        </div>
      </div>

      {/* ── Empty state ─────────────────────────────────── */}
      {rows.length === 0 && (
        <div className="empty-state">
          <AlertCircle size={36} color="var(--dim)" aria-hidden />
          <p className="empty-state-title">No active referrals</p>
          <p>Tap <strong>New</strong> to add a referral.</p>
        </div>
      )}

      {/* ── Record list ─────────────────────────────────── */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map(({ rec, patient }) => {
          // Display name: "Surname, Given" if known, else the NHI.
          const name = patient
            ? `${patient.surname}, ${patient.givenName}`
            : rec.nhi;

          return (
            <li key={rec.id}>
              <div
                className="patient-card"
                role="button"
                tabIndex={0}
                aria-label={`${name} — ${urgencyLabel(rec.urgency)}`}
                onClick={() =>
                  navigate({ tab: "acute", view: "detail", id: rec.id! })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    navigate({ tab: "acute", view: "detail", id: rec.id! });
                  }
                }}
              >
                {/* Row top: name | NHI */}
                <div className="patient-card-top">
                  <span className="patient-card-name">{name}</span>
                  <span className="patient-card-nhi">{rec.nhi}</span>
                </div>

                {/* Task to complete (the most actionable field) */}
                {rec.taskToComplete && (
                  <div className="patient-card-task">{rec.taskToComplete}</div>
                )}

                {/* Meta: location + urgency + status badges */}
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
                  {rec.location && (
                    <span style={{ color: "var(--muted)" }}>{rec.location}</span>
                  )}
                  <span className={`badge ${urgencyCls(rec.urgency)}`}>
                    {urgencyLabel(rec.urgency)}
                  </span>
                  <span className={`badge ${statusCls(rec.status)}`}>
                    {statusLabel(rec.status)}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Archive link — always visible so archived records are findable
          even when the active list is empty */}
      <div className="archive-link-row">
        <button
          className="archive-link"
          onClick={() => navigate({ tab: "acute", view: "archive" })}
        >
          View archived referrals →
        </button>
      </div>
    </div>
  );
}

// Charted PWA — FollowUpListScreen.tsx
// Search: client-side filter over loaded rows (name, NHI, intervention).

import { useState, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Bell, Phone, FileUp, Search, X } from "lucide-react";
import { listActiveFollowUp, listPatients } from "../data/repository";
import { useConfig } from "../hooks/useConfig";
import { formatDateTime } from "../utils/format";
import type { RecordStatus } from "../data/models";
import type { NavigateFn } from "../types/nav";

interface FollowUpListScreenProps { navigate: NavigateFn; }

function statusCls(s: RecordStatus): string {
  return { PENDING: "badge-pending", IN_PROGRESS: "badge-in-progress", COMPLETE: "badge-complete", NEEDS_REVIEW: "badge-needs-review" }[s];
}
function statusLabel(s: RecordStatus): string {
  return { PENDING: "Pending", IN_PROGRESS: "In progress", COMPLETE: "Complete", NEEDS_REVIEW: "Needs review" }[s];
}

export function FollowUpListScreen({ navigate }: FollowUpListScreenProps) {
  const config = useConfig();
  const aiReady = config.aiEnabled && !!config.anthropicApiKey;
  const [search, setSearch] = useState("");

  const rows = useLiveQuery(async () => {
    const [records, patients] = await Promise.all([listActiveFollowUp(), listPatients()]);
    const byNhi = new Map(patients.map((p) => [p.nhi, p]));
    return records.map((rec) => ({ rec, patient: byNhi.get(rec.nhi) }));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return rows;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ rec, patient }) => {
      const name = patient ? `${patient.surname} ${patient.givenName}`.toLowerCase() : "";
      return (
        name.includes(q) ||
        rec.nhi.toLowerCase().includes(q) ||
        (rec.intervention ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, search]);

  if (rows === undefined) {
    return <div className="loading-screen">Loading follow-ups…</div>;
  }

  return (
    <div>
      <div className="list-header">
        <h1 className="list-header-title">Follow-up</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {aiReady && (
            <button className="btn-import" onClick={() => navigate({ tab: "follow-up", view: "import" })} aria-label="Import follow-up from document">
              <FileUp size={15} aria-hidden />Import
            </button>
          )}
          <button className="btn btn-primary" onClick={() => navigate({ tab: "follow-up", view: "detail", id: "new" })} aria-label="New follow-up">
            <Plus size={16} aria-hidden />New
          </button>
        </div>
      </div>

      <div className="search-bar">
        <Search size={16} color="var(--dim)" aria-hidden />
        <input className="search-bar-input" type="search" placeholder="Search name, NHI, intervention…"
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search follow-ups" />
        {search && (
          <button className="search-bar-clear" onClick={() => setSearch("")} aria-label="Clear search">
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      {filtered!.length === 0 && (
        <div className="empty-state">
          <Bell size={36} color="var(--dim)" aria-hidden />
          <p className="empty-state-title">{search ? "No matching follow-ups" : "No active follow-ups"}</p>
          <p>
            {search
              ? "Try a different search term, or clear the search."
              : <span>Follow-ups appear here when a patient is moved from Acute or Pre-assessment, or tap <strong>New</strong> to add one directly.</span>}
          </p>
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {filtered!.map(({ rec, patient }) => {
          const name = patient ? `${patient.surname}, ${patient.givenName}` : rec.nhi;
          return (
            <li key={rec.id}>
              <div className="patient-card" role="button" tabIndex={0}
                aria-label={`${name} — ${rec.intervention || "No intervention entered"}`}
                onClick={() => navigate({ tab: "follow-up", view: "detail", id: rec.id! })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") navigate({ tab: "follow-up", view: "detail", id: rec.id! }); }}>
                <div className="patient-card-top">
                  <span className="patient-card-name">{name}</span>
                  <span className="patient-card-nhi">{rec.nhi}</span>
                </div>
                {rec.intervention && <div className="patient-card-task">{rec.intervention}</div>}
                <div className="patient-card-meta" style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
                  {rec.interventionDate
                    ? <span>{formatDateTime(rec.interventionDate)}</span>
                    : <span style={{ color: "var(--dim)", fontStyle: "italic" }}>No intervention date</span>}
                  {rec.followUpDue && (
                    <span style={{ color: "var(--muted)" }}>· Follow-up {formatDateTime(rec.followUpDue)}</span>
                  )}
                  {rec.phoneNumber && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--muted)" }}>
                      <Phone size={11} aria-hidden />{rec.phoneNumber}
                    </span>
                  )}
                  <span className={`badge ${statusCls(rec.status)}`}>{statusLabel(rec.status)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

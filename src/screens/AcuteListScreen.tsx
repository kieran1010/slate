// Charted PWA — AcuteListScreen.tsx
// Search: client-side filter over loaded rows (name, NHI, task, location).

import { useState, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, AlertCircle, FileUp, Search, X } from "lucide-react";
import { listActiveAcute, listPatients } from "../data/repository";
import { useConfig } from "../hooks/useConfig";
import type { Urgency, RecordStatus } from "../data/models";
import type { NavigateFn } from "../types/nav";

interface AcuteListScreenProps { navigate: NavigateFn; }

function urgencyCls(u: Urgency): string {
  return { EMERGENCY: "badge-emergency", URGENT: "badge-urgent", ROUTINE: "badge-routine" }[u];
}
function urgencyLabel(u: Urgency): string {
  return { EMERGENCY: "Emergency", URGENT: "Urgent", ROUTINE: "Routine" }[u];
}
function statusCls(s: RecordStatus): string {
  return { PENDING: "badge-pending", IN_PROGRESS: "badge-in-progress", COMPLETE: "badge-complete", NEEDS_REVIEW: "badge-needs-review" }[s];
}
function statusLabel(s: RecordStatus): string {
  return { PENDING: "Pending", IN_PROGRESS: "In progress", COMPLETE: "Complete", NEEDS_REVIEW: "Needs review" }[s];
}

export function AcuteListScreen({ navigate }: AcuteListScreenProps) {
  const config = useConfig();
  const aiReady = config.aiEnabled && !!config.anthropicApiKey;
  const [search, setSearch] = useState("");

  const rows = useLiveQuery(async () => {
    const [records, patients] = await Promise.all([listActiveAcute(), listPatients()]);
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
        (rec.taskToComplete ?? "").toLowerCase().includes(q) ||
        (rec.location ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, search]);

  if (rows === undefined) {
    return <div className="loading-screen" aria-live="polite">Loading referrals…</div>;
  }

  return (
    <div>
      <div className="list-header">
        <h1 className="list-header-title">Acute referrals</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {aiReady && (
            <button className="btn-import" onClick={() => navigate({ tab: "acute", view: "import" })} aria-label="Import acute referral from document">
              <FileUp size={15} aria-hidden />Import
            </button>
          )}
          <button className="btn btn-primary" onClick={() => navigate({ tab: "acute", view: "detail", id: "new" })} aria-label="New acute referral">
            <Plus size={16} aria-hidden />New
          </button>
        </div>
      </div>

      <div className="search-bar">
        <Search size={16} color="var(--dim)" aria-hidden />
        <input className="search-bar-input" type="search" placeholder="Search name, NHI, task, location…"
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search acute referrals" />
        {search && (
          <button className="search-bar-clear" onClick={() => setSearch("")} aria-label="Clear search">
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      {filtered!.length === 0 && (
        <div className="empty-state">
          <AlertCircle size={36} color="var(--dim)" aria-hidden />
          <p className="empty-state-title">{search ? "No matching referrals" : "No active referrals"}</p>
          <p>{search ? "Try a different search term, or clear the search." : <span>Tap <strong>New</strong> to add a referral.</span>}</p>
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {filtered!.map(({ rec, patient }) => {
          const name = patient ? `${patient.surname}, ${patient.givenName}` : rec.nhi;
          return (
            <li key={rec.id}>
              <div className="patient-card" role="button" tabIndex={0}
                aria-label={`${name} — ${urgencyLabel(rec.urgency)}`}
                onClick={() => navigate({ tab: "acute", view: "detail", id: rec.id! })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") navigate({ tab: "acute", view: "detail", id: rec.id! }); }}>
                <div className="patient-card-top">
                  <span className="patient-card-name">{name}</span>
                  <span className="patient-card-nhi">{rec.nhi}</span>
                </div>
                {rec.taskToComplete && <div className="patient-card-task">{rec.taskToComplete}</div>}
                <div className="patient-card-meta" style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
                  {rec.location && <span style={{ color: "var(--muted)" }}>{rec.location}</span>}
                  <span className={`badge ${urgencyCls(rec.urgency)}`}>{urgencyLabel(rec.urgency)}</span>
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

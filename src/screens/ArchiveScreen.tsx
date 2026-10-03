// ============================================================
// Charted PWA — ArchiveScreen.tsx
// ============================================================
// A unified view of ALL archived records across all three
// modules. Two modes:
//
//   BROWSE  — no search text; shows all archived records,
//             most-recently-archived first.
//
//   SEARCH  — free text across every field of the archived
//             records (NHI, name, DOB, procedure, notes, location,
//             medications, status, module…), all three modules at
//             once — see utils/archiveSearch.ts. Searching an NHI
//             still shows which modules that patient has records
//             in, so the user can restore the one they want.
//
// RESTORE: tapping "Restore" on a card un-archives that record
// (flips archived = 0) via restoreRecord(). The card disappears
// from the archive list automatically because useLiveQuery
// re-runs. No other records are affected.
//
// FILE LOCATION:
//   src/screens/ArchiveScreen.tsx
// ============================================================

import { useState, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Search, X, Archive } from "lucide-react";
import {
  listArchived,
  restoreRecord,
  listPatients,
} from "../data/repository";
import { formatDateTime } from "../utils/format";
import { matchesArchiveSearch } from "../utils/archiveSearch";
import type { ArchivedItem } from "../data/repository";

// The single most useful clinical field per module — shown as the
// italic teal summary line on each card.
function getSummary(item: ArchivedItem): string {
  switch (item.module) {
    case "ACUTE":
      return item.record.taskToComplete || item.record.location || "";
    case "PRE_ASSESSMENT":
      return item.record.procedure || "";
    case "FOLLOW_UP":
      return item.record.intervention || "";
  }
}

const MODULE_LABEL: Record<ArchivedItem["module"], string> = {
  ACUTE: "Acute",
  PRE_ASSESSMENT: "Pre-assess",
  FOLLOW_UP: "Follow-up",
};

const MODULE_BADGE_CLS: Record<ArchivedItem["module"], string> = {
  ACUTE: "badge-mod-acute",
  PRE_ASSESSMENT: "badge-mod-pre-assess",
  FOLLOW_UP: "badge-mod-follow-up",
};

// ── Component ─────────────────────────────────────────────────

// ArchiveScreen takes no props — it is a top-level tab accessed
// via the bottom nav, so there is no "back" destination.
export function ArchiveScreen() {
  const [search, setSearch] = useState("");

  // All archived records, live. Search filters this in memory — archive
  // volumes are small, and it lets the search look at every field.
  const all = useLiveQuery(async () => {
    const [items, patients] = await Promise.all([listArchived(), listPatients()]);
    const byNhi = new Map(patients.map((p) => [p.nhi, p]));
    return items.map((item) => ({
      item,
      patient: byNhi.get(item.record.nhi),
    }));
  }, []);

  const rows = useMemo(
    () => all?.filter(({ item, patient }) => matchesArchiveSearch(item, patient, search)),
    [all, search]
  );

  // ── Restore ────────────────────────────────────────────────
  async function handleRestore(item: ArchivedItem) {
    const label = MODULE_LABEL[item.module].toLowerCase();
    const summary = getSummary(item);
    const desc = summary ? `"${summary}"` : `this ${label}`;

    if (
      !confirm(
        `Restore ${desc} to the active ${label} list?\n\nThis will make it visible again and can be undone by archiving it again.`
      )
    )
      return;

    await restoreRecord(item.module, item.record.id!);
    // useLiveQuery re-runs automatically — no manual refresh needed.
  }

  // ── Render ─────────────────────────────────────────────────
  const isSearching = search.trim().length > 0;
  const isLoading = rows === undefined;
  const isEmpty = !isLoading && rows.length === 0;

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="screen-header">
        <h1 className="screen-header-title">Archive</h1>
      </div>

      {/* ── Search bar ─────────────────────────────────── */}
      <div style={{ paddingTop: 12 }}>
        <div className="search-bar">
          <Search size={16} color="var(--dim)" aria-hidden />
          <input
            className="search-bar-input"
            type="text"
            placeholder="Search name, NHI, procedure, notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off"
            spellCheck={false}
            aria-label="Search archived records"
          />
          {search && (
            <button
              className="search-bar-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <X size={15} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* ── Section label ──────────────────────────────────── */}
      <div style={{ padding: "0 16px 10px" }}>
        <span className="eyebrow">
          {isSearching
            ? `Results for “${search.trim()}”`
            : "All archived records"}
        </span>
      </div>

      {/* ── Loading ────────────────────────────────────────── */}
      {isLoading && (
        <div className="loading-screen">Loading archive…</div>
      )}

      {/* ── Empty state ────────────────────────────────────── */}
      {isEmpty && (
        <div className="empty-state">
          <Archive size={36} color="var(--dim)" aria-hidden />
          <p className="empty-state-title">
            {isSearching ? "No matching archived records" : "Archive is empty"}
          </p>
          <p>
            {isSearching
              ? "Try different words, or clear the search to browse all archived records."
              : "Records appear here after they are archived from the Acute, Pre-assessment, or Follow-up screens."}
          </p>
        </div>
      )}

      {/* ── Archive list ───────────────────────────────────── */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows?.map(({ item, patient }, idx) => {
          const name = patient
            ? `${patient.surname}, ${patient.givenName}`
            : item.record.nhi;
          const summary = getSummary(item);
          const archivedAt = item.record.archivedAt
            ? formatDateTime(item.record.archivedAt)
            : null;

          return (
            <li key={`${item.module}-${item.record.id ?? idx}`}>
              <div className="archive-card">
                <div className="archive-card-top">
                  <div className="archive-card-identity">
                    {/* Module badge */}
                    <div style={{ marginBottom: 4 }}>
                      <span
                        className={`badge-mod ${MODULE_BADGE_CLS[item.module]}`}
                      >
                        {MODULE_LABEL[item.module]}
                      </span>
                    </div>
                    <span className="archive-card-name">{name}</span>
                    <span className="archive-card-nhi">{item.record.nhi}</span>
                  </div>
                  <button
                    className="btn-restore"
                    onClick={() => handleRestore(item)}
                    aria-label={`Restore ${MODULE_LABEL[item.module]} record for ${name}`}
                  >
                    Restore
                  </button>
                </div>

                {summary && (
                  <div className="archive-card-summary">{summary}</div>
                )}

                {archivedAt && (
                  <div className="archive-card-meta">
                    Archived {archivedAt}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

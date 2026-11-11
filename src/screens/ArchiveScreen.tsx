// ============================================================
// Charted PWA — ArchiveScreen.tsx
// ============================================================
// A unified view of ALL archived records across all three
// modules. Two modes:
//
//   BROWSE  — no search text; shows all archived records,
//             most-recently-archived first by default.
//
//   SEARCH  — free text across every field of the archived
//             records (NHI, name, DOB, procedure, notes, location,
//             medications, status, module…), all three modules at
//             once — see utils/archiveSearch.ts. Searching an NHI
//             still shows which modules that patient has records
//             in, so the user can restore the one they want.
//
// FILTER & SORT: a row of chips limits the list to one record type
// (Pre-assess / Acute / Follow-up), and a sort menu orders it by
// archive date, date added, date of surgery, name or NHI, with a
// button to flip the direction. Both apply on top of any search.
// Records with no value for the chosen date (e.g. Acute records have
// no date of surgery) always go to the end, whichever direction.
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
import { Search, X, Archive, ArrowDown, ArrowUp } from "lucide-react";
import {
  listArchived,
  restoreRecord,
  listPatients,
} from "../data/repository";
import { formatDateTime, formatDate, capitalCase } from "../utils/format";
import { matchesArchiveSearch } from "../utils/archiveSearch";
import type { ArchivedItem } from "../data/repository";
import type { Patient } from "../data/models";

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

// ── Filter & sort ─────────────────────────────────────────────

type ModuleFilter = "ALL" | ArchivedItem["module"];

const FILTERS: { value: ModuleFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PRE_ASSESSMENT", label: "Pre-assess" },
  { value: "ACUTE", label: "Acute" },
  { value: "FOLLOW_UP", label: "Follow-up" },
];

type SortKey = "archived" | "created" | "surgery" | "name" | "nhi";

// Each key's natural direction: newest first for dates, A–Z for text.
const SORTS: { value: SortKey; label: string; defaultDesc: boolean }[] = [
  { value: "archived", label: "Archive date", defaultDesc: true },
  { value: "created", label: "Date added", defaultDesc: true },
  { value: "surgery", label: "Date of surgery", defaultDesc: true },
  { value: "name", label: "Name", defaultDesc: false },
  { value: "nhi", label: "NHI", defaultDesc: false },
];

interface Row {
  item: ArchivedItem;
  patient: Patient | undefined;
}

function surgeryDate(item: ArchivedItem): string {
  return item.module === "PRE_ASSESSMENT" ? item.record.dateOfSurgery : "";
}

function nameKey({ patient }: Row): string {
  return patient
    ? `${patient.surname}\u0000${patient.givenName}`.toLocaleLowerCase()
    : "";
}

function sortValue(row: Row, key: SortKey): string {
  switch (key) {
    case "archived": return row.item.record.archivedAt || "";
    case "created":  return row.item.record.createdAt || "";
    case "surgery":  return surgeryDate(row.item);
    case "name":     return nameKey(row);
    case "nhi":      return row.item.record.nhi.toUpperCase();
  }
}

function sortRows(rows: Row[], key: SortKey, desc: boolean): Row[] {
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    // Blanks last regardless of direction.
    if (!va !== !vb) return va ? -1 : 1;
    const c = va.localeCompare(vb);
    if (c !== 0) return desc ? -c : c;
    // Ties: most recently archived first.
    return (b.item.record.archivedAt || "").localeCompare(a.item.record.archivedAt || "");
  });
}

// ── Component ─────────────────────────────────────────────────

// ArchiveScreen takes no props — it is a top-level tab accessed
// via the bottom nav, so there is no "back" destination.
export function ArchiveScreen() {
  const [search, setSearch] = useState("");
  const [moduleFilter, setModuleFilter] = useState<ModuleFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("archived");
  const [sortDesc, setSortDesc] = useState(true);

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

  const rows = useMemo(() => {
    if (!all) return undefined;
    const filtered = all.filter(
      ({ item, patient }) =>
        (moduleFilter === "ALL" || item.module === moduleFilter) &&
        matchesArchiveSearch(item, patient, search)
    );
    return sortRows(filtered, sortKey, sortDesc);
  }, [all, search, moduleFilter, sortKey, sortDesc]);

  function changeSort(key: SortKey) {
    setSortKey(key);
    setSortDesc(SORTS.find((o) => o.value === key)!.defaultDesc);
  }

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
  const isFiltered = moduleFilter !== "ALL";
  const isDateSort = sortKey === "archived" || sortKey === "created" || sortKey === "surgery";
  const dirLabel = isDateSort
    ? (sortDesc ? "Newest first" : "Oldest first")
    : (sortDesc ? "Z to A" : "A to Z");
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

      {/* ── Type filter ────────────────────────────────── */}
      <div className="archive-filters" role="group" aria-label="Filter by record type">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`filter-chip${moduleFilter === f.value ? " active" : ""}`}
            aria-pressed={moduleFilter === f.value}
            onClick={() => setModuleFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Section label + sort ───────────────────────────── */}
      <div className="archive-toolbar">
        <span className="eyebrow archive-toolbar-label">
          {isSearching
            ? `Results for “${search.trim()}”`
            : isFiltered
              ? `Archived ${FILTERS.find((f) => f.value === moduleFilter)!.label.toLowerCase()} records`
              : "All archived records"}
        </span>
        <label className="archive-sort">
          <span className="visually-hidden">Sort by</span>
          <select
            className="archive-sort-select"
            value={sortKey}
            onChange={(e) => changeSort(e.target.value as SortKey)}
            aria-label="Sort by"
          >
            {SORTS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="archive-sort-dir"
          onClick={() => setSortDesc((d) => !d)}
          aria-label={`Sort direction: ${dirLabel}. Tap to reverse.`}
          title={dirLabel}
        >
          {sortDesc ? <ArrowDown size={15} aria-hidden /> : <ArrowUp size={15} aria-hidden />}
        </button>
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
            {isSearching || isFiltered ? "No matching archived records" : "Archive is empty"}
          </p>
          <p>
            {isSearching
              ? "Try different words, or clear the search to browse all archived records."
              : isFiltered
                ? "There are no archived records of this type. Choose All to see every archived record."
                : "Records appear here after they are archived from the Acute, Pre-assessment, or Follow-up screens."}
          </p>
        </div>
      )}

      {/* ── Archive list ───────────────────────────────────── */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows?.map(({ item, patient }, idx) => {
          const name = patient
            ? `${capitalCase(patient.surname)}, ${capitalCase(patient.givenName)}`
            : item.record.nhi;
          const summary = getSummary(item);
          const archivedAt = item.record.archivedAt
            ? formatDateTime(item.record.archivedAt)
            : null;
          // Show the date being sorted on, when it isn't the archive date.
          const extra =
            sortKey === "created" && item.record.createdAt
              ? `Added ${formatDate(item.record.createdAt)}`
              : sortKey === "surgery" && surgeryDate(item)
                ? `Surgery ${formatDateTime(surgeryDate(item))}`
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

                {(archivedAt || extra) && (
                  <div className="archive-card-meta">
                    {[archivedAt && `Archived ${archivedAt}`, extra].filter(Boolean).join(" · ")}
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

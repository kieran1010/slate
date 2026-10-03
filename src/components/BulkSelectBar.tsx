// ============================================================
// Slate — components/BulkSelectBar.tsx
// ============================================================
// Sticky action bar shown at the bottom of a list while selecting.
//
// FILE LOCATION:
//   src/components/BulkSelectBar.tsx
// ============================================================

import { Archive } from "lucide-react";

interface BulkSelectBarProps {
  count: number;
  allSelected: boolean;
  busy: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onArchive: () => void;
}

export function BulkSelectBar({ count, allSelected, busy, onSelectAll, onClearSelection, onArchive }: BulkSelectBarProps) {
  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <button className="btn btn-ghost" onClick={allSelected ? onClearSelection : onSelectAll} disabled={busy}>
        {allSelected ? "Select none" : "Select all"}
      </button>
      <span className="bulk-bar-count" aria-live="polite">{count} selected</span>
      <button className="btn btn-primary" onClick={onArchive} disabled={busy || count === 0}>
        <Archive size={14} aria-hidden />{busy ? "Archiving…" : "Archive"}
      </button>
    </div>
  );
}

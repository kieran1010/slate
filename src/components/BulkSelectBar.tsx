// ============================================================
// Slate — components/BulkSelectBar.tsx
// ============================================================
// Sticky action bar shown at the bottom of a list while selecting.
//
// FILE LOCATION:
//   src/components/BulkSelectBar.tsx
// ============================================================

import { useState } from "react";
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
  // Asking "are you sure" is tied to the current count, so changing the
  // selection while it's showing quietly drops back to the normal bar.
  const [confirmFor, setConfirmFor] = useState<number | null>(null);

  if (confirmFor === count && count > 0) {
    return (
      <div className="bulk-bar" role="alertdialog" aria-label="Confirm archive">
        <span className="bulk-bar-count" style={{ color: "var(--text)" }}>
          Archive {count} {count === 1 ? "record" : "records"}?
        </span>
        <span style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-secondary" onClick={() => setConfirmFor(null)} disabled={busy}>No</button>
          <button className="btn btn-primary" onClick={onArchive} disabled={busy}>
            <Archive size={14} aria-hidden />{busy ? "Archiving…" : "Yes, archive"}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <button className="btn btn-ghost" onClick={allSelected ? onClearSelection : onSelectAll} disabled={busy}>
        {allSelected ? "Select none" : "Select all"}
      </button>
      <span className="bulk-bar-count" aria-live="polite">{count} selected</span>
      <button className="btn btn-primary" onClick={() => setConfirmFor(count)} disabled={busy || count === 0}>
        <Archive size={14} aria-hidden />Archive
      </button>
    </div>
  );
}

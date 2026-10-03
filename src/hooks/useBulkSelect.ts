// ============================================================
// Slate — hooks/useBulkSelect.ts
// ============================================================
// Multi-select state for the list screens. `visibleIds` is what the
// list currently shows (after search), so a selection never acts on
// records hidden by a search filter.
//
// FILE LOCATION:
//   src/hooks/useBulkSelect.ts
// ============================================================

import { useState, useCallback } from "react";

export function useBulkSelect(visibleIds: number[]) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const selectedIds = visibleIds.filter((id) => selected.has(id));

  const start = useCallback(() => { setSelected(new Set()); setActive(true); }, []);
  const cancel = useCallback(() => { setActive(false); setSelected(new Set()); }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const toggle = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => setSelected(new Set(visibleIds)), [visibleIds]);

  return {
    active, selectedIds, start, cancel, clear, toggle, selectAll,
    isSelected: (id: number) => selected.has(id),
    allSelected: visibleIds.length > 0 && selectedIds.length === visibleIds.length,
  };
}

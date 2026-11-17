// ============================================================
// Slate — components/UncertainBanner.tsx
// ============================================================
// Amber notice at the top of a record while any of its fields still
// holds an AI import's "[UNCERTAIN]" tag. AI import goes straight to
// the new record, so this is where the clinician learns which values
// the model wasn't sure of. It disappears once every tag is removed.
//
// The tag is matched case-insensitively: names are stored in Capital
// Case, which turns "[UNCERTAIN]" into "[uncertain]".
//
// FILE LOCATION:
//   src/components/UncertainBanner.tsx
// ============================================================

import { AlertTriangle } from "lucide-react";

const TAG = /\[UNCERTAIN\]/i;

export interface UncertainField {
  label: string;
  value: string | undefined;
}

export function UncertainBanner({ fields }: { fields: UncertainField[] }) {
  const flagged = fields.filter((f) => !!f.value && TAG.test(f.value)).map((f) => f.label);
  if (flagged.length === 0) return null;
  return (
    <div className="ai-warning" style={{ margin: 0 }} role="status">
      <p className="ai-warning-title">
        <AlertTriangle size={16} aria-hidden />
        {flagged.length === 1 ? "1 field needs checking" : `${flagged.length} fields need checking`}
      </p>
      <p>
        AI import wasn't sure of: <strong>{flagged.join(", ")}</strong>. These are marked{" "}
        <strong>[UNCERTAIN]</strong>. Check each one against the source, correct it if needed, and delete
        the tag.
      </p>
    </div>
  );
}

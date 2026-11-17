// ============================================================
// Slate — utils/uncertain.ts
// ============================================================
// AI import prefixes values it isn't sure of with "[UNCERTAIN] ".
// Matched case-insensitively: names are stored in Capital Case,
// which turns the tag into "[uncertain]".
//
// FILE LOCATION:
//   src/utils/uncertain.ts
// ============================================================

/** True when a value still carries AI import's [UNCERTAIN] tag. */
export function hasUncertainTag(value: unknown): value is string {
  return typeof value === "string" && /\[UNCERTAIN\]/i.test(value);
}

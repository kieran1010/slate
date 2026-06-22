// ============================================================
// Charted PWA — utils/format.ts
// ============================================================
// Display-formatting helpers. These turn stored ISO strings
// ("YYYY-MM-DDThh:mm") into human-readable text for list rows
// and detail screens. They never modify or re-parse for storage
// — that stays in dates.ts.
//
// FILE LOCATION:
//   src/utils/format.ts
// ============================================================

const MONTHS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

// "2026-06-22" → "22 Jun 2026"
export function formatDate(iso: string): string {
  if (!iso) return "";
  const datePart = iso.slice(0, 10);
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// "2026-06-22T07:30" → "22 Jun 2026, 07:30"
// "2026-06-22" (date only) → "22 Jun 2026"
export function formatDateTime(iso: string): string {
  if (!iso) return "";
  const [datePart, timePart] = iso.split("T");
  const date = formatDate(datePart);
  return timePart ? `${date}, ${timePart}` : date;
}

// "2026-06-22" → "22/06/2026"  (NZ clinical convention)
export function formatDateDMY(iso: string): string {
  if (!iso) return "";
  const datePart = iso.slice(0, 10);
  const [y, m, d] = datePart.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

// "2026-06-22T07:30" → "22/06/2026, 07:30"
export function formatDateTimeDMY(iso: string): string {
  if (!iso) return "";
  const [datePart, timePart] = iso.split("T");
  const date = formatDateDMY(datePart);
  return timePart ? `${date}, ${timePart}` : date;
}

// ============================================================
// Charted PWA — dates.ts
// ============================================================
// Helpers for the settled date convention (see the DATE
// CONVENTION note in models.ts): ISO 8601 strings WITHOUT a
// timezone offset, i.e. naive local wall-clock time. These
// strings sort chronologically as plain text.
//
// We deliberately do NOT use Date.toISOString() anywhere for
// clinical fields — that produces UTC with a trailing "Z", which
// is exactly the offset behaviour we're avoiding.
//
// FILE LOCATION:
//   src/data/dates.ts
// ============================================================

// Zero-pad a number to two digits ("9" → "09").
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Current local date+time as "YYYY-MM-DDThh:mm" (minute precision,
// no seconds, no timezone). Used for createdAt / updatedAt /
// archivedAt and any "now" the app records.
export function nowIso(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// Current local date as "YYYY-MM-DD" (no time). Useful for dob-like
// date-only fields.
export function todayIsoDate(): string {
  return nowIso().slice(0, 10);
}

// Add `hours` to a naive ISO datetime string ("YYYY-MM-DDThh:mm") and
// return a new naive ISO string. Used to calculate followUpDue from
// interventionDate + the configured default offset.
// Using new Date() is safe here because strings in "YYYY-MM-DDThh:mm"
// format (no Z, no offset) are parsed as LOCAL time by modern JS engines,
// which is exactly what we want for our naive local-time convention.
export function dateAddHours(iso: string, hours: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  d.setHours(d.getHours() + hours);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

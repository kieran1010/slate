// ============================================================
// Charted PWA — models.ts
// ============================================================
// This is the TypeScript port of the Android app's Models.kt.
// It holds every data shape the app works with: patients,
// the three record types (acute / pre-assessment / follow-up),
// the archive record, and config.
//
// COMING FROM KOTLIN — a few translation notes up front:
//
//   • Kotlin `data class`  → TypeScript `interface`
//     An interface is purely a compile-time description of an
//     object's shape. It produces NO JavaScript at runtime — it
//     vanishes after compilation. Its only job is to make the
//     compiler reject objects with missing/wrong/extra fields.
//
//   • Kotlin `enum class`  → string-literal union type
//     Instead of a true enum, we use a union of fixed strings,
//     e.g. type Urgency = "ROUTINE" | "URGENT" | "EMERGENCY".
//     We deliberately use the SAME UPPERCASE constant names that
//     Kotlin stored via enum.name (see RoomEntities.kt converters),
//     so any data exported to the existing Google Sheet stays
//     byte-for-byte compatible. The compiler still stops you
//     writing "URGNET" anywhere a Urgency is expected.
//
//   • The `... as const` + `typeof X[number]` pattern below gives
//     us BOTH a runtime array (handy for building dropdowns) AND
//     a compile-time type, from a single source of truth. Kotlin
//     enums give you Urgency.values() for free; in TS we build
//     that list ourselves, and this pattern keeps the list and
//     the type from ever drifting apart.
//
// FILE LOCATION (in the new PWA project):
//   src/data/models.ts
//
// DATE CONVENTION (settled):
//   All clinical date/time fields below are stored as ISO 8601
//   strings WITHOUT a timezone offset — i.e. naive local
//   wall-clock time:
//      • date + time  → "YYYY-MM-DDThh:mm"  (e.g. "2026-06-22T14:30")
//      • date only    → "YYYY-MM-DD"        (e.g. dob "1978-03-14")
//   Why no offset: it removes the timezone round-trip bugs seen on
//   Android, and — crucially — ISO strings in this form sort
//   chronologically as plain text, so list ordering needs no date
//   parsing at all. The app treats these as opaque, sortable
//   strings and never reinterprets them, except calculateAge()
//   at the bottom of this file.
// ============================================================

// ============================================================
// ENUMS — fixed sets of allowed values
// ============================================================

// ── Urgency ─────────────────────────────────────────────────
// Urgency levels for acute referrals.
// The array is the single source of truth: the `URGENCIES`
// list is what we iterate over to render a dropdown, and the
// `Urgency` type is derived directly from it.
export const URGENCIES = ["ROUTINE", "URGENT", "EMERGENCY"] as const;

// `typeof URGENCIES[number]` means "the type of any element of
// this array" → "ROUTINE" | "URGENT" | "EMERGENCY".
export type Urgency = (typeof URGENCIES)[number];

// Human-readable label shown in the UI.
// `Record<Urgency, string>` is a TS utility type meaning
// "an object that MUST have exactly one key per Urgency value".
// If you add a new urgency to the array above and forget to add
// a label here, the compiler will complain — the equivalent of
// Kotlin's exhaustive `when`.
export const URGENCY_LABELS: Record<Urgency, string> = {
  ROUTINE: "Routine",
  URGENT: "Urgent",
  EMERGENCY: "Emergency",
};

// ── RecordStatus ────────────────────────────────────────────
// Status values shared across all three modules.
export const RECORD_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "NEEDS_REVIEW",
] as const;

export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const RECORD_STATUS_LABELS: Record<RecordStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  COMPLETE: "Complete",
  NEEDS_REVIEW: "Needs review",
};

// ── OriginModule ────────────────────────────────────────────
// Which module a record originated from. Used to tag the
// move-to-follow-up draft and to label rows in the archive view.
export const ORIGIN_MODULES = [
  "ACUTE",
  "PRE_ASSESSMENT",
  "FOLLOW_UP",
] as const;

export type OriginModule = (typeof ORIGIN_MODULES)[number];

export const ORIGIN_MODULE_LABELS: Record<OriginModule, string> = {
  ACUTE: "Acute",
  PRE_ASSESSMENT: "Pre-assessment",
  FOLLOW_UP: "Follow-up",
};

// ── FollowUpType ────────────────────────────────────────────
// How the follow-up reminder time is specified.
//   AD_HOC   — no follow-up reminder, record keeping only
//   OFFSET   — calculated from intervention time (e.g. +24h)
//   SPECIFIC — user picks an exact date and time
export const FOLLOW_UP_TYPES = ["AD_HOC", "OFFSET", "SPECIFIC"] as const;

export type FollowUpType = (typeof FOLLOW_UP_TYPES)[number];

export const FOLLOW_UP_TYPE_LABELS: Record<FollowUpType, string> = {
  AD_HOC: "Ad hoc",
  OFFSET: "Offset",
  SPECIFIC: "Specific",
};

// ============================================================
// PATIENT — master record
// ============================================================
// The core identity record, shared across all modules.
// Keyed on NHI (NZ National Health Index number).
export interface Patient {
  nhi: string; // NZ NHI — primary key
  surname: string;
  givenName: string;
  dob: string; // date only, ISO "YYYY-MM-DD" (see DATE CONVENTION at top)
}

// In Kotlin, displayName() / shortId() lived ON the data class.
// TS interfaces can't carry methods, so these become small free
// functions that take a Patient. Same behaviour, called as
// displayName(patient) instead of patient.displayName().

// Full name formatted as "Surname, Given".
export function displayName(p: Patient): string {
  return `${p.surname}, ${p.givenName}`;
}

// Short identifier for list views.
export function shortId(p: Patient): string {
  return `${displayName(p)} · ${p.nhi}`;
}

// ============================================================
// ACUTE RECORD
// ============================================================
// A quick referral record. Fast to enter, minimal fields.
// "background" gives context; "taskToComplete" is the action.
export interface AcuteRecord {
  nhi: string;
  location: string; // e.g. "Ward 6B", "ED Bay 3", "Clinic 4"
  background: string; // brief clinical background
  taskToComplete: string; // what needs to be done
  urgency: Urgency;
  status: RecordStatus;
  notes: string;
  // ── lifecycle fields (shared by all three sub-record types) ──
  // archived: 0 = active (shown in lists), 1 = archived (hidden).
  //   Archiving NEVER deletes a record or moves it to another
  //   table — it only flips this flag, so every field is preserved
  //   and "restore" is simply setting it back to 0. It's a number,
  //   not a boolean, because IndexedDB cannot index boolean values;
  //   0/1 lets us query active vs archived efficiently.
  // archivedAt: "" while active; ISO timestamp when archived
  //   (used to order the archive view by most-recently-archived).
  archived: 0 | 1;
  archivedAt: string;
  createdAt: string; // see DATE CONVENTION note at top of file
  updatedAt: string;
}

// ============================================================
// PRE-ASSESSMENT RECORD
// ============================================================
// The comprehensive pre-operative assessment. Most fields are
// free text. Weight/height are strings to allow "not recorded"
// or values like "~80" without type-conversion issues.
export interface PreAssessRecord {
  nhi: string;
  dateOfSurgery: string; // ISO datetime incl. theatre start time: "YYYY-MM-DDThh:mm"
  procedure: string; // planned surgical procedure
  surgeon: string;
  indicationForSurgery: string;
  pastMedicalHistory: string;
  anaestheticHistory: string; // previous anaesthetic issues
  socialHistory: string; // smoking, alcohol, home situation etc.
  functionalStatus: string; // exercise tolerance, ADLs etc.
  investigations: string; // echo, bloods, ECG findings
  medications: string; // current medications
  allergies: string;
  weight: string; // kg — string for flexibility
  height: string; // cm — string for flexibility
  airwayAssessment: string; // Mallampati, mouth opening etc.
  notes: string;
  status: RecordStatus;
  archived: 0 | 1; // see lifecycle note on AcuteRecord above
  archivedAt: string; // "" while active; ISO timestamp when archived
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// FOLLOW-UP RECORD
// ============================================================
// Tracks patients after an intervention (e.g. a nerve block).
// phoneNumber is for calling the patient at follow-up.
// followUpDue is either calculated from interventionDate + offset,
// or set explicitly by the user.
export interface FollowUpRecord {
  nhi: string;
  intervention: string; // what was done, e.g. "ISB nerve block"
  interventionDate: string;
  followUpDue: string;
  followUpType: FollowUpType;
  outcome: string; // recorded at follow-up
  phoneNumber: string; // for calling the patient
  notes: string;
  status: RecordStatus;
  archived: 0 | 1; // see lifecycle note on AcuteRecord above
  archivedAt: string; // "" while active; ISO timestamp when archived
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// (No ArchiveRecord type — by design)
// ============================================================
// Archiving is a soft flag on each sub-record (the `archived` /
// `archivedAt` lifecycle fields above), NOT a separate table.
// A record is archived in place — every field preserved — and
// restored by flipping `archived` back to 0. A separate archive
// shape would only lose data (e.g. a reduced shape couldn't hold
// surgeon / indication / dateOfSurgery), which is exactly the
// problem this design avoids.

// ============================================================
// MOVE-TO-FOLLOW-UP DRAFT
// ============================================================
// The editable draft produced when "moving" an Acute or
// Pre-assessment record into Follow-up. The repository pre-fills
// it (mapping below), the user edits it, and on save the source
// record is archived (flag flipped) and a NEW Follow-up record
// is created — nothing is discarded.
//
// Carry-over mapping (pre-filled, all editable before save):
//   intervention      ← Acute.taskToComplete  OR  PreAssess.procedure
//   interventionDate  ← Acute.createdAt        OR  PreAssess.dateOfSurgery
//   nhi / identity      come from the patient master record
// originModule records which module it came from (ACUTE / PRE_ASSESSMENT).
export interface DischargeToFollowUpRequest {
  nhi: string;
  originModule: OriginModule;
  intervention: string;
  interventionDate: string;
  followUpDue: string;
  followUpType: FollowUpType;
  phoneNumber: string;
  notes: string;
}

// ============================================================
// APP CONFIG
// ============================================================
// The app's settings. On Android this mirrored a Config sheet;
// in the PWA it will live in local storage, per profile.
//
// anthropicApiKey is opt-in (user-supplied), stored locally only
// and never sent to any Hypnos Medical server.
// webhookUrl and googleDocId (old Sheets backend) have been removed.
// Cloud sync and GDocs integration are handled separately.
export interface AppConfig {
  clinicianName: string;
  clinicianRole: string;
  defaultFollowUpHours: number;
  notificationLeadMins: number;
  anthropicApiKey: string;
  // Whether the user has opted into AI features (requires own API key).
  // Stored separately from the key so the key is preserved when AI is
  // temporarily disabled, and the user doesn't have to re-enter it.
  aiEnabled: boolean;
  // Passphrase for AES-256-GCM encrypted backup / restore.
  // Stored in Firestore so it is restored automatically when the user
  // signs in on a new device, allowing import without needing to
  // remember the passphrase. Security note: anyone who gains access to
  // the user's Slate account also gains this passphrase — acceptable
  // because patient data never leaves the device unencrypted.
  encryptionPassphrase: string;
  // GDocs Integration — optional, warning-gated.
  // Stores an encrypted backup in a Google Doc the user owns.
  gdocsEnabled: boolean;
  // ID of the Google Doc used for backup (auto-created on first export
  // if left blank). Stored in Firestore so it is available on any
  // device the user signs into.
  gdocsDocId: string;
}

// Sensible defaults, equivalent to the Kotlin default arguments.
export const DEFAULT_APP_CONFIG: AppConfig = {
  clinicianName: "",
  clinicianRole: "Anaesthetist",
  defaultFollowUpHours: 24,
  notificationLeadMins: 60,
  anthropicApiKey: "",
  aiEnabled: false,
  encryptionPassphrase: "",
  gdocsEnabled: false,
  gdocsDocId: "",
};

// ============================================================
// calculateAge — helper
// ============================================================
// Returns a string like "47 years", or "" if the date can't be
// parsed. Ported from the Kotlin version, which accepted either
// "dd/MM/yyyy" or "yyyy-MM-dd". We avoid any date library and do
// the arithmetic by hand so there are no extra dependencies and
// no timezone surprises (we compare calendar fields, not UTC
// instants).
export function calculateAge(dob: string): string {
  if (!dob || dob.trim() === "") return "";

  // Take only the date portion (first 10 chars), matching the
  // Kotlin `dob.take(10)` — this drops any trailing time component.
  const datePart = dob.trim().slice(0, 10);

  let year: number;
  let month: number; // 1-based here (Jan = 1), as written by humans
  let day: number;

  if (datePart.includes("/")) {
    // "dd/MM/yyyy"
    const [d, m, y] = datePart.split("/");
    day = Number(d);
    month = Number(m);
    year = Number(y);
  } else if (datePart.includes("-")) {
    // "yyyy-MM-dd"
    const [y, m, d] = datePart.split("-");
    year = Number(y);
    month = Number(m);
    day = Number(d);
  } else {
    return "";
  }

  // Guard against non-numeric / malformed input.
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return "";
  }

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1; // getMonth() is 0-based
  const todayDay = now.getDate();

  let age = todayYear - year;

  // If this year's birthday hasn't happened yet, subtract one.
  // Compare month first, then day within the same month.
  if (todayMonth < month || (todayMonth === month && todayDay < day)) {
    age -= 1;
  }

  if (age < 0) return ""; // future date → not meaningful

  return `${age} years`;
}

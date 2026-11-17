// ============================================================
// Slate — components/DateTimeField.tsx
// ============================================================
// A date + time pair that, unlike a native <input type="datetime-local">,
// never forces the user to also pick a time. A native datetime-local
// input's value stays empty until BOTH the date and time are filled in —
// so a user who only sets the date silently loses it entirely.
//
// Here the two are separate inputs. Whenever a date is present but the
// time is left blank, the time defaults to 08:00 — applied immediately
// (not deferred to save) so the combined value is always a complete,
// valid "YYYY-MM-DDThh:mm" string the moment a date is chosen, which
// other logic (e.g. the follow-up OFFSET calculation) can rely on.
//
// A value that isn't a date (e.g. an AI import's "[UNCERTAIN] ..."
// value) can't be shown by the date picker, which would look blank.
// It is shown as text instead, with the tag in red, and the pickers
// come back once it has been corrected to a date (or cleared).
//
// FILE LOCATION:
//   src/components/DateTimeField.tsx
// ============================================================

import { TagInput } from "./UncertainHighlight";

const DEFAULT_TIME = "08:00";
const STORAGE_FORMAT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

interface DateTimeFieldProps {
  id: string;
  // Combined value in storage format: "YYYY-MM-DDThh:mm" or "".
  value: string;
  onChange: (value: string) => void;
}

export function DateTimeField({ id, value, onChange }: DateTimeFieldProps) {
  if (value && !STORAGE_FORMAT.test(value)) {
    return (
      <TagInput
        id={id}
        className="form-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const [datePart, timePart] = value ? value.split("T") : ["", ""];

  function handleDateChange(newDate: string) {
    onChange(newDate ? `${newDate}T${timePart || DEFAULT_TIME}` : "");
  }

  function handleTimeChange(newTime: string) {
    if (!datePart) return; // no date yet — nothing to attach a time to
    onChange(`${datePart}T${newTime || DEFAULT_TIME}`);
  }

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <input
        id={id}
        className="form-input"
        type="date"
        style={{ flex: 1 }}
        value={datePart}
        onChange={(e) => handleDateChange(e.target.value)}
      />
      <input
        className="form-input"
        type="time"
        aria-label="Time"
        style={{ flex: "0 0 110px" }}
        value={timePart}
        disabled={!datePart}
        onChange={(e) => handleTimeChange(e.target.value)}
      />
    </div>
  );
}

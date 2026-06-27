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
// FILE LOCATION:
//   src/components/DateTimeField.tsx
// ============================================================

const DEFAULT_TIME = "08:00";

interface DateTimeFieldProps {
  id: string;
  // Combined value in storage format: "YYYY-MM-DDThh:mm" or "".
  value: string;
  onChange: (value: string) => void;
}

export function DateTimeField({ id, value, onChange }: DateTimeFieldProps) {
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

// ============================================================
// Charted PWA — Brand.tsx
// ============================================================
// The Hypnos Medical brand bar, matching the suite branding.
// A dark navy bar with the crescent-moon mark, the
// "Hypnos / MEDICAL" lockup, a divider, then the individual app
// name. Styling lives in index.css (the .brand* classes).
//
// The app name is passed in as a prop because it's still TBC —
// swap the value where this component is used and nothing else
// needs to change.
//
// FILE LOCATION:
//   src/components/Brand.tsx
// ============================================================

import { Settings, DatabaseBackup } from "lucide-react";

interface BrandProps {
  appName: string;
  // Called when the user taps the gear icon to open Settings.
  onSettingsOpen: () => void;
  // Called when the user taps the backup icon to open Backup.
  onBackupOpen: () => void;
}

export function Brand({ appName, onSettingsOpen, onBackupOpen }: BrandProps) {
  return (
    <header className="brandbar">
      {/* Clicking the lockup opens hypnos.one in a new tab.
          The <a> inherits the .brand-lockup layout styles;
          link-specific overrides (colour, underline) live in
          index.css so they stay out of inline styles. */}
      <a
        href="https://hypnos.one"
        target="_blank"
        rel="noopener noreferrer"
        className="brand-lockup"
        aria-label="Hypnos Medical — visit hypnos.one"
      >
        {/* Feather "moon" crescent — the shared Hypnos mark */}
        <svg
          className="brand-moon"
          width="30"
          height="30"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <div className="brand-names">
          <span className="brand-hypnos">Hypnos</span>
          <span className="brand-medical">Medical</span>
        </div>
      </a>
      <span className="brand-divider" aria-hidden="true" />
      {/* flex:1 pushes the gear icon to the far right */}
      <span className="brand-app">{appName}</span>
      <button
        className="brand-settings-btn"
        onClick={onBackupOpen}
        aria-label="Open backup"
      >
        <DatabaseBackup size={20} aria-hidden />
      </button>
      <button
        className="brand-settings-btn"
        onClick={onSettingsOpen}
        aria-label="Open settings"
      >
        <Settings size={20} aria-hidden />
      </button>
    </header>
  );
}

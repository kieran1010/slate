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
import brandMark from "../assets/brand-mark-transparent.png";

interface BrandProps {
  appName: string;
  // Called when the user taps the gear icon to open Settings.
  onSettingsOpen: () => void;
  // Called when the user taps the backup icon to open Backup.
  onBackupOpen: () => void;
}

export function Brand({ appName, onSettingsOpen, onBackupOpen }: BrandProps) {
  return (
    <header className="app-header">
      <div className="brand">
        {/* Clicking the lockup opens hypnos.one in this same tab.
            The <a> inherits the .brand-link layout styles;
            link-specific overrides (colour, underline) live in
            index.css so they stay out of inline styles. */}
        <a
          href="https://hypnos.one"
          className="brand-link"
          aria-label="Hypnos Medical — visit hypnos.one"
        >
          <img src={brandMark} alt="" className="brand-icon" />
          <div className="brand-text">
            <span className="brand-hypnos">Hypnos</span>
            <span className="brand-medical">MEDICAL</span>
          </div>
        </a>
        <span className="brand-divider" aria-hidden="true" />
        <span className="brand-product">{appName}</span>
      </div>
      {/* margin-left:auto on .header-actions pushes these to the far right */}
      <div className="header-actions">
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
      </div>
    </header>
  );
}

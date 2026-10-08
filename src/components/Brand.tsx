// ============================================================
// Charted PWA — Brand.tsx
// ============================================================
// The Hypnos Medical brand bar, per the Hypnos Medical brand kit.
// A dark navy bar with the brand moon, the
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

import { useSyncExternalStore } from "react";
import { Settings, CloudUpload } from "lucide-react";
import { subscribeDriveSync, getDriveSyncStatus } from "../utils/driveSync";

interface BrandProps {
  appName: string;
  // Called when the user taps the gear icon to open Settings.
  onSettingsOpen: () => void;
}

export function Brand({ appName, onSettingsOpen }: BrandProps) {
  // A silent Drive token refresh can briefly flash Google's page; a small
  // cue while syncing makes that read as something Slate is doing.
  const syncing = useSyncExternalStore(subscribeDriveSync, getDriveSyncStatus).state === "syncing";
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
          {/* Hypnos Medical moon: two-circle construction from the brand kit */}
          <svg className="brand-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12.2 0A12 12 0 1 0 23.96 13.29A9.14 9.14 0 0 1 12.2 0Z" fill="currentColor" />
          </svg>
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
        <span className={`sync-indicator${syncing ? " visible" : ""}`} title="Syncing with Google Drive" aria-hidden>
          <CloudUpload size={16} />
        </span>
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

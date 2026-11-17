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

import { useEffect, useState, useSyncExternalStore } from "react";
import { Settings, CloudUpload, CloudAlert } from "lucide-react";
import { subscribeDriveSync, getDriveSyncStatus, syncNow } from "../utils/driveSync";
import { getDriveToken, preloadGoogleSignIn } from "../utils/googleDrive";

interface BrandProps {
  appName: string;
  // Called when the user taps the gear icon to open Settings.
  onSettingsOpen: () => void;
}

export function Brand({ appName, onSettingsOpen }: BrandProps) {
  // A silent Drive token refresh can briefly flash Google's page; a small
  // cue while syncing makes that read as something Slate is doing.
  const syncState = useSyncExternalStore(subscribeDriveSync, getDriveSyncStatus).state;
  const syncing = syncState === "syncing";

  // When a sync has failed, the cue turns into a "Tap to sync" button.
  // The usual cause: Google's sign-in token (held in memory for about an
  // hour) has run out, and a browser won't let a background timer open
  // Google's sign-in window, so automatic sync can't renew it. A tap
  // can, so one tap here shows Google's window and syncs.
  const syncFailed =
    syncState === "needs-reconnect" || syncState === "error" || syncState === "wrong-passphrase";
  const [fixing, setFixing] = useState(false);

  // Have Google's script ready, so its window opens straight from the tap
  // (after a network wait, the browser may no longer count it as a tap).
  useEffect(() => {
    if (syncFailed) preloadGoogleSignIn();
  }, [syncFailed]);

  async function fixSync() {
    // Only Settings can fix a passphrase that won't open the Drive copy.
    if (syncState === "wrong-passphrase") { onSettingsOpen(); return; }
    setFixing(true);
    try {
      try {
        // Ask Google first, while the tap still counts as a user gesture.
        await getDriveToken({ interactive: true });
      } catch {
        return; // e.g. Google's window was closed: leave the button showing
      }
      await syncNow({ interactive: true });
    } catch {
      // The reason is shown under Sync now in Settings.
      onSettingsOpen();
    } finally {
      setFixing(false);
    }
  }
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
        {syncFailed && !syncing ? (
          <button
            className="sync-alert-btn"
            onClick={() => void fixSync()}
            disabled={fixing}
            aria-label={
              syncState === "wrong-passphrase"
                ? "Google Drive sync needs your passphrase. Open settings"
                : "Google Drive sync didn't finish. Tap to sync now"
            }
          >
            <CloudAlert size={15} aria-hidden />
            <span>{syncState === "wrong-passphrase" ? "Sync" : "Tap to sync"}</span>
          </button>
        ) : (
          <span className={`sync-indicator${syncing ? " visible" : ""}`} title="Syncing with Google Drive" aria-hidden>
            <CloudUpload size={16} />
          </span>
        )}
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

// ============================================================
// Slate — components/DriveStalePrompt.tsx
// ============================================================
// Pop-up shown when "Sync with Google Drive" is on but this device
// hasn't synced for over 7 days (or never has). Checked when the app
// starts and whenever it returns to the foreground. "Not now" snoozes
// it until the app is next restarted.
//
// FILE LOCATION:
//   src/components/DriveStalePrompt.tsx
// ============================================================

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getConfig } from "../data/repository";
import { getDriveToken, isDriveConfigured, preloadGoogleSignIn } from "../utils/googleDrive";
import { isDriveSyncStale, syncDriveNow } from "../utils/driveAutoSync";

interface DriveStalePromptProps {
  /** Opens the Backup screen (conflict or missing passphrase). */
  onOpenBackup: () => void;
}

// Module-level so a snooze outlasts remounts, until the app restarts.
let snoozed = false;

export function DriveStalePrompt({ onOpenBackup }: DriveStalePromptProps) {
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function check() {
      if (snoozed || !isDriveConfigured()) return;
      getConfig()
        .then((config) => {
          if (snoozed || !isDriveSyncStale(config)) return;
          preloadGoogleSignIn(); // so the sign-in popup opens straight from the tap
          setLastSyncedAt(config.driveLastSyncedAt || null);
          setVisible(true);
        })
        .catch(console.error);
    }
    function onVisibility() {
      if (document.visibilityState === "visible") check();
    }
    check();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (!visible) return null;

  function snooze() {
    snoozed = true;
    setVisible(false);
  }

  async function reconnectAndSync() {
    setBusy(true); setError("");
    try {
      await getDriveToken();
      const result = await syncDriveNow();
      if (result === "synced") { snooze(); return; }
      if (result === "conflict" || result === "off") { snooze(); onOpenBackup(); return; }
      setError("Sync didn't complete. Try again, or open Backup for details.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconnect failed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="drive-prompt-overlay" role="dialog" aria-modal="true" aria-label="Google Drive sync overdue">
      <div className="ai-warning" style={{ margin: 0 }}>
        <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Google Drive sync is overdue</p>
        <p>
          {lastSyncedAt
            ? `This device last synced with Google Drive on ${new Date(lastSyncedAt).toLocaleDateString()}, more than 7 days ago.`
            : "This device hasn't synced with Google Drive yet."}{" "}
          Reconnect to sync your latest changes now.
        </p>
        {error && <p className="auth-error">{error}</p>}
        <div className="ai-warning-actions">
          <button className="btn btn-secondary" onClick={snooze} disabled={busy}>Not now</button>
          <button className="btn btn-primary" onClick={() => { void reconnectAndSync(); }} disabled={busy}>
            <RefreshCw size={14} aria-hidden /> {busy ? "Syncing…" : "Reconnect & sync now"}
          </button>
        </div>
      </div>
    </div>
  );
}

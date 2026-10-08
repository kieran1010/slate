// ============================================================
// Slate — components/DriveStalePrompt.tsx
// ============================================================
// Pop-up shown when Google Drive sync is on but this device hasn't
// synced for over 7 days. With automatic sync working that never
// happens, so it means automatic sync has been failing (typically:
// Google wants a tap before it will issue a token again) or is off.
// Not shown before the first sync ever. Checked when the app starts
// and whenever it returns to the foreground. "Not now" snoozes it
// until the app is next restarted.
//
// FILE LOCATION:
//   src/components/DriveStalePrompt.tsx
// ============================================================

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getConfig } from "../data/repository";
import { isDriveConfigured, preloadGoogleSignIn } from "../utils/googleDrive";
import { isDriveSyncStale, syncNow, getDriveSyncStatus } from "../utils/driveSync";

interface DriveStalePromptProps {
  /** Opens Settings (passphrase problem, or details of a failure). */
  onOpenSettings: () => void;
}

// Module-level so a snooze outlasts remounts, until the app restarts.
let snoozed = false;

export function DriveStalePrompt({ onOpenSettings }: DriveStalePromptProps) {
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
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
          setLastSyncedAt(config.driveLastSyncedAt);
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
      await syncNow({ interactive: true });
      snooze();
    } catch (err) {
      if (getDriveSyncStatus().state === "wrong-passphrase") { snooze(); onOpenSettings(); return; }
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="drive-prompt-overlay" role="dialog" aria-modal="true" aria-label="Google Drive sync overdue">
      <div className="ai-warning" style={{ margin: 0 }}>
        <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Google Drive sync is overdue</p>
        <p>
          This device last synced with Google Drive on {new Date(lastSyncedAt).toLocaleDateString()}, more
          than 7 days ago. Sync now to bring this device and your other devices up to date.
        </p>
        {error && <p className="auth-error">{error}</p>}
        <div className="ai-warning-actions">
          <button className="btn btn-secondary" onClick={snooze} disabled={busy}>Not now</button>
          <button className="btn btn-primary" onClick={() => { void reconnectAndSync(); }} disabled={busy}>
            <RefreshCw size={14} aria-hidden /> {busy ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>
    </div>
  );
}

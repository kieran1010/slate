// ============================================================
// Slate — BackupScreen.tsx
// ============================================================
// Encrypted backup, on its own screen (reachable via the icon next
// to Settings in the Brand bar) rather than buried inside Settings.
// Three things live here:
//   PASSPHRASE   — encrypts/decrypts both backup types below.
//   FILE BACKUP  — export/import a .slate file, no account needed.
//   GOOGLE DRIVE — optional, warning-gated; keeps one encrypted
//                  backup file (slate-backup.slate) in the user's
//                  Drive, overwritten on each backup. See
//                  utils/googleDrive.ts.
//
// The passphrase is stored on this device only, never in a backup,
// so it must be typed on each new device. Backups also carry the
// user's settings (BACKUP_SETTINGS_FIELDS), restored on Replace.
//
// IMPORT SAFETY: if the device already has patient data, the user
// is asked to choose Replace (wipe local, use the backup) or Merge
// (keep local, add the backup's records alongside it) — see
// repository.importData()'s ImportMode for what each does.
//
// FILE LOCATION:
//   src/screens/BackupScreen.tsx
// ============================================================

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Eye, EyeOff, AlertTriangle, Check, X, Download, Upload } from "lucide-react";
import { getConfig, saveConfig, hasAnyLocalData, type ImportMode } from "../data/repository";
import { DEFAULT_APP_CONFIG } from "../data/models";
import {
  exportEncrypted,
  importEncrypted,
  buildEncryptedPayload,
  importFromEncryptedString,
  type ImportResultCounts,
  type ModuleImportCounts,
} from "../utils/exportImport";
import {
  isDriveConfigured,
  preloadGoogleSignIn,
  getDriveToken,
  revokeDriveToken,
  findBackupFile,
  readBackupFile,
  writeBackupFile,
} from "../utils/googleDrive";
import {
  subscribeAutoSync,
  getAutoSyncStatus,
  noteDriveSynced,
  resumeAutoSync,
  setAutoSyncEnabled,
  stopAutoSync,
  type AutoSyncStatus,
} from "../utils/driveAutoSync";

// ── Types ─────────────────────────────────────────────────────

interface FormState {
  encryptionPassphrase: string;
  driveBackupEnabled: boolean;
}

interface BackupScreenProps {
  onClose?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────

// "5 acute" — or, if some are archived, "5 acute (4 active, 1 archived)".
// Spelled out because a plain total double-counts records that moved on
// (e.g. an Acute referral archived via "Move to follow-up" still lives in
// the acute table) — without this they'd look like active list members.
function describeCounts(label: string, c: ModuleImportCounts): string {
  if (c.archived === 0) return `${c.total} ${label}`;
  return `${c.total} ${label} (${c.active} active, ${c.archived} archived)`;
}

function describeImport(mode: ImportMode, c: ImportResultCounts): string {
  const verb = mode === "replace" ? "Replaced with" : "Merged in";
  return (
    `${verb} ${describeCounts("acute", c.acute)}, ` +
    `${describeCounts("pre-assessments", c.preAssess)}, ` +
    `${describeCounts("follow-ups", c.followUp)}.` +
    (c.settingsRestored ? " Settings restored." : "")
  );
}

// ── Component ─────────────────────────────────────────────────

function describeAutoSync(s: AutoSyncStatus): string {
  const last = s.lastSyncedAt ? ` Last synced ${new Date(s.lastSyncedAt).toLocaleTimeString()}.` : "";
  switch (s.state) {
    case "pending": return "Auto-sync: changes will sync shortly." + last;
    case "syncing": return "Auto-sync: syncing…";
    case "synced": return "Auto-sync: up to date." + last;
    case "needs-reconnect": return "Auto-sync paused — reconnect to Google to sync your latest changes.";
    case "conflict": return "Auto-sync paused — Drive holds a backup from another device. Use Sync now to choose whether to replace it, or Restore from Drive.";
    case "error": return `Auto-sync failed${s.message ? `: ${s.message}` : ""}. It will retry.`;
    default: return "Auto-sync is on. Syncs about 30 seconds after you make changes, while connected to Google (about an hour after you last tapped Sync now or Restore)." + last;
  }
}

export function BackupScreen({
  onClose,
}: BackupScreenProps) {
  const existingConfig = useLiveQuery(() => getConfig(), []);
  // Undefined while loading; false on a fresh or erased device.
  const hasLocalData = useLiveQuery(() => hasAnyLocalData(), []);

  const [form, setForm] = useState<FormState>({
    encryptionPassphrase: DEFAULT_APP_CONFIG.encryptionPassphrase,
    driveBackupEnabled: DEFAULT_APP_CONFIG.driveBackupEnabled,
  });
  const [initialized, setInitialized] = useState(false);
  const [passphraseVisible, setPassphraseVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const [showDriveWarning, setShowDriveWarning] = useState(false);

  // ── File export / import state ─────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: boolean; message: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const pendingImportFileRef = useRef<File | null>(null);

  // Replace-vs-merge confirm, shared by file and Drive import. Holds which
  // kind triggered it, plus whether local data exists (decides which
  // buttons to show — there's nothing to "replace" on an empty device).
  const [showImportConfirm, setShowImportConfirm] = useState<"file" | "drive" | null>(null);
  const [importConfirmHasLocalData, setImportConfirmHasLocalData] = useState(false);

  // ── Drive state ───────────────────────────────────────────
  const [driveExporting, setDriveExporting] = useState(false);
  const [driveImporting, setDriveImporting] = useState(false);
  const [driveResult, setDriveResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Set when "Back up now" finds a Drive backup this device didn't write
  // or restore (e.g. one from another device) — overwriting it needs an
  // explicit confirm, since there is only ever one copy.
  const [pendingOverwrite, setPendingOverwrite] = useState<{ token: string; fileId: string; modifiedTime: string } | null>(null);

  // ── Populate form from Dexie ──────────────────────────────
  useEffect(() => {
    if (!existingConfig || initialized) return;
    setForm({
      encryptionPassphrase: existingConfig.encryptionPassphrase,
      driveBackupEnabled: existingConfig.driveBackupEnabled,
    });
    setInitialized(true);
  }, [existingConfig, initialized]);

  // Load Google's sign-in script up front, so the consent popup opens
  // straight from the button tap rather than after a network round-trip
  // (which some browsers treat as no longer user-initiated and block).
  useEffect(() => {
    if (form.driveBackupEnabled && isDriveConfigured()) preloadGoogleSignIn();
  }, [form.driveBackupEnabled]);

  const set = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
  }, []);

  // The Drive toggle saves immediately rather than waiting for the Save
  // button — otherwise leaving the screen (or closing the app) after
  // flipping it silently reverts it.
  function setDriveEnabled(enabled: boolean) {
    set("driveBackupEnabled", enabled);
    saveConfig({ driveBackupEnabled: enabled }).catch((err) => {
      console.error("Drive toggle save failed:", err);
      alert("Couldn't save the Google Drive setting — please try again.");
    });
  }

  // Like the main toggle, saves immediately.
  function handleAutoSyncToggle() {
    const next = !autoOn;
    setAutoSyncEnabled(next);
    saveConfig({ driveAutoSyncEnabled: next }).catch((err) => {
      console.error("Auto-sync toggle save failed:", err);
      alert("Couldn't save the automatic sync setting — please try again.");
    });
  }

  // ── Save ──────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    try {
      await saveConfig({
        encryptionPassphrase: form.encryptionPassphrase,
        driveBackupEnabled: form.driveBackupEnabled,
      });
      setToastVisible(true);
      setTimeout(() => { setToastVisible(false); onClose?.(); }, 900);
    } catch (err) {
      console.error("Backup settings save failed:", err);
      alert("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Import confirm (shared by file + Drive) ────────────────

  async function openImportConfirm(kind: "file" | "drive") {
    setImportConfirmHasLocalData(await hasAnyLocalData());
    setShowImportConfirm(kind);
  }

  function cancelImportConfirm() {
    setShowImportConfirm(null);
    pendingImportFileRef.current = null;
  }

  async function confirmImport(mode: ImportMode) {
    const kind = showImportConfirm;
    setShowImportConfirm(null);

    if (kind === "file") {
      const file = pendingImportFileRef.current;
      pendingImportFileRef.current = null;
      if (!file) return;
      setImporting(true); setImportResult(null);
      try {
        const c = await importEncrypted(file, form.encryptionPassphrase, mode);
        setImportResult({ ok: true, message: describeImport(mode, c) });
      } catch (err) {
        setImportResult({ ok: false, message: err instanceof Error ? err.message : "Import failed." });
      } finally { setImporting(false); }

    } else if (kind === "drive") {
      setDriveImporting(true); setDriveResult(null);
      try {
        const token = await getDriveToken();
        const file = await findBackupFile(token);
        if (!file) {
          setDriveResult({ ok: false, message: "No Slate backup found in this Google account's Drive." });
          return;
        }
        const encryptedText = await readBackupFile(token, file.id);
        const c = await importFromEncryptedString(encryptedText, form.encryptionPassphrase, mode);
        // This device now holds that backup, so later backups from here
        // may overwrite it without the "another device" warning.
        await saveConfig({ driveFileId: file.id });
        noteDriveSynced();
        setDriveResult({ ok: true, message: describeImport(mode, c) });
      } catch (err) {
        setDriveResult({ ok: false, message: err instanceof Error ? err.message : "Restore failed." });
      } finally { setDriveImporting(false); }
    }
  }

  // ── File export / import ──────────────────────────────────
  async function handleExportEncrypted() {
    if (!form.encryptionPassphrase.trim()) { alert("Please set an encryption passphrase first."); return; }
    setExporting(true);
    try { await exportEncrypted(form.encryptionPassphrase); }
    catch (err) { console.error(err); alert("Export failed. Please try again."); }
    finally { setExporting(false); }
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!form.encryptionPassphrase.trim()) {
      alert("Please enter your encryption passphrase first.");
      if (importInputRef.current) importInputRef.current.value = "";
      return;
    }
    pendingImportFileRef.current = file;
    if (importInputRef.current) importInputRef.current.value = "";
    setImportResult(null);
    void openImportConfirm("file");
  }

  // ── Drive export / import ─────────────────────────────────
  async function handleDriveExport() {
    if (!form.encryptionPassphrase.trim()) { alert("Please set an encryption passphrase before backing up."); return; }
    setDriveExporting(true); setDriveResult(null); setPendingOverwrite(null);
    try {
      const token = await getDriveToken();
      resumeAutoSync();
      const existing = await findBackupFile(token);
      const config = await getConfig();
      if (existing && existing.id !== config.driveFileId) {
        // A backup is already in Drive that this device didn't write or
        // restore. Overwriting it could lose another device's data.
        setPendingOverwrite({ token, fileId: existing.id, modifiedTime: existing.modifiedTime });
        return;
      }
      await uploadBackup(token, existing?.id ?? null);
    } catch (err) {
      setDriveResult({ ok: false, message: err instanceof Error ? err.message : "Backup failed." });
    } finally { setDriveExporting(false); }
  }

  async function confirmOverwrite() {
    const pending = pendingOverwrite;
    setPendingOverwrite(null);
    if (!pending) return;
    setDriveExporting(true); setDriveResult(null);
    try {
      await uploadBackup(pending.token, pending.fileId);
    } catch (err) {
      setDriveResult({ ok: false, message: err instanceof Error ? err.message : "Backup failed." });
    } finally { setDriveExporting(false); }
  }

  async function uploadBackup(token: string, fileId: string | null) {
    const encrypted = await buildEncryptedPayload(form.encryptionPassphrase);
    const file = await writeBackupFile(token, encrypted, fileId);
    await saveConfig({ driveFileId: file.id });
    noteDriveSynced();
    setDriveResult({ ok: true, message: "Synced with Google Drive." });
  }

  async function handleDriveReconnect() {
    try {
      await getDriveToken();
      resumeAutoSync();
    } catch (err) {
      setDriveResult({ ok: false, message: err instanceof Error ? err.message : "Reconnect failed." });
    }
  }

  function handleDriveImport() {
    if (!form.encryptionPassphrase.trim()) { alert("Please enter your encryption passphrase first."); return; }
    setDriveResult(null); setPendingOverwrite(null);
    void openImportConfirm("drive");
  }

  // ── Derived ───────────────────────────────────────────────
  const driveBusy = driveExporting || driveImporting;
  const autoSync = useSyncExternalStore(subscribeAutoSync, getAutoSyncStatus);
  const autoOn = existingConfig?.driveAutoSyncEnabled ?? true;
  const autoSyncLine = autoOn
    ? describeAutoSync(autoSync)
    : "Automatic sync is off. Use Sync now to back up; you'll be reminded if it's been over 7 days.";

  // ── Render ────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div className="screen-header">
        {onClose && (
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close backup" style={{ padding: "6px 4px" }}>
            <X size={20} aria-hidden />
          </button>
        )}
        <h1 className="screen-header-title" style={{ textAlign: "left", flex: 1 }}>Backup</h1>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} aria-busy={saving} style={{ minWidth: 60 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="form-body">

        {hasLocalData === false && (
          <div className="gdocs-notice" role="status" style={{ margin: "0 16px 0.75rem" }}>
            <AlertTriangle size={14} aria-hidden />
            <span>
              New device? Enter your passphrase below, then use Import backup for a backup file, or
              switch on Google Drive and tap Restore from Drive. Your settings are restored too.
            </span>
          </div>
        )}

        {/* ── Passphrase ───────────────────────────────────── */}
        <section className="form-section" aria-label="Encryption passphrase">
          <div className="form-section-title">Encryption passphrase</div>
          <div className="form-field">
            <label className="form-label" htmlFor="b-passphrase">Passphrase</label>
            <div className="apikey-row">
              <input id="b-passphrase" className="form-input"
                type={passphraseVisible ? "text" : "password"}
                placeholder="Choose a strong passphrase"
                value={form.encryptionPassphrase}
                onChange={(e) => set("encryptionPassphrase", e.target.value)}
                autoComplete="off" autoCorrect="off" spellCheck={false} />
              <button className="btn-icon-sm" type="button" onClick={() => setPassphraseVisible((v) => !v)}
                aria-label={passphraseVisible ? "Hide passphrase" : "Show passphrase"}>
                {passphraseVisible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
              </button>
            </div>
            <span className="form-hint">
              Encrypts and decrypts every backup below — both the file and the Google Drive copy.
              Stored on this device only and never included in a backup: you'll need to type it on
              each new device, and if you forget it your backups can't be recovered.
            </span>
          </div>
        </section>

        {/* ── Backup file ──────────────────────────────────── */}
        <section className="form-section" aria-label="Backup file">
          <div className="form-section-title">Backup file</div>
          <div className="form-section-body">
            <p className="form-hint">
              Export all patient data as an encrypted file, or import a backup onto this device.
            </p>
            <div className="data-action-buttons">
              <button className="btn btn-secondary data-btn" onClick={handleExportEncrypted} disabled={exporting || importing || !!showImportConfirm}>
                <Download size={14} aria-hidden />{exporting ? "Exporting…" : "Export backup"}
              </button>
              <button className="btn btn-secondary data-btn"
                onClick={() => { setImportResult(null); importInputRef.current?.click(); }}
                disabled={importing || exporting || !!showImportConfirm}>
                <Upload size={14} aria-hidden />{importing ? "Importing…" : "Import backup"}
              </button>
              <input ref={importInputRef} type="file" accept=".slate" style={{ display: "none" }} onChange={handleImportFile} />
            </div>

            {importResult && (
              <p className={importResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.6rem" }}>
                {importResult.message}
              </p>
            )}
          </div>
        </section>

        {/* ── Google Drive ─────────────────────────────────── */}
        <section className="form-section" aria-label="Google Drive backup">
          <div className="form-section-title">Google Drive</div>

          <div className="form-field">
            <div className="toggle-row">
              <span className="toggle-label">
                Sync with Google Drive
                <span className="toggle-label-sub">
                  Keeps one encrypted backup file in your own Google Drive
                </span>
              </span>
              <button className="toggle-track" role="switch" aria-checked={form.driveBackupEnabled}
                aria-label="Sync with Google Drive"
                onClick={() => {
                  if (form.driveBackupEnabled) {
                    setDriveEnabled(false);
                    stopAutoSync();
                    setPendingOverwrite(null);
                    void revokeDriveToken();
                  } else { setShowDriveWarning(true); }
                }}>
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>

          {showDriveWarning && (
            <div className="ai-warning" role="alert" aria-live="polite">
              <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Privacy notice</p>
              <p>
                This stores an <strong>encrypted</strong> copy of your patient data in your own Google
                Drive. It is encrypted on this device with your passphrase before it is sent, and the
                passphrase never leaves this device — neither Google nor Slate can read the backup.
              </p>
              <p>
                Google will ask you to let Slate access its own files in your Drive. Slate can only
                see the one backup file it creates (<strong>slate-backup.slate</strong>), never the
                rest of your Drive. Each backup replaces the previous one.
              </p>
              <div className="ai-warning-actions">
                <button className="btn btn-secondary" onClick={() => setShowDriveWarning(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => { setShowDriveWarning(false); setDriveEnabled(true); }}>
                  <Check size={14} aria-hidden /> I understand, enable
                </button>
              </div>
            </div>
          )}

          {form.driveBackupEnabled && !showDriveWarning && (
            <div>
              {!isDriveConfigured() && (
                <div className="gdocs-notice" role="status">
                  <AlertTriangle size={14} aria-hidden />
                  <span>Google Drive backup isn't set up in this version of Slate.</span>
                </div>
              )}

              {isDriveConfigured() && (
                <div className="form-section-body" style={{ paddingTop: "0.5rem" }}>
                  <div className="data-action-buttons">
                    <button className="btn btn-secondary data-btn"
                      onClick={handleDriveExport} disabled={driveBusy || !!showImportConfirm || !!pendingOverwrite}>
                      <Download size={14} aria-hidden />
                      {driveExporting ? "Syncing…" : "Sync now"}
                    </button>
                    <button className="btn btn-secondary data-btn"
                      onClick={handleDriveImport} disabled={driveBusy || !!showImportConfirm || !!pendingOverwrite}>
                      <Upload size={14} aria-hidden />
                      {driveImporting ? "Restoring…" : "Restore from Drive"}
                    </button>
                  </div>
                  <div className="toggle-row" style={{ marginTop: "0.75rem" }}>
                    <span className="toggle-label">
                      Sync automatically
                      <span className="toggle-label-sub">
                        Uploads shortly after you make changes
                      </span>
                    </span>
                    <button className="toggle-track" role="switch" aria-checked={autoOn}
                      aria-label="Sync automatically" onClick={handleAutoSyncToggle}>
                      <span className="toggle-thumb" />
                    </button>
                  </div>
                  <p className="form-hint" role="status" style={{ marginTop: "0.5rem" }}>
                    {autoSyncLine}
                    {autoOn && autoSync.state === "needs-reconnect" && (
                      <> <button className="btn btn-ghost" onClick={handleDriveReconnect} disabled={driveBusy}>Reconnect</button></>
                    )}
                  </p>
                  {driveResult && (
                    <p className={driveResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.5rem" }}>
                      {driveResult.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Overwrite confirm — a Drive backup this device didn't write ── */}
        {pendingOverwrite && (
          <div className="ai-warning" role="alert" aria-live="polite" style={{ margin: "0 16px" }}>
            <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Replace the backup in Google Drive?</p>
            <p>
              Your Drive already has a Slate backup from {new Date(pendingOverwrite.modifiedTime).toLocaleString()} that
              wasn't made or restored on this device. Backing up now <strong>replaces it</strong> with
              only what's on this device. To keep its records, cancel and use Restore from Drive
              (choose Merge) first.
            </p>
            <div className="ai-warning-actions">
              <button className="btn btn-secondary" onClick={() => setPendingOverwrite(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => void confirmOverwrite()}>Replace</button>
            </div>
          </div>
        )}

        {/* ── Replace vs merge confirm — shared by file + Drive import ── */}
        {showImportConfirm && (
          <div className="ai-warning" role="alert" aria-live="polite" style={{ margin: "0 16px" }}>
            {importConfirmHasLocalData ? (
              <>
                <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> You already have patient data on this device</p>
                <p>
                  <strong>Replace</strong> deletes all current acute referrals, pre-assessments, and
                  follow-ups and swaps in the backup's contents, and restores the backup's settings
                  (profile, defaults, AI key). <strong>Merge</strong> keeps what's already here, including
                  this device's settings, and adds the backup's records alongside it.
                </p>
                <p>This cannot be undone.</p>
                <div className="ai-warning-actions">
                  <button className="btn btn-secondary" onClick={cancelImportConfirm}>Cancel</button>
                  <button className="btn btn-secondary" onClick={() => confirmImport("merge")}>Merge</button>
                  <button className="btn btn-danger" onClick={() => confirmImport("replace")}>Replace</button>
                </div>
              </>
            ) : (
              <>
                <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Import this backup?</p>
                <p>This adds the backup's acute referrals, pre-assessments, follow-ups and settings to this device.</p>
                <div className="ai-warning-actions">
                  <button className="btn btn-secondary" onClick={cancelImportConfirm}>Cancel</button>
                  <button className="btn btn-primary" onClick={() => confirmImport("replace")}>Import</button>
                </div>
              </>
            )}
          </div>
        )}

      </div>

      {/* Saved toast */}
      <div className={`save-toast${toastVisible ? " visible" : ""}`} aria-live="polite" aria-atomic="true">
        Settings saved
      </div>
    </div>
  );
}

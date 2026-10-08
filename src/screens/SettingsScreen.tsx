// ============================================================
// Slate — SettingsScreen.tsx
// ============================================================
// Six sections:
//   PROFILE         — clinician name and role
//   APP DEFAULTS    — follow-up offset, notification lead time
//   AI FEATURES     — opt-in toggle + API key
//   BACKUP & SYNC   — passphrase, Google Drive sync, backup file
//   CSV EXPORT      — unencrypted spreadsheet export
//   ERASE           — wipe everything on this device
//
// There is no account: settings live on this device, and travel between
// devices with Google Drive sync or inside an encrypted backup file.
//
// BACKUP & SYNC:
//   PASSPHRASE   — encrypts both the Drive copy and backup files. Stored
//                  on this device only, never in a backup, so it must be
//                  typed on each new device.
//   GOOGLE DRIVE — optional, warning-gated two-way sync of one encrypted
//                  file (slate-backup.slate). A single "Sync now" merges
//                  this device with Drive both ways — there's no separate
//                  restore: a new device just switches sync on. See
//                  utils/driveSync.ts.
//   BACKUP FILE  — export/import a .slate file, no account needed. On
//                  import into a device that already has data, the user
//                  chooses Replace or Merge (repository.importData()).
//
// FILE LOCATION:
//   src/screens/SettingsScreen.tsx
// ============================================================

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Eye, EyeOff, AlertTriangle, Check, X,
  Trash2, FileDown, Download, Upload, RefreshCw,
} from "lucide-react";
import { getConfig, saveConfig, clearAllLocalData, hasAnyLocalData, type ImportMode } from "../data/repository";
import { DEFAULT_APP_CONFIG } from "../data/models";
import {
  exportCsv,
  exportEncrypted,
  importEncrypted,
  type ImportResultCounts,
  type ModuleImportCounts,
} from "../utils/exportImport";
import {
  isDriveConfigured,
  preloadGoogleSignIn,
  getDriveToken,
  revokeDriveToken,
  findBackupFile,
  getFileMetadata,
  deleteBackupFile,
} from "../utils/googleDrive";
import {
  syncNow,
  replaceDriveCopy,
  driveSyncSettingsChanged,
  subscribeDriveSync,
  getDriveSyncStatus,
  type DriveSyncStatus,
  type SyncResult,
} from "../utils/driveSync";

// ── Types ─────────────────────────────────────────────────────

interface FormState {
  clinicianName: string;
  clinicianRole: string;
  defaultFollowUpHours: number;
  notificationLeadMins: number;
  aiEnabled: boolean;
  anthropicApiKey: string;
  encryptionPassphrase: string;
}

interface SettingsScreenProps {
  // Closes the Settings panel (App balances the browser-history entry).
  onClose?: () => void;
  // Called after "Erase this device" has wiped all local data. App uses
  // it to recreate a fresh profile and reset the UI without a page reload.
  onDataErased?: () => void;
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

function describeSync(r: SyncResult): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${r.added} record${r.added === 1 ? "" : "s"} added from Drive`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.settingsChanged) parts.push("settings updated");
  return parts.length ? `Synced: ${parts.join(", ")}.` : "Synced. Everything was already up to date.";
}

function formatWhen(ms: number | null): string {
  if (!ms) return "never";
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleString();
}

function describeStatus(s: DriveSyncStatus, lastSyncedAt: number | null): string {
  const last = `Last synced ${formatWhen(lastSyncedAt)}.`;
  switch (s.state) {
    case "syncing": return "Syncing…";
    case "pending": return `Changes will sync shortly. ${last}`;
    case "needs-reconnect": return `Automatic sync couldn't reach your Google account without a tap. Tap Sync now to reconnect. ${last}`;
    case "error": return `Last sync attempt failed${s.message ? `: ${s.message}` : "."} ${last}`;
    default: return lastSyncedAt ? last : "Not synced yet. Tap Sync now.";
  }
}

// ── Component ─────────────────────────────────────────────────

export function SettingsScreen({ onClose, onDataErased }: SettingsScreenProps) {
  const existingConfig = useLiveQuery(() => getConfig(), []);

  // ── Form state ────────────────────────────────────────────
  const [form, setForm] = useState<FormState>({
    clinicianName: DEFAULT_APP_CONFIG.clinicianName,
    clinicianRole: DEFAULT_APP_CONFIG.clinicianRole,
    defaultFollowUpHours: DEFAULT_APP_CONFIG.defaultFollowUpHours,
    notificationLeadMins: DEFAULT_APP_CONFIG.notificationLeadMins,
    aiEnabled: DEFAULT_APP_CONFIG.aiEnabled,
    anthropicApiKey: DEFAULT_APP_CONFIG.anthropicApiKey,
    encryptionPassphrase: DEFAULT_APP_CONFIG.encryptionPassphrase,
  });
  const [initialized, setInitialized] = useState(false);
  const [showAiWarning, setShowAiWarning] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [passphraseVisible, setPassphraseVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  // ── Erase-device state ─────────────────────────────────────
  const [showEraseConfirm, setShowEraseConfirm] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [eraseDriveToo, setEraseDriveToo] = useState(false);

  // ── Drive sync state ───────────────────────────────────────
  const [showDriveWarning, setShowDriveWarning] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveResult, setDriveResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmReplaceDrive, setConfirmReplaceDrive] = useState(false);
  const syncStatus = useSyncExternalStore(subscribeDriveSync, getDriveSyncStatus);
  // Undefined while loading; false on a fresh or erased device.
  const hasLocalData = useLiveQuery(() => hasAnyLocalData(), []);

  // ── Backup file state ──────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: boolean; message: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const pendingImportFileRef = useRef<File | null>(null);
  // Replace-vs-merge confirm. Holds whether local data exists (decides
  // which buttons to show — there's nothing to "replace" on an empty device).
  const [importConfirm, setImportConfirm] = useState<{ hasLocalData: boolean } | null>(null);

  // ── CSV export state ───────────────────────────────────────
  const [exportingCsv, setExportingCsv] = useState(false);

  // ── Populate form from Dexie ──────────────────────────────
  useEffect(() => {
    if (!existingConfig || initialized) return;
    setForm({
      clinicianName: existingConfig.clinicianName,
      clinicianRole: existingConfig.clinicianRole,
      defaultFollowUpHours: existingConfig.defaultFollowUpHours,
      notificationLeadMins: existingConfig.notificationLeadMins,
      aiEnabled: existingConfig.aiEnabled,
      anthropicApiKey: existingConfig.anthropicApiKey,
      encryptionPassphrase: existingConfig.encryptionPassphrase,
    });
    setInitialized(true);
  }, [existingConfig, initialized]);

  const driveEnabled = existingConfig?.driveBackupEnabled ?? false;
  const autoOn = existingConfig?.driveAutoSyncEnabled ?? true;
  const lastSyncedAt = syncStatus.lastSyncedAt ?? (existingConfig?.driveLastSyncedAt || null);

  // Load Google's sign-in script up front, so the consent popup opens
  // straight from the button tap rather than after a network round-trip
  // (which some browsers treat as no longer user-initiated and block).
  useEffect(() => {
    if ((driveEnabled || showDriveWarning) && isDriveConfigured()) preloadGoogleSignIn();
  }, [driveEnabled, showDriveWarning]);

  const set = useCallback(
    <K extends keyof FormState>(field: K, value: FormState[K]) => {
      setForm((f) => ({ ...f, [field]: value }));
    }, []
  );

  // ── Save ──────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    try {
      const config = {
        clinicianName: form.clinicianName.trim(),
        clinicianRole: form.clinicianRole.trim(),
        defaultFollowUpHours: Math.max(1, Number(form.defaultFollowUpHours) || 24),
        notificationLeadMins: Math.max(0, Number(form.notificationLeadMins) || 60),
        aiEnabled: form.aiEnabled,
        anthropicApiKey: form.anthropicApiKey.trim(),
        encryptionPassphrase: form.encryptionPassphrase,
      };
      await saveConfig(config);
      setToastVisible(true);
      // Auto-close shortly after a successful save: the "Settings saved"
      // toast flashes, then the panel dismisses. onClose (App.closeSettings)
      // also balances the browser-history entry pushed when Settings opened.
      setTimeout(() => {
        setToastVisible(false);
        onClose?.();
      }, 900);
    } catch (err) {
      console.error("Settings save failed:", err);
      alert("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Erase this device ─────────────────────────────────────
  // Wipes all patient data and settings (including the backup
  // passphrase) from this device and disconnects Google Drive, then hands
  // off to App (onDataErased) to recreate a fresh profile and reset the
  // UI. No window.location.reload() — that reload is what produced the
  // blank-screen-needing-refresh behaviour.
  async function handleEraseDevice() {
    setErasing(true);
    if (eraseDriveToo) {
      // Delete the Drive copy first: if that fails, nothing is erased and
      // the user can decide what to do.
      try {
        const token = await getDriveToken({ interactive: true });
        const knownId = existingConfig?.driveFileId ?? "";
        const file = knownId
          ? await getFileMetadata(token, knownId).catch(() => findBackupFile(token))
          : await findBackupFile(token);
        if (file) await deleteBackupFile(token, file.id);
      } catch (err) {
        console.error(err);
        alert(`Couldn't delete the Google Drive copy, so nothing has been erased. ${err instanceof Error ? err.message : ""}`);
        setErasing(false);
        return;
      }
    }
    try {
      await revokeDriveToken();
      await clearAllLocalData();
      onDataErased?.();
    } catch (err) {
      console.error(err);
      alert("Erase failed. Please try again.");
      setErasing(false);
    }
  }

  // ── Google Drive sync ──────────────────────────────────────
  // The passphrase box is part of the form (saved by Save), but syncing
  // and file backups use it straight away, so they save it first.
  async function savePassphraseIfChanged() {
    if (existingConfig && form.encryptionPassphrase !== existingConfig.encryptionPassphrase) {
      await saveConfig({ encryptionPassphrase: form.encryptionPassphrase });
    }
  }

  async function runSync() {
    setDriveBusy(true); setDriveResult(null); setConfirmReplaceDrive(false);
    try {
      // Ask Google first, while the tap still counts as a user gesture.
      await getDriveToken({ interactive: true });
      await savePassphraseIfChanged();
      const result = await syncNow({ interactive: true });
      setDriveResult({ ok: true, message: describeSync(result) });
      return true;
    } catch (err) {
      // A wrong passphrase gets its own panel below.
      if (getDriveSyncStatus().state !== "wrong-passphrase") {
        setDriveResult({ ok: false, message: err instanceof Error ? err.message : "Sync failed." });
      }
      return false;
    } finally { setDriveBusy(false); }
  }

  function handleDriveToggle() {
    setDriveResult(null);
    if (driveEnabled) { void disableDrive(); return; }
    if (!form.encryptionPassphrase.trim()) {
      setDriveResult({ ok: false, message: "Set an encryption passphrase above first." });
      return;
    }
    setShowDriveWarning(true);
  }

  async function enableDrive() {
    setShowDriveWarning(false);
    setDriveBusy(true); setDriveResult(null);
    try {
      // Consent first: if the user cancels Google's popup, sync stays off.
      await getDriveToken({ interactive: true });
      await saveConfig({
        driveBackupEnabled: true,
        driveAutoSyncEnabled: true,
        encryptionPassphrase: form.encryptionPassphrase,
      });
      driveSyncSettingsChanged(true, false);
    } catch (err) {
      setDriveResult({ ok: false, message: err instanceof Error ? err.message : "Couldn't connect to Google Drive." });
      setDriveBusy(false);
      return;
    }
    setDriveBusy(false);
    await runSync();
  }

  async function disableDrive() {
    if (!confirm("Switch off Google Drive sync? Your data stays on this device and in your Drive.")) return;
    try {
      await saveConfig({ driveBackupEnabled: false, driveFileId: "" });
      driveSyncSettingsChanged(false, false);
      setConfirmReplaceDrive(false);
      await revokeDriveToken();
    } catch (err) {
      console.error("Drive toggle save failed:", err);
      alert("Couldn't save the Google Drive setting — please try again.");
    }
  }

  async function handleAutoSyncToggle() {
    const next = !autoOn;
    try {
      await saveConfig({ driveAutoSyncEnabled: next });
      driveSyncSettingsChanged(true, next);
    } catch (err) {
      console.error("Auto-sync toggle save failed:", err);
      alert("Couldn't save the automatic sync setting — please try again.");
    }
  }

  async function handleReplaceDrive() {
    setConfirmReplaceDrive(false);
    setDriveBusy(true); setDriveResult(null);
    try {
      await getDriveToken({ interactive: true });
      await savePassphraseIfChanged();
      await replaceDriveCopy();
      setDriveResult({ ok: true, message: "The Google Drive copy now holds this device's data, encrypted with this passphrase." });
    } catch (err) {
      setDriveResult({ ok: false, message: err instanceof Error ? err.message : "Replacing the Drive copy failed." });
    } finally { setDriveBusy(false); }
  }

  // ── Backup file ────────────────────────────────────────────
  async function handleExportEncrypted() {
    if (!form.encryptionPassphrase.trim()) { alert("Please set an encryption passphrase first."); return; }
    setExporting(true);
    try { await exportEncrypted(form.encryptionPassphrase); }
    catch (err) { console.error(err); alert("Export failed. Please try again."); }
    finally { setExporting(false); }
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (importInputRef.current) importInputRef.current.value = "";
    if (!file) return;
    if (!form.encryptionPassphrase.trim()) { alert("Please enter your encryption passphrase first."); return; }
    pendingImportFileRef.current = file;
    setImportResult(null);
    void hasAnyLocalData().then((has) => setImportConfirm({ hasLocalData: has }));
  }

  function cancelImport() {
    setImportConfirm(null);
    pendingImportFileRef.current = null;
  }

  async function confirmImport(mode: ImportMode) {
    setImportConfirm(null);
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
  }

  // ── CSV export ──────────────────────────────────────────────
  async function handleExportCsv() {
    setExportingCsv(true);
    try { await exportCsv(); }
    catch (err) { console.error(err); alert("CSV export failed. Please try again."); }
    finally { setExportingCsv(false); }
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div className="screen-header">
        {onClose && (
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close settings" style={{ padding: "6px 4px" }}>
            <X size={20} aria-hidden />
          </button>
        )}
        <h1 className="screen-header-title" style={{ textAlign: "left", flex: 1 }}>Settings</h1>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} aria-busy={saving} style={{ minWidth: 60 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="form-body">

        {/* ── Profile ──────────────────────────────────── */}
        <section className="form-section" aria-label="Profile">
          <div className="form-section-title">Profile</div>
          <div className="form-field">
            <label className="form-label" htmlFor="s-name">Your name</label>
            <input id="s-name" className="form-input" type="text" placeholder="e.g. Dr Aroha Ngata"
              value={form.clinicianName} onChange={(e) => set("clinicianName", e.target.value)} autoCapitalize="words" />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="s-role">Role</label>
            <input id="s-role" className="form-input" type="text" placeholder="e.g. Anaesthetist"
              value={form.clinicianRole} onChange={(e) => set("clinicianRole", e.target.value)} autoCapitalize="words" />
          </div>
        </section>

        {/* ── App defaults ─────────────────────────────── */}
        <section className="form-section" aria-label="App defaults">
          <div className="form-section-title">App defaults</div>
          <div className="form-field">
            <label className="form-label" htmlFor="s-fuHours">Default follow-up period (hours)</label>
            <input id="s-fuHours" className="form-input" type="number" inputMode="numeric" min={1} max={168}
              value={form.defaultFollowUpHours} onChange={(e) => set("defaultFollowUpHours", Number(e.target.value))} />
            <span className="form-hint"></span>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="s-notif">Reminder lead time (minutes)</label>
            <input id="s-notif" className="form-input" type="number" inputMode="numeric" min={0} max={1440}
              value={form.notificationLeadMins} onChange={(e) => set("notificationLeadMins", Number(e.target.value))} />
            <span className="form-hint"></span>
          </div>
        </section>

        {/* ── AI features ──────────────────────────────── */}
        <section className="form-section" aria-label="AI features">
          <div className="form-section-title">AI features</div>
          <div className="form-field">
            <div className="toggle-row">
              <span className="toggle-label">
                Enable AI features
                <span className="toggle-label-sub">Allows document import using the Anthropic API</span>
              </span>
              <button className="toggle-track" role="switch" aria-checked={form.aiEnabled}
                aria-label="Enable AI features" onClick={handleAiToggle}>
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>
          {showAiWarning && (
            <div className="ai-warning" role="alert" aria-live="polite">
              <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Data confidentiality</p>
              <p>Enabling AI features allows Slate to send clinical text to Anthropic's API for processing, including any patient information in the fields you import.</p>
              <p>You are responsible for ensuring this complies with applicable privacy obligations in your jurisdiction, including the NZ Health Information Privacy Code.</p>
              <p>AI features use <strong>your own Anthropic API key</strong>, stored on this device and included in your encrypted backups.</p>
              <div className="ai-warning-actions">
                <button className="btn btn-secondary" onClick={() => setShowAiWarning(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => { setShowAiWarning(false); set("aiEnabled", true); }}>
                  <Check size={14} aria-hidden /> I understand
                </button>
              </div>
            </div>
          )}
          {form.aiEnabled && (
            <div className="form-field">
              <label className="form-label" htmlFor="s-apikey">Anthropic API key</label>
              <div className="apikey-row">
                <input id="s-apikey" className="form-input" type={keyVisible ? "text" : "password"}
                  placeholder="sk-ant-…" value={form.anthropicApiKey}
                  onChange={(e) => set("anthropicApiKey", e.target.value)}
                  autoComplete="off" autoCorrect="off" spellCheck={false}
                  style={{ fontFamily: "monospace", letterSpacing: "0.04em" }} />
                <button className="btn-icon-sm" type="button" onClick={() => setKeyVisible((v) => !v)}
                  aria-label={keyVisible ? "Hide API key" : "Show API key"}>
                  {keyVisible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                </button>
              </div>
              <span className="form-hint">Stored on this device and included in your encrypted backups. Never sent to Hypnos Medical.</span>
            </div>
          )}
        </section>

        {/* ── Backup & sync ────────────────────────────── */}
        <section className="form-section" aria-label="Backup and sync">
          <div className="form-section-title">Backup &amp; sync</div>

          {hasLocalData === false && !driveEnabled && (
            <div className="gdocs-notice" role="status" style={{ margin: "0 16px 0.75rem" }}>
              <AlertTriangle size={14} aria-hidden />
              <span>
                New device? Enter your passphrase below, then switch on Google Drive sync to bring
                down your records and settings — or use Import backup for a backup file.
              </span>
            </div>
          )}

          <div className="form-field">
            <label className="form-label" htmlFor="s-passphrase">Encryption passphrase</label>
            <div className="apikey-row">
              <input id="s-passphrase" className="form-input"
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
              Encrypts both the Google Drive copy and backup files. Use the same passphrase on every
              device. Stored on this device only and never included in a backup: you'll need to type
              it on each new device, and if you forget it your backups can't be recovered.
            </span>
          </div>

          {/* Google Drive sync */}
          <div className="form-field">
            <div className="toggle-row">
              <span className="toggle-label">
                Google Drive sync
                <span className="toggle-label-sub">Keep this device in step with your others</span>
              </span>
              <button className="toggle-track" role="switch" aria-checked={driveEnabled}
                aria-label="Google Drive sync" onClick={handleDriveToggle} disabled={driveBusy}>
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
                passphrase never leaves this device — neither Google nor Slate can read it.
              </p>
              <p>
                Google will ask you to let Slate access its own files in your Drive. Slate can only
                see the one file it creates (<strong>slate-backup.slate</strong>), never the rest of
                your Drive. Every device you switch sync on merges its records into that file.
              </p>
              <div className="ai-warning-actions">
                <button className="btn btn-secondary" onClick={() => setShowDriveWarning(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => void enableDrive()}>
                  <Check size={14} aria-hidden /> I understand, enable
                </button>
              </div>
            </div>
          )}

          {driveEnabled && !showDriveWarning && !isDriveConfigured() && (
            <div className="gdocs-notice" role="status">
              <AlertTriangle size={14} aria-hidden />
              <span>Google Drive sync isn't set up in this version of Slate.</span>
            </div>
          )}

          {driveEnabled && !showDriveWarning && isDriveConfigured() && (
            <div className="form-section-body" style={{ paddingTop: 0 }}>
              <div className="toggle-row">
                <span className="toggle-label">
                  Sync automatically
                  <span className="toggle-label-sub">When you open Slate, and shortly after each change</span>
                </span>
                <button className="toggle-track" role="switch" aria-checked={autoOn}
                  aria-label="Sync automatically" onClick={() => void handleAutoSyncToggle()}>
                  <span className="toggle-thumb" />
                </button>
              </div>

              <div className="data-action-buttons" style={{ marginTop: "0.75rem" }}>
                <button className="btn btn-primary data-btn" onClick={() => void runSync()}
                  disabled={driveBusy || syncStatus.state === "syncing"}>
                  <RefreshCw size={14} aria-hidden />
                  {driveBusy || syncStatus.state === "syncing" ? "Syncing…" : "Sync now"}
                </button>
              </div>

              <p className="form-hint" role="status" style={{ marginTop: "0.5rem" }}>
                {syncStatus.state === "wrong-passphrase"
                  ? `Last synced ${formatWhen(lastSyncedAt)}.`
                  : describeStatus(syncStatus, lastSyncedAt)}
                {!autoOn && " Automatic sync is off — you'll be reminded if it's been over 7 days."}
              </p>

              {driveResult && (
                <p className={driveResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.5rem" }}>
                  {driveResult.message}
                </p>
              )}

              {syncStatus.state === "wrong-passphrase" && (
                <div className="ai-warning" role="alert" aria-live="polite" style={{ margin: "0.75rem 0 0" }}>
                  <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Passphrase doesn't match</p>
                  <p>
                    This device's passphrase can't open the copy in your Google Drive, so nothing has
                    been synced or overwritten. Enter the passphrase you use on your other devices
                    above, then tap Sync now.
                  </p>
                  {!confirmReplaceDrive ? (
                    <div className="ai-warning-actions">
                      <button className="btn btn-secondary" onClick={() => setConfirmReplaceDrive(true)} disabled={driveBusy}>
                        Replace Drive copy…
                      </button>
                    </div>
                  ) : (
                    <>
                      <p>
                        <strong>Replace</strong> overwrites the Drive copy with only what's on this
                        device, encrypted with this passphrase. Records that exist only in the Drive
                        copy will be lost. This cannot be undone.
                      </p>
                      <div className="ai-warning-actions">
                        <button className="btn btn-secondary" onClick={() => setConfirmReplaceDrive(false)}>Cancel</button>
                        <button className="btn btn-danger" onClick={() => void handleReplaceDrive()} disabled={driveBusy}>Replace</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {!driveEnabled && driveResult && !showDriveWarning && (
            <p className={driveResult.ok ? "data-import-ok" : "auth-error"} style={{ margin: "0 16px 0.5rem" }}>
              {driveResult.message}
            </p>
          )}

          {/* Backup file */}
          <div className="form-section-body">
            <p className="data-action-label">Backup file</p>
            <p className="form-hint">
              Export all patient data and settings as an encrypted file, or import one onto this device.
            </p>
            <div className="data-action-buttons">
              <button className="btn btn-secondary data-btn" onClick={handleExportEncrypted} disabled={exporting || importing || !!importConfirm}>
                <Download size={14} aria-hidden />{exporting ? "Exporting…" : "Export backup"}
              </button>
              <button className="btn btn-secondary data-btn"
                onClick={() => { setImportResult(null); importInputRef.current?.click(); }}
                disabled={importing || exporting || !!importConfirm}>
                <Upload size={14} aria-hidden />{importing ? "Importing…" : "Import backup"}
              </button>
              <input ref={importInputRef} type="file" accept=".slate" style={{ display: "none" }} onChange={handleImportFile} />
            </div>

            {importConfirm && (
              <div className="ai-warning" role="alert" aria-live="polite" style={{ margin: "0.75rem 0 0" }}>
                {importConfirm.hasLocalData ? (
                  <>
                    <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> You already have patient data on this device</p>
                    <p>
                      <strong>Replace</strong> deletes all current acute referrals, pre-assessments, and
                      follow-ups and swaps in the backup's contents, and restores the backup's settings
                      (profile, defaults, AI key). <strong>Merge</strong> keeps what's already here, including
                      this device's settings, and merges the backup's records in.
                    </p>
                    {driveEnabled && (
                      <p>Google Drive sync is on, so after a Replace, records that are still in your Drive copy will come back on the next sync.</p>
                    )}
                    <p>This cannot be undone.</p>
                    <div className="ai-warning-actions">
                      <button className="btn btn-secondary" onClick={cancelImport}>Cancel</button>
                      <button className="btn btn-secondary" onClick={() => void confirmImport("merge")}>Merge</button>
                      <button className="btn btn-danger" onClick={() => void confirmImport("replace")}>Replace</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Import this backup?</p>
                    <p>This adds the backup's acute referrals, pre-assessments, follow-ups and settings to this device.</p>
                    <div className="ai-warning-actions">
                      <button className="btn btn-secondary" onClick={cancelImport}>Cancel</button>
                      <button className="btn btn-primary" onClick={() => void confirmImport("replace")}>Import</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {importResult && (
              <p className={importResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.6rem" }}>
                {importResult.message}
              </p>
            )}
          </div>
        </section>

        {/* ── CSV Export ──────────────────────────────── */}
        {/* Kept SEPARATE from Backup & sync on purpose: CSV is plain-text patient
            data for spreadsheets and is NOT encrypted. */}
        <section className="form-section" aria-label="CSV export">
          <div className="form-section-title">CSV Export</div>
          <div className="form-section-body">
            <p className="data-action-label">Export CSV (unencrypted)</p>
            <p className="form-hint">
              Export all records (including archived) as three CSV files in a zip, suitable for
              spreadsheets. This file is <strong>not encrypted</strong>. There is no CSV import.
            </p>
            <div className="data-action-buttons">
              <button className="btn btn-secondary data-btn" onClick={handleExportCsv} disabled={exportingCsv}>
                <FileDown size={14} aria-hidden />{exportingCsv ? "Exporting…" : "Export CSV"}
              </button>
            </div>
          </div>
        </section>

        {/* ── Erase this device ────────────────────────── */}
        <section className="form-section" aria-label="Erase this device">
          <div className="form-section-title">Erase this device</div>
          <div className="form-section-body">
            <p className="form-hint">
              Permanently deletes all patient data and settings on this device, including your
              backup passphrase, and switches off Google Drive sync here. Use this before handing
              the device on. The copy in your Google Drive is kept unless you choose to delete it too.
            </p>
            {!showEraseConfirm ? (
              <div className="data-action-buttons">
                <button className="btn btn-secondary data-btn" onClick={() => setShowEraseConfirm(true)}>
                  <Trash2 size={14} aria-hidden /> Erase this device
                </button>
              </div>
            ) : (
              <div className="ai-warning" role="alert" aria-live="polite">
                <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Erase all data on this device?</p>
                <p>All patient data and settings on this device will be permanently deleted. This cannot be undone.</p>
                <p>Make sure you have an encrypted backup, and know its passphrase, before continuing.</p>
                {driveEnabled && isDriveConfigured() && (
                  <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", margin: "0.5rem 0" }}>
                    <input type="checkbox" checked={eraseDriveToo} onChange={(e) => setEraseDriveToo(e.target.checked)}
                      disabled={erasing} style={{ marginTop: "0.2rem" }} />
                    <span>
                      Also delete the encrypted copy in Google Drive (slate-backup.slate). Any other
                      device with sync still on will upload its own copy again when it next syncs.
                    </span>
                  </label>
                )}
                <div className="ai-warning-actions">
                  <button className="btn btn-secondary" onClick={() => { setShowEraseConfirm(false); setEraseDriveToo(false); }} disabled={erasing}>Cancel</button>
                  <button className="btn btn-danger" onClick={() => void handleEraseDevice()} disabled={erasing}>
                    {erasing ? "Erasing…" : "Erase this device"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

      </div>

      {/* Saved toast */}
      <div className={`save-toast${toastVisible ? " visible" : ""}`} aria-live="polite" aria-atomic="true">
        Settings saved
      </div>
    </div>
  );

  // ── Local helpers ─────────────────────────────────────────
  function handleAiToggle() {
    if (form.aiEnabled) { set("aiEnabled", false); setShowAiWarning(false); }
    else { setShowAiWarning(true); }
  }
}

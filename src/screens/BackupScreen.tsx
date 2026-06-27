// ============================================================
// Slate — BackupScreen.tsx
// ============================================================
// Encrypted backup, on its own screen (reachable via the icon next
// to Settings in the Brand bar) rather than buried inside Settings.
// Three things live here:
//   PASSPHRASE   — encrypts/decrypts both backup types below.
//   FILE BACKUP  — export/import a .slate file, no account needed.
//   GOOGLE DRIVE — optional, warning-gated; appends an encrypted
//                  backup to a private "Slate Backup" Google Doc.
//
// IMPORT SAFETY: if the device already has patient data, the user
// is asked to choose Replace (wipe local, use the backup) or Merge
// (keep local, add the backup's records alongside it) — see
// repository.importData()'s ImportMode for what each does.
//
// FILE LOCATION:
//   src/screens/BackupScreen.tsx
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Eye, EyeOff, AlertTriangle, Check, X, Download, Upload } from "lucide-react";
import { getConfig, saveConfig, hasAnyLocalData, type ImportMode } from "../data/repository";
import { loadRemoteSettings, saveRemoteSettings } from "../data/firebaseSync";
import { DEFAULT_APP_CONFIG } from "../data/models";
import { useAuth } from "../hooks/useAuth";
import {
  exportEncrypted,
  importEncrypted,
  buildEncryptedPayload,
  importFromEncryptedString,
  type ImportResultCounts,
  type ModuleImportCounts,
} from "../utils/exportImport";
import {
  requestDriveToken,
  createBackupDoc,
  appendToGoogleDoc,
  readLatestFromGoogleDoc,
} from "../utils/gdocs";

// ── Types ─────────────────────────────────────────────────────

interface FormState {
  encryptionPassphrase: string;
  gdocsEnabled: boolean;
  gdocsDocId: string;
}

interface BackupScreenProps {
  onClose?: () => void;
  // Set when this screen was opened automatically right after a Google
  // sign-in that found an existing backup for the account — triggers the
  // restore-confirm dialog immediately instead of waiting for the user
  // to tap "Restore from Drive" themselves.
  autoRestorePrompt?: boolean;
  onAutoRestorePromptHandled?: () => void;
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
    `${describeCounts("follow-ups", c.followUp)}.`
  );
}

// ── Component ─────────────────────────────────────────────────

export function BackupScreen({
  onClose,
  autoRestorePrompt,
  onAutoRestorePromptHandled,
}: BackupScreenProps) {
  const { user } = useAuth();
  const isGoogleUser = user?.providerData.some((p) => p.providerId === "google.com") ?? false;
  const existingConfig = useLiveQuery(() => getConfig(), []);

  const [form, setForm] = useState<FormState>({
    encryptionPassphrase: DEFAULT_APP_CONFIG.encryptionPassphrase,
    gdocsEnabled: DEFAULT_APP_CONFIG.gdocsEnabled,
    gdocsDocId: DEFAULT_APP_CONFIG.gdocsDocId,
  });
  const [initialized, setInitialized] = useState(false);
  const [passphraseVisible, setPassphraseVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const [showGdocsWarning, setShowGdocsWarning] = useState(false);

  // ── File export / import state ─────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: boolean; message: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const pendingImportFileRef = useRef<File | null>(null);

  // Replace-vs-merge confirm, shared by file and GDocs import. Holds which
  // kind triggered it, plus whether local data exists (decides which
  // buttons to show — there's nothing to "replace" on an empty device).
  const [showImportConfirm, setShowImportConfirm] = useState<"file" | "gdocs" | null>(null);
  const [importConfirmHasLocalData, setImportConfirmHasLocalData] = useState(false);

  // ── GDocs state ───────────────────────────────────────────
  const [gdocsExporting, setGdocsExporting] = useState(false);
  const [gdocsImporting, setGdocsImporting] = useState(false);
  const [gdocsResult, setGdocsResult] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Populate form from Dexie ──────────────────────────────
  useEffect(() => {
    if (!existingConfig || initialized) return;
    setForm({
      encryptionPassphrase: existingConfig.encryptionPassphrase,
      gdocsEnabled: existingConfig.gdocsEnabled,
      gdocsDocId: existingConfig.gdocsDocId,
    });
    setInitialized(true);
  }, [existingConfig, initialized]);

  // ── Cold-start remote fallback ─────────────────────────────
  // Settings normally pulls these fields down from Firestore right after
  // sign-in. But Backup is now reachable without ever opening Settings —
  // e.g. a returning user, already signed in from a previous session, who
  // taps the Backup icon directly on a device that's never synced. Catch
  // that one gap: if we're signed in and have nothing locally, try once.
  const remoteCheckedRef = useRef(false);
  useEffect(() => {
    if (!user || !initialized || remoteCheckedRef.current) return;
    remoteCheckedRef.current = true;
    if (form.encryptionPassphrase.trim() || form.gdocsDocId.trim()) return;
    void (async () => {
      try {
        const remote = await loadRemoteSettings(user.uid);
        if (Object.keys(remote).length === 0) return;
        await saveConfig(remote);
        setForm((f) => ({
          encryptionPassphrase: remote.encryptionPassphrase ?? f.encryptionPassphrase,
          gdocsEnabled: remote.gdocsEnabled ?? f.gdocsEnabled,
          gdocsDocId: remote.gdocsDocId ?? f.gdocsDocId,
        }));
      } catch (err) {
        console.error("Remote backup settings fallback sync failed:", err);
      }
    })();
    // form.* deliberately omitted: this is a one-shot check (remoteCheckedRef),
    // not something that should re-run as the user edits the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, initialized]);

  // ── Auto-trigger the restore prompt right after sign-in ────
  const autoPromptHandledRef = useRef(false);
  useEffect(() => {
    if (!autoRestorePrompt || !initialized || autoPromptHandledRef.current) return;
    autoPromptHandledRef.current = true;
    onAutoRestorePromptHandled?.();
    if (form.gdocsDocId.trim() && form.encryptionPassphrase.trim() && isGoogleUser) {
      void openImportConfirm("gdocs");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRestorePrompt, initialized, form.gdocsDocId, form.encryptionPassphrase, isGoogleUser]);

  const set = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
  }, []);

  // ── Save ──────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    try {
      const config = {
        encryptionPassphrase: form.encryptionPassphrase,
        gdocsEnabled: form.gdocsEnabled,
        gdocsDocId: form.gdocsDocId.trim(),
      };
      await saveConfig(config);
      if (user) await saveRemoteSettings(user.uid, config);
      setToastVisible(true);
      setTimeout(() => { setToastVisible(false); onClose?.(); }, 900);
    } catch (err) {
      console.error("Backup settings save failed:", err);
      alert("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Import confirm (shared by file + GDocs) ────────────────

  async function openImportConfirm(kind: "file" | "gdocs") {
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

    } else if (kind === "gdocs") {
      const docId = form.gdocsDocId.trim();
      if (!docId) return;
      setGdocsImporting(true); setGdocsResult(null);
      try {
        const token = await requestDriveToken();
        const encryptedText = await readLatestFromGoogleDoc(docId, token);
        const c = await importFromEncryptedString(encryptedText, form.encryptionPassphrase, mode);
        setGdocsResult({ ok: true, message: describeImport(mode, c) });
      } catch (err) {
        setGdocsResult({ ok: false, message: err instanceof Error ? err.message : "Restore failed." });
      } finally { setGdocsImporting(false); }
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

  // ── GDocs export / import ─────────────────────────────────
  async function handleGdocsExport() {
    if (!form.encryptionPassphrase.trim()) { alert("Please set an encryption passphrase before exporting."); return; }
    setGdocsExporting(true); setGdocsResult(null);
    try {
      const token = await requestDriveToken();

      // Use the silently-stored backup Doc, or auto-create one the very
      // first time. Slate keeps exactly one "Slate Backup" Doc per Google
      // account; its ID lives in settings and syncs across devices.
      let docId = form.gdocsDocId.trim();
      if (!docId) {
        docId = await createBackupDoc(token);
        set("gdocsDocId", docId);
        await saveConfig({ gdocsDocId: docId });
        if (user) await saveRemoteSettings(user.uid, { gdocsDocId: docId });
      }

      const encrypted = await buildEncryptedPayload(form.encryptionPassphrase);
      await appendToGoogleDoc(docId, encrypted, token);
      setGdocsResult({ ok: true, message: "Backed up to Google Drive successfully." });
    } catch (err) {
      setGdocsResult({ ok: false, message: err instanceof Error ? err.message : "Export failed." });
    } finally { setGdocsExporting(false); }
  }

  function handleGdocsImport() {
    const docId = form.gdocsDocId.trim();
    if (!docId) {
      setGdocsResult({ ok: false, message: "No backup found for this account. Back up from another device first, then sign in here to restore." });
      return;
    }
    if (!form.encryptionPassphrase.trim()) { alert("Please enter your encryption passphrase first."); return; }
    setGdocsResult(null);
    void openImportConfirm("gdocs");
  }

  // ── Derived ───────────────────────────────────────────────
  const gdocsBusy = gdocsExporting || gdocsImporting;

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
              Encrypts and decrypts every backup below — both the file and the cloud copy. Stored in
              your Slate account so it is restored automatically on any device you sign in to.
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
                Back up to Google Drive
                <span className="toggle-label-sub">
                  Appends an encrypted copy to a private “Slate Backup” Google Doc
                </span>
              </span>
              <button className="toggle-track" role="switch" aria-checked={form.gdocsEnabled}
                aria-label="Back up to Google Drive"
                onClick={() => {
                  if (form.gdocsEnabled) { set("gdocsEnabled", false); }
                  else { setShowGdocsWarning(true); }
                }}>
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>

          {showGdocsWarning && (
            <div className="ai-warning" role="alert" aria-live="polite">
              <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Privacy notice</p>
              <p>
                This writes an <strong>encrypted</strong> copy of your patient data to a Google Doc in your
                own Google Drive. Your data is encrypted with your passphrase before it leaves this app —
                Google cannot read it.
              </p>
              <p>
                Slate creates a single private <strong>“Slate Backup”</strong> document the first time you
                back up, and only ever touches that one document. No other files in your Drive are accessed.
              </p>
              <div className="ai-warning-actions">
                <button className="btn btn-secondary" onClick={() => setShowGdocsWarning(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => { setShowGdocsWarning(false); set("gdocsEnabled", true); }}>
                  <Check size={14} aria-hidden /> I understand, enable
                </button>
              </div>
            </div>
          )}

          {form.gdocsEnabled && !showGdocsWarning && (
            <div>
              {!isGoogleUser && (
                <div className="gdocs-notice" role="status">
                  <AlertTriangle size={14} aria-hidden />
                  <span>Sign in with Google (in Settings) to use cloud backup.</span>
                </div>
              )}

              {isGoogleUser && (
                <div className="form-section-body" style={{ paddingTop: "0.5rem" }}>
                  <div className="data-action-buttons">
                    <button className="btn btn-secondary data-btn"
                      onClick={handleGdocsExport} disabled={gdocsBusy || !!showImportConfirm}>
                      <Download size={14} aria-hidden />
                      {gdocsExporting ? "Backing up…" : "Backup now"}
                    </button>
                    <button className="btn btn-secondary data-btn"
                      onClick={handleGdocsImport} disabled={gdocsBusy || !!showImportConfirm}>
                      <Upload size={14} aria-hidden />
                      {gdocsImporting ? "Restoring…" : "Restore from Drive"}
                    </button>
                  </div>
                  {gdocsResult && (
                    <p className={gdocsResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.5rem" }}>
                      {gdocsResult.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Replace vs merge confirm — shared by file + GDocs import ── */}
        {showImportConfirm && (
          <div className="ai-warning" role="alert" aria-live="polite" style={{ margin: "0 16px" }}>
            {importConfirmHasLocalData ? (
              <>
                <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> You already have patient data on this device</p>
                <p>
                  <strong>Replace</strong> deletes all current acute referrals, pre-assessments, and
                  follow-ups and swaps in the backup's contents. <strong>Merge</strong> keeps what's
                  already here and adds the backup's records alongside it.
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
                <p>This adds the backup's acute referrals, pre-assessments, and follow-ups to this device.</p>
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

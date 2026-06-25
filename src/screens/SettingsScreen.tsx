// ============================================================
// Slate — SettingsScreen.tsx
// ============================================================
// Six sections:
//   ACCOUNT         — Firebase sign-in / sign-out / account mgmt
//   PROFILE         — clinician name and role
//   APP DEFAULTS    — follow-up offset, notification lead time
//   AI FEATURES     — opt-in toggle + API key
//   DATA            — encryption passphrase, file backup/restore,
//                     CSV export
//   GDOCS INTEGRATION — optional, warning-gated; appends encrypted
//                     backup to a Google Doc the user owns
//
// FILE LOCATION:
//   src/screens/SettingsScreen.tsx
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Eye, EyeOff, AlertTriangle, Check, X,
  LogOut, UserX, Download, Upload, FileDown,
} from "lucide-react";
import {
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  deleteUser,
  type User,
} from "firebase/auth";
import { firebaseAuth } from "../firebase";
import { getConfig, saveConfig, clearAllLocalData } from "../data/repository";
import { loadRemoteSettings, saveRemoteSettings } from "../data/firebaseSync";
import { DEFAULT_APP_CONFIG } from "../data/models";
import { useAuth } from "../hooks/useAuth";
import {
  exportEncrypted,
  importEncrypted,
  exportCsv,
  buildEncryptedPayload,
  importFromEncryptedString,
} from "../utils/exportImport";
import {
  requestDriveToken,
  createBackupDoc,
  appendToGoogleDoc,
  readLatestFromGoogleDoc,
} from "../utils/gdocs";

// ── Types ─────────────────────────────────────────────────────

interface FormState {
  clinicianName: string;
  clinicianRole: string;
  defaultFollowUpHours: number;
  notificationLeadMins: number;
  aiEnabled: boolean;
  anthropicApiKey: string;
  encryptionPassphrase: string;
  gdocsEnabled: boolean;
  gdocsDocId: string;
}

interface SettingsScreenProps {
  // Closes the Settings panel (App balances the browser-history entry).
  onClose?: () => void;
  // Called after a successful sign-out / account deletion, once Firebase
  // sign-out and the local-data wipe have completed. App uses it to
  // recreate a fresh profile and reset the UI without a page reload.
  onSignedOut?: () => void;
}

// ── Firebase error messages ────────────────────────────────────

function firebaseErrorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    switch ((err as { code: string }).code) {
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "Invalid email or password.";
      case "auth/email-already-in-use":
        return "An account with this email already exists.";
      case "auth/weak-password":
        return "Password must be at least 6 characters.";
      case "auth/invalid-email":
        return "Please enter a valid email address.";
      case "auth/too-many-requests":
        return "Too many attempts. Please try again later.";
      case "auth/popup-closed-by-user":
      case "auth/cancelled-popup-request":
        return "Sign-in was cancelled.";
      case "auth/network-request-failed":
        return "Network error. Please check your connection.";
      case "auth/requires-recent-login":
        return "Please sign out and sign back in to perform this action.";
      default:
        return "An error occurred. Please try again.";
    }
  }
  return "An error occurred. Please try again.";
}

// ── Component ─────────────────────────────────────────────────

export function SettingsScreen({ onClose, onSignedOut }: SettingsScreenProps) {
  const { user, loading: authLoading } = useAuth();
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
    gdocsEnabled: DEFAULT_APP_CONFIG.gdocsEnabled,
    gdocsDocId: DEFAULT_APP_CONFIG.gdocsDocId,
  });
  const [initialized, setInitialized] = useState(false);
  const [showAiWarning, setShowAiWarning] = useState(false);
  const [showGdocsWarning, setShowGdocsWarning] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [passphraseVisible, setPassphraseVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  // ── Auth state (Google sign-in only) ──────────────────────
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState("");

  // ── Account management state ──────────────────────────────
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteWorking, setDeleteWorking] = useState(false);

  // ── Data / export / import state ──────────────────────────
  const [exporting, setExporting] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    ok: boolean; message: string;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // ── GDocs state ───────────────────────────────────────────
  const [gdocsExporting, setGdocsExporting] = useState(false);
  const [gdocsImporting, setGdocsImporting] = useState(false);
  const [gdocsResult, setGdocsResult] = useState<{
    ok: boolean; message: string;
  } | null>(null);

  // ── Remote sync ───────────────────────────────────────────
  const hasSyncedRef = useRef(false);

  useEffect(() => {
    if (!user || hasSyncedRef.current) return;
    hasSyncedRef.current = true;
    void (async () => {
      try {
        const remote = await loadRemoteSettings(user.uid);
        if (Object.keys(remote).length > 0) {
          await saveConfig(remote);
          setInitialized(false);
        }
      } catch { /* fail silently */ }
    })();
  }, [user]);

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
      gdocsEnabled: existingConfig.gdocsEnabled,
      gdocsDocId: existingConfig.gdocsDocId,
    });
    setInitialized(true);
  }, [existingConfig, initialized]);

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
        gdocsEnabled: form.gdocsEnabled,
        gdocsDocId: form.gdocsDocId.trim(),
      };
      await saveConfig(config);
      if (user) await saveRemoteSettings(user.uid, config);
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

  // ── Google sign-in (the only sign-in method) ──────────────
  async function handleGoogleSignIn() {
    setAuthWorking(true); setAuthError("");
    try {
      await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
      hasSyncedRef.current = false;
    } catch (err) { setAuthError(firebaseErrorMessage(err)); }
    finally { setAuthWorking(false); }
  }

  async function handleSignOut() {
    try {
      // Sign out of Firebase FIRST, so the session definitely ends even if
      // the local wipe below were to fail. Then clear all on-device data,
      // then hand off to App (onSignedOut) to recreate a fresh profile and
      // reset the UI. No window.location.reload() — that reload is what
      // produced the blank-screen-needing-refresh behaviour.
      await signOut(firebaseAuth);
      await clearAllLocalData();
      onSignedOut?.();
    } catch (err) {
      console.error(err);
      alert("Sign out failed. Please try again.");
    }
  }

  async function handleDeleteAccount(currentUser: User) {
    setDeleteWorking(true);
    try {
      // Delete the Firebase account first (also ends the session), then
      // wipe local data, then let App re-init reactively.
      await deleteUser(currentUser);
      await clearAllLocalData();
      onSignedOut?.();
    } catch (err) {
      setDeleteWorking(false); setShowDeleteConfirm(false);
      alert(firebaseErrorMessage(err));
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

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!form.encryptionPassphrase.trim()) { alert("Please enter your encryption passphrase first."); return; }
    setImporting(true); setImportResult(null);
    try {
      const c = await importEncrypted(file, form.encryptionPassphrase);
      setImportResult({ ok: true, message: `Imported ${c.acute} acute, ${c.preAssess} pre-assessments, ${c.followUp} follow-ups.` });
    } catch (err) {
      setImportResult({ ok: false, message: err instanceof Error ? err.message : "Import failed." });
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  async function handleExportCsv() {
    setExportingCsv(true);
    try { await exportCsv(); }
    catch (err) { console.error(err); alert("CSV export failed. Please try again."); }
    finally { setExportingCsv(false); }
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
        // Persist the new Doc ID immediately (locally + to the account).
        set("gdocsDocId", docId);
        await saveConfig({ gdocsDocId: docId });
        if (user) await saveRemoteSettings(user.uid, { ...form, gdocsDocId: docId });
      }

      const encrypted = await buildEncryptedPayload(form.encryptionPassphrase);
      await appendToGoogleDoc(docId, encrypted, token);
      setGdocsResult({ ok: true, message: "Backup appended to Google Doc successfully." });
    } catch (err) {
      setGdocsResult({ ok: false, message: err instanceof Error ? err.message : "Export failed." });
    } finally { setGdocsExporting(false); }
  }

  async function handleGdocsImport() {
    // The Doc ID is managed silently (stored on first backup, synced across
    // devices via your account). No manual entry.
    const docId = form.gdocsDocId.trim();
    if (!docId) {
      setGdocsResult({ ok: false, message: "No cloud backup found yet — back up first." });
      return;
    }
    if (!form.encryptionPassphrase.trim()) { alert("Please enter your encryption passphrase first."); return; }
    setGdocsImporting(true); setGdocsResult(null);
    try {
      const token = await requestDriveToken();
      const encryptedText = await readLatestFromGoogleDoc(docId, token);
      const c = await importFromEncryptedString(encryptedText, form.encryptionPassphrase);
      setGdocsResult({ ok: true, message: `Imported ${c.acute} acute, ${c.preAssess} pre-assessments, ${c.followUp} follow-ups.` });
    } catch (err) {
      setGdocsResult({ ok: false, message: err instanceof Error ? err.message : "Import failed." });
    } finally { setGdocsImporting(false); }
  }

  // ── Derived ───────────────────────────────────────────────
  const isGoogleUser = user?.providerData.some((p) => p.providerId === "google.com") ?? false;
  const gdocsBusy = gdocsExporting || gdocsImporting;

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

        {/* ── Account ──────────────────────────────── */}
        <section className="form-section" aria-label="Account">
          <div className="form-section-title">Account</div>
          {authLoading ? (
            <p className="form-hint">Loading…</p>
          ) : user ? (
            <div className="form-section-body">
              <p className="auth-signed-in-email">
                <span className="auth-signed-in-badge">✓</span>{user.email ?? "Signed in"}
              </p>
              <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                Settings are synced to your account and restored on any device you sign in to.
              </p>

              {!showSignOutConfirm && !showDeleteConfirm && (
                <button className="btn btn-secondary auth-mgmt-btn"
                  onClick={() => setShowSignOutConfirm(true)}>
                  <LogOut size={14} aria-hidden /> Sign out
                </button>
              )}

              {showSignOutConfirm && (
                <div className="ai-warning" role="alert" aria-live="polite">
                  <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Sign out and delete local data</p>
                  <p>Signing out will permanently delete all patient data and settings stored on this device. Your account and cloud settings are not affected.</p>
                  <p>Make sure you have an encrypted backup before continuing.</p>
                  <div className="ai-warning-actions">
                    <button className="btn btn-secondary" onClick={() => setShowSignOutConfirm(false)}>Cancel</button>
                    <button className="btn btn-danger" onClick={handleSignOut}>Sign out &amp; delete local data</button>
                  </div>
                </div>
              )}

              {!showSignOutConfirm && !showDeleteConfirm && (
                <button className="btn btn-ghost auth-mgmt-btn auth-delete-btn" style={{ marginTop: "0.25rem" }}
                  onClick={() => setShowDeleteConfirm(true)}>
                  <UserX size={14} aria-hidden /> Delete account
                </button>
              )}

              {showDeleteConfirm && (
                <div className="ai-warning" role="alert" aria-live="polite">
                  <p className="ai-warning-title"><AlertTriangle size={16} aria-hidden /> Delete account permanently</p>
                  <p>This will permanently delete your Slate account and all data on this device. This cannot be undone.</p>
                  <div className="ai-warning-actions">
                    <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)} disabled={deleteWorking}>Cancel</button>
                    <button className="btn btn-danger" onClick={() => handleDeleteAccount(user)} disabled={deleteWorking}>
                      {deleteWorking ? "Deleting…" : "Delete account"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Signed-out branch. Wrapped in .form-section-body so the hint text
            // and the Google button get the same 16px horizontal inset as the
            // signed-in branch and the Profile fields below — keeping the whole
            // form left-aligned to one consistent edge.
            <div className="form-section-body">
              <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                Sign in to save your settings securely and restore them on any device.
              </p>

              {/* Google is the only sign-in method offered. */}

              <button className="btn btn-secondary auth-google-btn"
                onClick={handleGoogleSignIn} disabled={authWorking}>
                <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Continue with Google
              </button>

              {authError && <p className="auth-error" style={{ marginTop: "0.5rem" }}>{authError}</p>}
            </div>
          )}
        </section>

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
            <span className="form-hint">Used when Follow-up type is set to Offset.</span>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="s-notif">Notification lead time (minutes)</label>
            <input id="s-notif" className="form-input" type="number" inputMode="numeric" min={0} max={1440}
              value={form.notificationLeadMins} onChange={(e) => set("notificationLeadMins", Number(e.target.value))} />
            <span className="form-hint">How early to send a follow-up reminder.</span>
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
              <p>AI features use <strong>your own Anthropic API key</strong>, stored on this device and synced to your Slate account.</p>
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
              <span className="form-hint">Stored on this device and synced to your account. Never sent to Hypnos Medical servers.</span>
            </div>
          )}
        </section>

        {/* ── Encrypted Backup ─────────────────────────── */}
        {/* One unified section. The passphrase and the on-device file
            backup are ALWAYS visible. The Google Drive cloud backup is
            concealed behind a toggle (warning-gated). There is no manual
            Doc ID: Slate creates and reuses a single private "Slate Backup"
            Google Doc per account, storing its ID silently in settings
            (which sync across devices). */}
        <section className="form-section" aria-label="Encrypted backup">
          <div className="form-section-title">Encrypted Backup</div>

          {/* Passphrase — used to encrypt BOTH the file and cloud backups */}
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
              Encrypts and decrypts every backup below — both the file and the cloud copy. Stored in
              your Slate account so it is restored automatically on any device you sign in to.
            </span>
          </div>

          {/* File backup — always available, no account required */}
          <div className="data-action-row">
            <div className="data-action-group">
              <p className="data-action-label">Backup file</p>
              <p className="form-hint">Export all patient data as an encrypted file. Import it to restore on a new device or browser.</p>
              <div className="data-action-buttons">
                <button className="btn btn-secondary data-btn" onClick={handleExportEncrypted} disabled={exporting || importing}>
                  <Download size={14} aria-hidden />{exporting ? "Exporting…" : "Export backup"}
                </button>
                <button className="btn btn-secondary data-btn"
                  onClick={() => { setImportResult(null); importInputRef.current?.click(); }}
                  disabled={importing || exporting}>
                  <Upload size={14} aria-hidden />{importing ? "Importing…" : "Import backup"}
                </button>
                <input ref={importInputRef} type="file" accept=".slate" style={{ display: "none" }} onChange={handleImportFile} />
              </div>
              {importResult && (
                <p className={importResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.4rem" }}>
                  {importResult.message}
                </p>
              )}
            </div>
          </div>

          {/* Cloud backup toggle — conceals the Google Drive options below.
              A top border separates it from the file backup above. */}
          <div className="form-field" style={{ borderTop: "1px solid var(--border)", paddingTop: "0.85rem", marginTop: "0.5rem" }}>
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
              <p>
                Backups are appended, never overwritten, so previous exports are preserved. This feature
                requires signing in with Google.
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
              {/* Cloud backup needs a Google-authenticated session for Drive access */}
              {!isGoogleUser && (
                <div className="gdocs-notice" role="status">
                  <AlertTriangle size={14} aria-hidden />
                  <span>
                    {user
                      ? "Cloud backup needs Google sign-in. Sign out and choose “Continue with Google” to use it."
                      : "Sign in with Google (in the Account section above) to use cloud backup."}
                  </span>
                </div>
              )}

              {isGoogleUser && (
                <div className="data-action-row" style={{ marginTop: 0, borderTop: "none" }}>
                  <div className="data-action-group">
                    <p className="data-action-label">Google Drive backup</p>
                    <p className="form-hint">
                      Slate manages the backup document automatically — there is nothing to configure.
                    </p>
                    <div className="data-action-buttons">
                      <button className="btn btn-secondary data-btn"
                        onClick={handleGdocsExport} disabled={gdocsBusy}>
                        <Download size={14} aria-hidden />
                        {gdocsExporting ? "Backing up…" : "Back up now"}
                      </button>
                      <button className="btn btn-secondary data-btn"
                        onClick={handleGdocsImport} disabled={gdocsBusy || !form.gdocsDocId.trim()}>
                        <Upload size={14} aria-hidden />
                        {gdocsImporting ? "Restoring…" : "Restore from Drive"}
                      </button>
                    </div>
                    {!form.gdocsDocId.trim() && (
                      <p className="form-hint" style={{ marginTop: "0.4rem" }}>
                        Restore becomes available after your first backup.
                      </p>
                    )}
                    {gdocsResult && (
                      <p className={gdocsResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.5rem" }}>
                        {gdocsResult.message}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── CSV Export ──────────────────────────────── */}
        {/* Kept SEPARATE from Encrypted Backup on purpose: CSV is plain-text
            patient data for spreadsheets and is NOT encrypted. */}
        <section className="form-section" aria-label="CSV export">
          <div className="form-section-title">CSV Export</div>
          <div className="form-section-body">
            <p className="data-action-label">Export CSV (unencrypted)</p>
            <p className="form-hint">
              Export all records (including archived) as three CSV files in a zip, suitable for
              spreadsheets. This file is <strong>not encrypted</strong>. There is no CSV import.
            </p>
            <button className="btn btn-secondary data-btn" onClick={handleExportCsv} disabled={exportingCsv}>
              <FileDown size={14} aria-hidden />{exportingCsv ? "Exporting…" : "Export CSV"}
            </button>
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

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
  LogOut, UserX, KeyRound, Download, Upload, FileDown,
} from "lucide-react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  updatePassword,
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
  parseGoogleDocId,
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
  onClose?: () => void;
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

export function SettingsScreen({ onClose }: SettingsScreenProps) {
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

  // ── Auth form state ───────────────────────────────────────
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState("");

  // ── Account management state ──────────────────────────────
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [passwordChangeError, setPasswordChangeError] = useState("");
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
        gdocsDocId: parseGoogleDocId(form.gdocsDocId),
      };
      await saveConfig(config);
      if (user) await saveRemoteSettings(user.uid, config);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 2000);
    } catch (err) {
      console.error("Settings save failed:", err);
      alert("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Email auth ────────────────────────────────────────────
  async function handleEmailAuth() {
    if (!email.trim() || !password) { setAuthError("Please enter your email and password."); return; }
    if (isCreatingAccount && password !== confirmPassword) { setAuthError("Passwords do not match."); return; }
    setAuthWorking(true); setAuthError("");
    try {
      if (isCreatingAccount) {
        await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
      }
      hasSyncedRef.current = false;
      setEmail(""); setPassword(""); setConfirmPassword(""); setIsCreatingAccount(false);
    } catch (err) { setAuthError(firebaseErrorMessage(err)); }
    finally { setAuthWorking(false); }
  }

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
      await clearAllLocalData();
      await signOut(firebaseAuth);
      window.location.reload();
    } catch (err) { console.error(err); alert("Sign out failed. Please try again."); }
  }

  async function handleChangePassword() {
    if (newPassword.length < 6) { setPasswordChangeError("Password must be at least 6 characters."); return; }
    if (newPassword !== confirmNewPassword) { setPasswordChangeError("Passwords do not match."); return; }
    if (!firebaseAuth.currentUser) return;
    setPasswordChanging(true); setPasswordChangeError("");
    try {
      await updatePassword(firebaseAuth.currentUser, newPassword);
      setShowChangePassword(false); setNewPassword(""); setConfirmNewPassword("");
    } catch (err) { setPasswordChangeError(firebaseErrorMessage(err)); }
    finally { setPasswordChanging(false); }
  }

  async function handleDeleteAccount(currentUser: User) {
    setDeleteWorking(true);
    try {
      await clearAllLocalData();
      await deleteUser(currentUser);
      window.location.reload();
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

      // Auto-create the backup Doc if no ID is configured yet.
      let docId = parseGoogleDocId(form.gdocsDocId);
      if (!docId) {
        docId = await createBackupDoc(token);
        // Save the new Doc ID to settings immediately.
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
    const docId = parseGoogleDocId(form.gdocsDocId);
    if (!docId) { alert("Please enter a Google Doc ID first."); return; }
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
  const isEmailProvider = user?.providerData.some((p) => p.providerId === "password") ?? false;
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
            <div>
              <p className="auth-signed-in-email">
                <span className="auth-signed-in-badge">✓</span>{user.email ?? "Signed in"}
              </p>
              <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                Settings are synced to your account and restored on any device you sign in to.
              </p>

              {isEmailProvider && !showChangePassword && !showSignOutConfirm && !showDeleteConfirm && (
                <button className="btn btn-secondary auth-mgmt-btn"
                  onClick={() => { setShowChangePassword(true); setPasswordChangeError(""); setNewPassword(""); setConfirmNewPassword(""); }}>
                  <KeyRound size={14} aria-hidden /> Change password
                </button>
              )}

              {showChangePassword && (
                <div className="auth-panel">
                  <div className="form-field">
                    <label className="form-label" htmlFor="s-newpw">New password</label>
                    <input id="s-newpw" className="form-input" type="password" value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" autoCapitalize="off" />
                  </div>
                  <div className="form-field">
                    <label className="form-label" htmlFor="s-newpw2">Confirm new password</label>
                    <input id="s-newpw2" className="form-input" type="password" value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)} autoComplete="new-password" autoCapitalize="off" />
                  </div>
                  {passwordChangeError && <p className="auth-error">{passwordChangeError}</p>}
                  <div className="auth-panel-actions">
                    <button className="btn btn-ghost" onClick={() => setShowChangePassword(false)}>Cancel</button>
                    <button className="btn btn-primary" onClick={handleChangePassword} disabled={passwordChanging}>
                      {passwordChanging ? "Saving…" : "Save new password"}
                    </button>
                  </div>
                </div>
              )}

              {!showSignOutConfirm && !showDeleteConfirm && !showChangePassword && (
                <button className="btn btn-secondary auth-mgmt-btn" style={{ marginTop: "0.5rem" }}
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

              {!showSignOutConfirm && !showDeleteConfirm && !showChangePassword && (
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
            <div>
              <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                Sign in to save your settings securely and restore them on any device.
              </p>
              <div className="auth-tab-row">
                <button className={`auth-tab${!isCreatingAccount ? " active" : ""}`}
                  onClick={() => { setIsCreatingAccount(false); setAuthError(""); }}>Sign in</button>
                <button className={`auth-tab${isCreatingAccount ? " active" : ""}`}
                  onClick={() => { setIsCreatingAccount(true); setAuthError(""); }}>Create account</button>
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="s-email">Email</label>
                <input id="s-email" className="form-input" type="email" inputMode="email"
                  autoComplete="email" autoCapitalize="off" value={email}
                  onChange={(e) => { setEmail(e.target.value); setAuthError(""); }} />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="s-login-pw">Password</label>
                <div className="apikey-row">
                  <input id="s-login-pw" className="form-input"
                    type={showLoginPassword ? "text" : "password"}
                    autoComplete={isCreatingAccount ? "new-password" : "current-password"}
                    autoCapitalize="off" value={password}
                    onChange={(e) => { setPassword(e.target.value); setAuthError(""); }} />
                  <button className="btn-icon-sm" type="button" onClick={() => setShowLoginPassword((v) => !v)}
                    aria-label={showLoginPassword ? "Hide password" : "Show password"}>
                    {showLoginPassword ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                </div>
              </div>
              {isCreatingAccount && (
                <div className="form-field">
                  <label className="form-label" htmlFor="s-login-pw2">Confirm password</label>
                  <input id="s-login-pw2" className="form-input" type="password"
                    autoComplete="new-password" autoCapitalize="off" value={confirmPassword}
                    onChange={(e) => { setConfirmPassword(e.target.value); setAuthError(""); }} />
                </div>
              )}
              {authError && <p className="auth-error">{authError}</p>}
              <button className="btn btn-primary" onClick={handleEmailAuth} disabled={authWorking}
                style={{ width: "100%", marginBottom: "0.75rem" }}>
                {authWorking ? "Please wait…" : isCreatingAccount ? "Create account" : "Sign in"}
              </button>
              <div className="auth-divider"><span>or</span></div>
              <button className="btn btn-secondary auth-google-btn" onClick={handleGoogleSignIn} disabled={authWorking}>
                <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Continue with Google
              </button>
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

        {/* ── Data ─────────────────────────────────────── */}
        <section className="form-section" aria-label="Data">
          <div className="form-section-title">Data</div>

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
              Used to encrypt and decrypt your data backup. Stored in your Slate account so it is
              restored automatically on any device you sign in to.
            </span>
          </div>

          <div className="data-action-row">
            <div className="data-action-group">
              <p className="data-action-label">Encrypted backup</p>
              <p className="form-hint">Export all patient data as an encrypted file. Import to restore on a new device or browser.</p>
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

          <div className="data-action-row" style={{ marginTop: "0.75rem" }}>
            <div className="data-action-group">
              <p className="data-action-label">CSV export</p>
              <p className="form-hint">Export all records (including archived) as three CSV files in a zip. Suitable for spreadsheets. No CSV import.</p>
              <button className="btn btn-secondary data-btn" onClick={handleExportCsv} disabled={exportingCsv}>
                <FileDown size={14} aria-hidden />{exportingCsv ? "Exporting…" : "Export CSV"}
              </button>
            </div>
          </div>
        </section>

        {/* ── GDocs Integration ─────────────────────────── */}
        <section className="form-section" aria-label="GDocs integration">
          <div className="form-section-title">GDocs Integration</div>

          <div className="form-field">
            <div className="toggle-row">
              <span className="toggle-label">
                Enable GDocs Integration
                <span className="toggle-label-sub">
                  Stores an encrypted backup in a Google Doc you own
                </span>
              </span>
              <button className="toggle-track" role="switch" aria-checked={form.gdocsEnabled}
                aria-label="Enable GDocs Integration"
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
                This integration writes an <strong>encrypted</strong> copy of your patient data to a
                Google Doc stored in your own Google Drive. Your data is encrypted with your passphrase
                before leaving this app — Google cannot read it.
              </p>
              <p>
                Enabling this requires a <strong>Google account</strong> and grants Slate read/write
                access to a specific Google Doc. No other files in your Drive are accessed.
              </p>
              <p>
                This is an optional convenience feature for cross-device restore. Backups are appended
                to the Doc (never overwritten) so previous exports are preserved.
              </p>
              <p>
                <strong>Note:</strong> GDocs Integration requires signing in with Google. Email/password
                users will need to switch to Google sign-in to use this feature.
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
              {/* Warning for non-Google users */}
              {user && !isGoogleUser && (
                <div className="gdocs-notice" role="status">
                  <AlertTriangle size={14} aria-hidden />
                  <span>
                    GDocs Integration requires Google sign-in. Sign out and use
                    "Continue with Google" to enable this feature.
                  </span>
                </div>
              )}

              {!user && (
                <div className="gdocs-notice" role="status">
                  <AlertTriangle size={14} aria-hidden />
                  <span>Please sign in with Google to use GDocs Integration.</span>
                </div>
              )}

              {/* Doc ID field */}
              <div className="form-field">
                <label className="form-label" htmlFor="s-gdocs-docid">
                  Google Doc ID or URL
                </label>
                <input id="s-gdocs-docid" className="form-input" type="text"
                  placeholder="Leave blank to auto-create on first export"
                  value={form.gdocsDocId}
                  onChange={(e) => set("gdocsDocId", e.target.value)}
                  autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                <span className="form-hint">
                  Leave blank — Slate will create a "Slate Backup" Google Doc automatically on
                  first export. Or paste a URL / ID of an existing Slate-created Doc.
                </span>
              </div>

              {/* Export / Import buttons */}
              {(user && isGoogleUser) && (
                <div className="data-action-buttons" style={{ marginTop: "0.5rem" }}>
                  <button className="btn btn-secondary data-btn"
                    onClick={handleGdocsExport} disabled={gdocsBusy}>
                    <Download size={14} aria-hidden />
                    {gdocsExporting ? "Exporting…" : "Export to Google Doc"}
                  </button>
                  <button className="btn btn-secondary data-btn"
                    onClick={handleGdocsImport} disabled={gdocsBusy || !form.gdocsDocId.trim()}>
                    <Upload size={14} aria-hidden />
                    {gdocsImporting ? "Importing…" : "Import from Google Doc"}
                  </button>
                </div>
              )}

              {gdocsResult && (
                <p className={gdocsResult.ok ? "data-import-ok" : "auth-error"} style={{ marginTop: "0.5rem" }}>
                  {gdocsResult.message}
                </p>
              )}
            </div>
          )}
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

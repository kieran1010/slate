// ============================================================
// Slate — SettingsScreen.tsx
// ============================================================
// Five sections:
//   ACCOUNT         — Firebase sign-in / sign-out / account mgmt
//   PROFILE         — clinician name and role
//   APP DEFAULTS    — follow-up offset, notification lead time
//   AI FEATURES     — opt-in toggle + API key
//   CSV EXPORT      — unencrypted spreadsheet export
//
// Encrypted backup (passphrase, file backup, Google Drive backup) lives
// in its own screen now — see BackupScreen.tsx, reachable via the icon
// next to this one in the Brand bar.
//
// FILE LOCATION:
//   src/screens/SettingsScreen.tsx
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Eye, EyeOff, AlertTriangle, Check, X,
  LogOut, UserX, FileDown,
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
import { exportCsv } from "../utils/exportImport";
import { GDOCS_SCOPE, cacheDriveToken } from "../utils/gdocs";

// ── Types ─────────────────────────────────────────────────────

interface FormState {
  clinicianName: string;
  clinicianRole: string;
  defaultFollowUpHours: number;
  notificationLeadMins: number;
  aiEnabled: boolean;
  anthropicApiKey: string;
}

interface SettingsScreenProps {
  // Closes the Settings panel (App balances the browser-history entry).
  onClose?: () => void;
  // Called after a successful sign-out / account deletion, once Firebase
  // sign-out and the local-data wipe have completed. App uses it to
  // recreate a fresh profile and reset the UI without a page reload.
  onSignedOut?: () => void;
  // Called after a fresh sign-in (not a routine Settings re-open) once
  // settings have synced and an existing backup was found for the
  // account. App opens the Backup screen so the user can restore it.
  onBackupFound?: () => void;
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

export function SettingsScreen({ onClose, onSignedOut, onBackupFound }: SettingsScreenProps) {
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
  });
  const [initialized, setInitialized] = useState(false);
  const [showAiWarning, setShowAiWarning] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  // ── Auth state (Google sign-in only) ──────────────────────
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState("");

  // ── Account management state ──────────────────────────────
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteWorking, setDeleteWorking] = useState(false);

  // ── CSV export state ───────────────────────────────────────
  const [exportingCsv, setExportingCsv] = useState(false);

  // ── Remote sync ───────────────────────────────────────────
  // Fires once per user session (guarded by hasSyncedRef) when a
  // user object appears, i.e. on sign-in.
  //
  // IMPORTANT: we call setForm directly here rather than using the
  // setInitialized(false) → useLiveQuery → form-population-effect
  // chain. That chain has a timing race: setInitialized(false) causes
  // an immediate React re-render, but useLiveQuery's notification of
  // the Dexie write is asynchronous. The form population effect
  // therefore re-runs with stale existingConfig, populates from the
  // wrong data, and sets initialized back to true — so the subsequent
  // correct Dexie notification is ignored. Calling setForm directly
  // sidesteps that entirely.
  const hasSyncedRef = useRef(false);
  // True only for the sync triggered by an interactive "Continue with
  // Google" click in THIS session — NOT for a sync on a routine Settings
  // open while already signed in. Gates the auto-save/close/backup-lookup
  // sequence below to "right after logging in", as intended.
  const justSignedInRef = useRef(false);
  // Carries a found backup's doc id from the sync below through to
  // handleSave's post-close step (see handleSave).
  const pendingBackupDocIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user || hasSyncedRef.current) return;
    hasSyncedRef.current = true;
    const freshSignIn = justSignedInRef.current;
    justSignedInRef.current = false;
    void (async () => {
      let foundDocId: string | null = null;
      try {
        const remote = await loadRemoteSettings(user.uid);
        if (Object.keys(remote).length > 0) {
          // Persist to Dexie so the data survives Settings closing.
          await saveConfig(remote);
          // Merge remote over defaults and update the form immediately.
          // This is the source of truth — don't wait for useLiveQuery.
          const merged = { ...DEFAULT_APP_CONFIG, ...remote };
          setForm({
            clinicianName:        merged.clinicianName,
            clinicianRole:        merged.clinicianRole,
            defaultFollowUpHours: merged.defaultFollowUpHours,
            notificationLeadMins: merged.notificationLeadMins,
            aiEnabled:            merged.aiEnabled,
            anthropicApiKey:      merged.anthropicApiKey,
          });
          // Backup settings (passphrase/gdocsDocId) live on BackupScreen
          // now, but they're still part of AppConfig and were just
          // persisted to Dexie above — we only need the doc id here, to
          // know whether an existing backup is worth surfacing below.
          foundDocId = merged.gdocsDocId || null;
        }
      } catch (err) {
        // Fail silently — e.g. offline. Local data is unaffected.
        console.error("Remote settings sync failed:", err);
      }

      if (!freshSignIn) return;
      // Right after an interactive sign-in: save and close automatically
      // (the user asked to sign in, not to fill in this form), and if the
      // account already has a backup on file, hand off to Backup so they
      // can choose whether to restore it.
      pendingBackupDocIdRef.current = foundDocId;
      void handleSave();
    })();
    // handleSave deliberately omitted: it closes over `form`, which would
    // re-run this effect on every keystroke. hasSyncedRef already limits
    // this to once per sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // If a sign-in just found an existing backup, hand off to Backup.
        const foundDocId = pendingBackupDocIdRef.current;
        pendingBackupDocIdRef.current = null;
        if (foundDocId) onBackupFound?.();
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
      // Request Drive/Docs access in the same consent screen as sign-in,
      // rather than waiting until the user first opens Backup — one
      // popup covers everything instead of two.
      const provider = new GoogleAuthProvider();
      provider.addScope(GDOCS_SCOPE);
      const result = await signInWithPopup(firebaseAuth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) cacheDriveToken(credential.accessToken);
      hasSyncedRef.current = false;
      justSignedInRef.current = true;
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

        {/* ── CSV Export ──────────────────────────────── */}
        {/* Kept SEPARATE from Backup on purpose: CSV is plain-text patient
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

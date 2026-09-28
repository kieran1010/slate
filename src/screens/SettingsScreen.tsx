// ============================================================
// Slate — SettingsScreen.tsx
// ============================================================
// Five sections:
//   PROFILE         — clinician name and role
//   APP DEFAULTS    — follow-up offset, notification lead time
//   AI FEATURES     — opt-in toggle + API key
//   CSV EXPORT      — unencrypted spreadsheet export
//   ERASE           — wipe everything on this device
//
// There is no account: settings live on this device only, and travel
// between devices inside the encrypted backup (see BackupScreen.tsx).
//
// Encrypted backup (passphrase, file backup, Google Drive backup) lives
// in its own screen now — see BackupScreen.tsx, reachable via the icon
// next to this one in the Brand bar.
//
// FILE LOCATION:
//   src/screens/SettingsScreen.tsx
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Eye, EyeOff, AlertTriangle, Check, X,
  Trash2, FileDown,
} from "lucide-react";
import { getConfig, saveConfig, clearAllLocalData } from "../data/repository";
import { DEFAULT_APP_CONFIG } from "../data/models";
import { exportCsv } from "../utils/exportImport";
import { revokeDriveToken } from "../utils/googleDrive";

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
  // Called after "Erase this device" has wiped all local data. App uses
  // it to recreate a fresh profile and reset the UI without a page reload.
  onDataErased?: () => void;
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
  });
  const [initialized, setInitialized] = useState(false);
  const [showAiWarning, setShowAiWarning] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  // ── Erase-device state ─────────────────────────────────────
  const [showEraseConfirm, setShowEraseConfirm] = useState(false);
  const [erasing, setErasing] = useState(false);

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

        {/* ── Erase this device ────────────────────────── */}
        <section className="form-section" aria-label="Erase this device">
          <div className="form-section-title">Erase this device</div>
          <div className="form-section-body">
            <p className="form-hint">
              Permanently deletes all patient data and settings on this device, including your
              backup passphrase, and disconnects Google Drive. Use this before handing the device
              on. Your Google Drive backup is not affected.
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
                <div className="ai-warning-actions">
                  <button className="btn btn-secondary" onClick={() => setShowEraseConfirm(false)} disabled={erasing}>Cancel</button>
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

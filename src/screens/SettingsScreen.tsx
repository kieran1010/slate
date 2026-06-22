// ============================================================
// Charted PWA — SettingsScreen.tsx
// ============================================================
// Four sections:
//
//   PROFILE     — clinician name and role
//   APP DEFAULTS — follow-up offset, notification lead time
//   AI FEATURES  — opt-in toggle + confidentiality warning +
//                  API key field (shown only after opt-in)
//   DATA         — placeholder for future export feature
//
// AI TOGGLE FLOW:
//   Off → tap toggle → inline warning panel appears
//   Warning: "Cancel" keeps AI off; "I understand" enables it
//   Once on, the API key section is shown
//   Turning AI back off hides the key section but PRESERVES the
//   stored key so the user doesn't have to re-enter it if they
//   re-enable later.
//
// SAVE: one button at the top-right of the screen header saves
// the whole form. A brief "Saved" toast confirms it.
//
// FILE LOCATION:
//   src/screens/SettingsScreen.tsx
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Eye, EyeOff, AlertTriangle, Check } from "lucide-react";
import { getConfig, saveConfig } from "../data/repository";
import { DEFAULT_APP_CONFIG } from "../data/models";

interface FormState {
  clinicianName: string;
  clinicianRole: string;
  defaultFollowUpHours: number;
  notificationLeadMins: number;
  aiEnabled: boolean;
  anthropicApiKey: string;
  googleDocId: string;
}

export function SettingsScreen() {
  const existingConfig = useLiveQuery(() => getConfig(), []);

  const [form, setForm] = useState<FormState>({
    clinicianName: DEFAULT_APP_CONFIG.clinicianName,
    clinicianRole: DEFAULT_APP_CONFIG.clinicianRole,
    defaultFollowUpHours: DEFAULT_APP_CONFIG.defaultFollowUpHours,
    notificationLeadMins: DEFAULT_APP_CONFIG.notificationLeadMins,
    aiEnabled: DEFAULT_APP_CONFIG.aiEnabled,
    anthropicApiKey: DEFAULT_APP_CONFIG.anthropicApiKey,
    googleDocId: DEFAULT_APP_CONFIG.googleDocId,
  });

  const [initialized, setInitialized] = useState(false);
  // Controls whether the inline warning panel is showing (before
  // the user has confirmed they want to enable AI features).
  const [showWarning, setShowWarning] = useState(false);
  // Controls whether the API key is shown as plain text.
  const [keyVisible, setKeyVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  // Populate form from stored config on first load.
  useEffect(() => {
    if (!existingConfig || initialized) return;
    setForm({
      clinicianName: existingConfig.clinicianName,
      clinicianRole: existingConfig.clinicianRole,
      defaultFollowUpHours: existingConfig.defaultFollowUpHours,
      notificationLeadMins: existingConfig.notificationLeadMins,
      aiEnabled: existingConfig.aiEnabled,
      anthropicApiKey: existingConfig.anthropicApiKey,
      googleDocId: existingConfig.googleDocId,
    });
    setInitialized(true);
  }, [existingConfig, initialized]);

  const set = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
  }, []);

  // ── AI toggle ────────────────────────────────────────────────
  function handleAiToggle() {
    if (form.aiEnabled) {
      // Turning OFF: no warning needed, just disable.
      // Key is preserved in form state and will be saved,
      // so re-enabling doesn't require re-entry.
      set("aiEnabled", false);
      setShowWarning(false);
    } else {
      // Turning ON: show the confidentiality warning first.
      setShowWarning(true);
    }
  }

  function handleWarningCancel() {
    setShowWarning(false);
    // Toggle stays off — form.aiEnabled unchanged.
  }

  function handleWarningConfirm() {
    setShowWarning(false);
    set("aiEnabled", true);
  }

  // ── Save ─────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    try {
      await saveConfig({
        clinicianName: form.clinicianName.trim(),
        clinicianRole: form.clinicianRole.trim(),
        defaultFollowUpHours: Math.max(1, Number(form.defaultFollowUpHours) || 24),
        notificationLeadMins: Math.max(0, Number(form.notificationLeadMins) || 60),
        aiEnabled: form.aiEnabled,
        // Trim whitespace from the key; this also catches accidental
        // paste of a key with a trailing newline.
        anthropicApiKey: form.anthropicApiKey.trim(),
        googleDocId: form.googleDocId.trim(),
      });
      // Show the "Saved" toast for 2 seconds.
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 2000);
    } catch (err) {
      console.error("Settings save failed:", err);
      alert("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div>
      {/* ── Screen header ──────────────────────────────────── */}
      <div className="screen-header">
        <h1 className="screen-header-title" style={{ textAlign: "left", flex: 1 }}>
          Settings
        </h1>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
          aria-busy={saving}
          style={{ minWidth: 60 }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="form-body">

        {/* ── Profile ────────────────────────────────────── */}
        <section className="form-section" aria-label="Profile">
          <div className="form-section-title">Profile</div>

          <div className="form-field">
            <label className="form-label" htmlFor="s-name">Your name</label>
            <input
              id="s-name"
              className="form-input"
              type="text"
              placeholder="e.g. Dr Aroha Ngata"
              value={form.clinicianName}
              onChange={(e) => set("clinicianName", e.target.value)}
              autoCapitalize="words"
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="s-role">Role</label>
            <input
              id="s-role"
              className="form-input"
              type="text"
              placeholder="e.g. Anaesthetist"
              value={form.clinicianRole}
              onChange={(e) => set("clinicianRole", e.target.value)}
              autoCapitalize="words"
            />
          </div>
        </section>

        {/* ── App defaults ─────────────────────────────── */}
        <section className="form-section" aria-label="App defaults">
          <div className="form-section-title">App defaults</div>

          <div className="form-field">
            <label className="form-label" htmlFor="s-fuHours">
              Default follow-up period (hours)
            </label>
            <input
              id="s-fuHours"
              className="form-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              value={form.defaultFollowUpHours}
              onChange={(e) =>
                set("defaultFollowUpHours", Number(e.target.value))
              }
            />
            <span className="form-hint">
              Used when Follow-up type is set to Offset.
            </span>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="s-notif">
              Notification lead time (minutes)
            </label>
            <input
              id="s-notif"
              className="form-input"
              type="number"
              inputMode="numeric"
              min={0}
              max={1440}
              value={form.notificationLeadMins}
              onChange={(e) =>
                set("notificationLeadMins", Number(e.target.value))
              }
            />
            <span className="form-hint">
              How early to send a follow-up reminder.
            </span>
          </div>
        </section>

        {/* ── AI features ──────────────────────────────── */}
        <section className="form-section" aria-label="AI features">
          <div className="form-section-title">AI features</div>

          {/* Toggle row */}
          <div className="form-field">
            <div className="toggle-row">
              <span className="toggle-label">
                Enable AI features
                <span className="toggle-label-sub">
                  Allows document import using the Anthropic API
                </span>
              </span>
              <button
                className="toggle-track"
                role="switch"
                aria-checked={form.aiEnabled}
                aria-label="Enable AI features"
                onClick={handleAiToggle}
              >
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>

          {/* Confidentiality warning — shown before the user confirms */}
          {showWarning && (
            <div className="ai-warning" role="alert" aria-live="polite">
              <p className="ai-warning-title">
                <AlertTriangle size={16} aria-hidden />
                Data confidentiality
              </p>
              <p>
                Enabling AI features allows Charted to send clinical text to
                Anthropic's API for processing. This includes any patient
                information visible in the fields you choose to import.
              </p>
              <p>
                You are responsible for ensuring this complies with applicable
                privacy obligations in your jurisdiction, including the NZ
                Health Information Privacy Code. Patient data is subject to
                Anthropic's privacy policy.
              </p>
              <p>
                AI features use <strong>your own Anthropic API key</strong>.
                Your key is stored locally on this device only and is never
                sent to Hypnos Medical servers.
              </p>
              <div className="ai-warning-actions">
                <button
                  className="btn btn-secondary"
                  onClick={handleWarningCancel}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleWarningConfirm}
                >
                  <Check size={14} aria-hidden />
                  I understand
                </button>
              </div>
            </div>
          )}

          {/* API key section — shown only once AI is enabled */}
          {form.aiEnabled && (
            <>
              <div className="form-field">
                <label className="form-label" htmlFor="s-apikey">
                  Anthropic API key
                </label>
                <div className="apikey-row">
                  <input
                    id="s-apikey"
                    className="form-input"
                    // Toggle between password and text so the user can
                    // verify the key without exposing it by default.
                    type={keyVisible ? "text" : "password"}
                    placeholder="sk-ant-…"
                    value={form.anthropicApiKey}
                    onChange={(e) => set("anthropicApiKey", e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    // Monospace makes it easier to spot character errors.
                    style={{ fontFamily: "monospace", letterSpacing: "0.04em" }}
                  />
                  <button
                    className="btn-icon-sm"
                    type="button"
                    onClick={() => setKeyVisible((v) => !v)}
                    aria-label={keyVisible ? "Hide API key" : "Show API key"}
                  >
                    {keyVisible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                </div>
                <span className="form-hint">
                  Keys are stored on this device only. When entering on mobile,
                  watch for OCR character confusion: the letter l, capital I,
                  and digit 1 can look identical in some fonts.
                </span>
              </div>
            </>
          )}
        </section>

        {/* ── Data ─────────────────────────────────────── */}
        <section className="form-section" aria-label="Data">
          <div className="form-section-title">Data</div>
          <div className="form-field">
            <label className="form-label" htmlFor="s-docid">
              Google Doc ID (for export)
            </label>
            <input
              id="s-docid"
              className="form-input"
              type="text"
              placeholder="Paste from your Google Doc URL"
              value={form.googleDocId}
              onChange={(e) => set("googleDocId", e.target.value)}
              autoCorrect="off"
              spellCheck={false}
            />
            <span className="form-hint">
              Export to Google Docs is coming soon.
            </span>
          </div>
        </section>

      </div>

      {/* ── Saved toast ──────────────────────────────────── */}
      <div
        className={`save-toast${toastVisible ? " visible" : ""}`}
        aria-live="polite"
        aria-atomic="true"
      >
        Settings saved
      </div>
    </div>
  );
}

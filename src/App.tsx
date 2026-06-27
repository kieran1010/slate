// ============================================================
// Charted PWA — App.tsx
// ============================================================
// The root component. Owns these responsibilities:
//
//   1. PROFILE GATE — runs ensureActiveProfile() on startup, and
//      again after sign-out (which wipes the profiles table).
//   2. NAVIGATION STATE — a NavState value + history stack for
//      in-app back-button support (Android hardware back key),
//      including the Settings panel.
//   3. SWIPE GESTURES — horizontal swipe on the content area
//      switches between the four main tabs (list views only).
//   4. LAYOUT SHELL — Brand bar (top, with ⚙ settings trigger)
//      + content area + TabBar (bottom). Settings renders as a
//      full-screen modal overlay above the shell.
//
// BACK-BUTTON SEMANTICS (this build):
//   • From a LIST view              → exits the app (browser default).
//   • From a DETAIL view            → back to that tab's list.
//   • From SETTINGS (open)          → closes Settings, revealing the
//                                     screen behind it (never exits).
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { Brand } from "./components/Brand";
import { TabBar } from "./components/TabBar";
import { AcuteListScreen } from "./screens/AcuteListScreen";
import { AcuteDetailScreen } from "./screens/AcuteDetailScreen";
import { PreAssessListScreen } from "./screens/PreAssessListScreen";
import { PreAssessDetailScreen } from "./screens/PreAssessDetailScreen";
import { FollowUpListScreen } from "./screens/FollowUpListScreen";
import { FollowUpDetailScreen } from "./screens/FollowUpDetailScreen";
import { ArchiveScreen } from "./screens/ArchiveScreen";
import { ImportScreen } from "./screens/ImportScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { BackupScreen } from "./screens/BackupScreen";
import { ensureActiveProfile } from "./data/profiles";
import type { Profile } from "./data/db";
import type { NavState, Tab, NavigateFn } from "./types/nav";

const APP_NAME = "Slate";

// Tab order used for swipe-to-switch-tab gesture.
const TABS_ORDER: Tab[] = ["pre-assess", "follow-up", "acute", "archive"];

// Minimum horizontal pixel distance to register as a swipe.
const SWIPE_THRESHOLD = 60;

// ── Local data warning banner ──────────────────────────────────
// Shown at the top of the app until the user dismisses it.
// Dismissal is permanent (stored in localStorage).
function LocalDataBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="local-data-banner" role="status" aria-live="polite">
      <p className="local-data-banner-text">
        <strong>Data is stored locally on this device only unless you log in and manually back up.</strong>{" "}
        Encrypted cloud backup and multi-device sync are coming in a future release.
      </p>
      <button
        className="local-data-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss this notice"
      >
        ✕
      </button>
    </div>
  );
}

export default function App() {
  // ── Profile gate ───────────────────────────────────────────
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    ensureActiveProfile().then(setProfile).catch(console.error);
  }, []);

  // ── Navigation state ───────────────────────────────────────
  const [nav, setNav] = useState<NavState>({ tab: "pre-assess", view: "list" });

  // Ref kept in sync with nav so event listeners and callbacks
  // can always read the current value without stale closures.
  const navRef = useRef<NavState>({ tab: "pre-assess", view: "list" });
  useEffect(() => { navRef.current = nav; }, [nav]);

  // Internal history stack for the Android hardware back key and
  // the in-app Back button. Each "navigate to detail" push pushes
  // the previous NavState here and calls window.history.pushState
  // so the popstate event fires when the hardware back key is pressed.
  const navHistoryRef = useRef<NavState[]>([]);

  // Set to true before calling window.history.back() ourselves so the
  // resulting popstate event is ignored (we've already updated state —
  // no need to act on it again).
  const suppressNextPopState = useRef(false);

  // ── Settings modal ─────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Ref mirror of settingsOpen so the once-mounted popstate listener
  // (which closes over the initial value) can read the current state.
  const settingsOpenRef = useRef(false);
  useEffect(() => { settingsOpenRef.current = settingsOpen; }, [settingsOpen]);

  // ── Backup modal ───────────────────────────────────────────
  const [backupOpen, setBackupOpen] = useState(false);
  const backupOpenRef = useRef(false);
  useEffect(() => { backupOpenRef.current = backupOpen; }, [backupOpen]);
  // Set when Settings just found an existing cloud backup right after a
  // fresh Google sign-in — tells BackupScreen to prompt to restore it
  // immediately instead of waiting for the user to tap "Restore from Drive".
  const [autoRestorePrompt, setAutoRestorePrompt] = useState(false);

  // ── Local data warning banner ──────────────────────────────
  // Shown until the user dismisses it; dismissal is stored in
  // localStorage so it survives reloads and never reappears on
  // the same browser. Separate from the profile/settings system
  // so it works before auth exists.
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(
    () => localStorage.getItem("slateLocalDataWarningDismissed") === "1"
  );

  function dismissBanner() {
    localStorage.setItem("slateLocalDataWarningDismissed", "1");
    setBannerDismissed(true);
  }

  // ── Touch tracking (swipe gestures) ───────────────────────
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // ── Android back-key handler ───────────────────────────────
  useEffect(() => {
    // Replace the initial browser history entry with one we can
    // identify. This does NOT add an entry — it just tags the one
    // already there, so pressing back from the very first screen
    // exits the PWA as expected.
    window.history.replaceState({ slateNav: true, depth: 0 }, "");

    const handlePopState = () => {
      // Suppress if this popstate was triggered by our own
      // window.history.back() call (goBack / closeSettings).
      if (suppressNextPopState.current) {
        suppressNextPopState.current = false;
        return;
      }

      // PRIORITY 1 — Backup open: hardware-back closes it the same way
      // Settings does (checked first since Backup can briefly sit on top
      // of Settings during the auto-open-after-sign-in flow).
      if (backupOpenRef.current) {
        setBackupOpen(false);
        return;
      }

      // PRIORITY 1b — Settings open: hardware-back closes it and
      // reveals whatever screen is behind, instead of navigating or
      // exiting. The history entry pushed when Settings opened has
      // already been consumed by THIS popstate, so we just flip state.
      if (settingsOpenRef.current) {
        setSettingsOpen(false);
        return;
      }

      // PRIORITY 2 — In-app detail history: step back one screen.
      if (navHistoryRef.current.length > 0) {
        const prev = navHistoryRef.current[navHistoryRef.current.length - 1];
        navHistoryRef.current = navHistoryRef.current.slice(0, -1);
        setNav(prev);

        // If there is still more in-app history, push another browser
        // state entry so the NEXT back press is also intercepted. If
        // not, don't push — letting the next back press exit the PWA.
        if (navHistoryRef.current.length > 0) {
          window.history.pushState(
            { slateNav: true, depth: navHistoryRef.current.length },
            ""
          );
        }
      }
      // PRIORITY 3 — Nothing to go back to (a list view): let the
      // browser handle the event, which exits the PWA on Android.
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []); // runs once on mount

  // ── Navigation helpers ─────────────────────────────────────

  // navigate() is passed down to screens. When navigating TO a
  // detail screen, we push the current state onto the internal
  // history stack and also push a browser history entry so the
  // Android back key triggers popstate. Tab switches and list
  // navigations clear the history (we're at root level).
  const navigate: NavigateFn = useCallback((to) => {
    if ("view" in to && to.view === "detail") {
      const current = navRef.current;
      // Arriving at a detail screen FROM the import screen is a one-way
      // flow (extract → review → done) — the import screen itself is
      // never worth going back to. Treat the list as the back-target
      // instead, so Back/Save after reviewing an imported record lands
      // on the list rather than re-opening a blank import screen.
      const backTarget: NavState =
        "view" in current && current.view === "import"
          ? { tab: current.tab, view: "list" }
          : current;
      navHistoryRef.current = [...navHistoryRef.current, backTarget];
      window.history.pushState(
        { slateNav: true, depth: navHistoryRef.current.length },
        ""
      );
    }
    setNav(to);
  }, []); // stable — reads nav via navRef

  // goBack() is passed to screens that render an in-app Back
  // button (detail screens). It pops the internal history AND
  // calls window.history.back() to keep the browser in sync,
  // suppressing the resulting popstate so we don't navigate twice.
  const goBack = useCallback(() => {
    if (navHistoryRef.current.length > 0) {
      const prev = navHistoryRef.current[navHistoryRef.current.length - 1];
      navHistoryRef.current = navHistoryRef.current.slice(0, -1);
      setNav(prev);
      suppressNextPopState.current = true;
      window.history.back();
    } else {
      // Fallback: return to the list of the current tab.
      const { tab } = navRef.current;
      if (tab !== "archive") {
        setNav({ tab, view: "list" });
      }
    }
  }, []);

  // selectTab() is used by the TabBar and swipe handler. Clears
  // the history stack because we're returning to root level.
  const selectTab = useCallback((tab: Tab) => {
    navHistoryRef.current = [];
    setNav({ tab, view: "list" } as NavState);
  }, []);

  // ── Settings open / close ──────────────────────────────────

  // Opening Settings pushes a browser history entry so the Android
  // hardware back key closes the panel (handled in popstate above)
  // rather than navigating away or exiting the app.
  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    window.history.pushState({ slateNav: true, settings: true }, "");
  }, []);

  // Closing Settings from within the app (the ✕ button, the auto-close
  // after Save, or after sign-out) pops the entry we pushed on open so
  // browser history stays balanced. suppressNextPopState stops that
  // synthetic popstate from being treated as a back navigation.
  const closeSettings = useCallback(() => {
    if (settingsOpenRef.current) {
      suppressNextPopState.current = true;
      window.history.back();
    }
    setSettingsOpen(false);
  }, []);

  // ── Backup open / close ─────────────────────────────────────
  // Mirrors Settings open/close above — same history push/pop dance so
  // the Android hardware back key closes Backup instead of navigating
  // away or exiting the app.
  const openBackup = useCallback(() => {
    setBackupOpen(true);
    window.history.pushState({ slateNav: true, backup: true }, "");
  }, []);

  const closeBackup = useCallback(() => {
    if (backupOpenRef.current) {
      suppressNextPopState.current = true;
      window.history.back();
    }
    setBackupOpen(false);
  }, []);

  // Called by SettingsScreen right after a fresh sign-in finds an
  // existing backup for the account. Settings has already saved and
  // closed itself by this point — open Backup with the auto-restore
  // prompt armed so the user can choose whether to restore it.
  const handleBackupFound = useCallback(() => {
    setAutoRestorePrompt(true);
    openBackup();
  }, [openBackup]);

  // ── Reactive sign-out / account-deletion re-init ───────────
  // Called by SettingsScreen AFTER it has signed out of Firebase and
  // cleared all local data (including the profiles table). Because the
  // profile is gone, we recreate a fresh one, reset navigation to the
  // default tab, and close Settings — all via React state, with NO
  // window.location.reload(). The previous reload approach is what
  // produced the blank-screen-needing-refresh behaviour.
  const handleSignedOut = useCallback(async () => {
    navHistoryRef.current = [];
    setNav({ tab: "pre-assess", view: "list" });
    // CRITICAL: set profile to null FIRST so the loading gate renders
    // immediately. Without this, the Acute list screen re-renders on the
    // now-empty DB before ensureActiveProfile() has run, which throws
    // "No active profile" and leaves a white screen.
    setProfile(null);
    closeSettings();
    try {
      const fresh = await ensureActiveProfile();
      setProfile(fresh);
    } catch (err) {
      console.error("Re-init after sign-out failed:", err);
    }
  }, [closeSettings]);

  // ── Swipe-to-switch-tab ────────────────────────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current) return;
      const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
      const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      // Ignore if the gesture is not primarily horizontal, or
      // below the minimum distance threshold.
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;

      // Only switch tabs when at a list view — not inside a detail
      // or import screen where horizontal swiping may have meaning.
      const current = navRef.current;
      if (!("view" in current) || current.view !== "list") return;

      const idx = TABS_ORDER.indexOf(current.tab);
      if (idx === -1) return;

      if (dx < 0 && idx < TABS_ORDER.length - 1) {
        selectTab(TABS_ORDER[idx + 1]); // swipe left → next tab
      } else if (dx > 0 && idx > 0) {
        selectTab(TABS_ORDER[idx - 1]); // swipe right → previous tab
      }
    },
    [selectTab]
  );

  // ── Screen renderer ────────────────────────────────────────
  function renderScreen() {
    switch (nav.tab) {
      case "acute":
        if (nav.view === "detail") {
          return <AcuteDetailScreen id={nav.id} navigate={navigate} goBack={goBack} />;
        }
        if (nav.view === "import") {
          return <ImportScreen module="acute" navigate={navigate} goBack={goBack} />;
        }
        return <AcuteListScreen navigate={navigate} />;

      case "pre-assess":
        if (nav.view === "detail") {
          return <PreAssessDetailScreen id={nav.id} navigate={navigate} goBack={goBack} />;
        }
        if (nav.view === "import") {
          return <ImportScreen module="pre-assess" navigate={navigate} goBack={goBack} />;
        }
        return <PreAssessListScreen navigate={navigate} />;

      case "follow-up":
        if (nav.view === "detail") {
          return (
            <FollowUpDetailScreen
              id={nav.id}
              draftSource={nav.draftSource}
              navigate={navigate}
              goBack={goBack}
            />
          );
        }
        if (nav.view === "import") {
          return <ImportScreen module="follow-up" navigate={navigate} goBack={goBack} />;
        }
        return <FollowUpListScreen navigate={navigate} />;

      case "archive":
        return <ArchiveScreen />;
    }
  }

  // ── Loading gate ───────────────────────────────────────────
  if (!profile) {
    return (
      <div className="app-shell">
        <Brand appName={APP_NAME} onSettingsOpen={openSettings} onBackupOpen={openBackup} />
        {!bannerDismissed && (
          <LocalDataBanner onDismiss={dismissBanner} />
        )}
        <div className="loading-screen" aria-live="polite">
          Starting up…
        </div>
      </div>
    );
  }

  // ── Main shell ─────────────────────────────────────────────
  return (
    <div className="app-shell">
      <Brand appName={APP_NAME} onSettingsOpen={openSettings} onBackupOpen={openBackup} />

      {/* Local data warning — shown until permanently dismissed */}
      {!bannerDismissed && (
        <LocalDataBanner onDismiss={dismissBanner} />
      )}

      {/* Content area. Touch handlers here (not on the whole shell)
          so the Brand bar and TabBar don't participate in swipes. */}
      <main
        className="app-content"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {renderScreen()}
      </main>

      <TabBar active={nav.tab} onSelect={selectTab} />

      {/* Settings modal — full-screen overlay above the shell.
          Rendered here (not inside <main>) so it covers the
          TabBar and Brand bar too. */}
      {settingsOpen && (
        <div
          className="settings-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
        >
          <SettingsScreen
            onClose={closeSettings}
            onSignedOut={handleSignedOut}
            onBackupFound={handleBackupFound}
          />
        </div>
      )}

      {/* Backup modal — same full-screen overlay treatment as Settings.
          Rendered after it in the DOM so it sits on top during the
          brief window both can be open (auto-open right after sign-in). */}
      {backupOpen && (
        <div
          className="settings-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Backup"
        >
          <BackupScreen
            onClose={closeBackup}
            autoRestorePrompt={autoRestorePrompt}
            onAutoRestorePromptHandled={() => setAutoRestorePrompt(false)}
          />
        </div>
      )}
    </div>
  );
}

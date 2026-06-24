// ============================================================
// Charted PWA — App.tsx
// ============================================================
// The root component. Owns four responsibilities:
//
//   1. PROFILE GATE — runs ensureActiveProfile() on startup.
//   2. NAVIGATION STATE — a NavState value + history stack for
//      in-app back-button support (Android hardware back key).
//   3. SWIPE GESTURES — horizontal swipe on the content area
//      switches between the four main tabs (list views only).
//   4. LAYOUT SHELL — Brand bar (top, with ⚙ settings trigger)
//      + content area + TabBar (bottom). Settings renders as a
//      full-screen modal overlay above the shell.
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
import { ensureActiveProfile } from "./data/profiles";
import type { Profile } from "./data/db";
import type { NavState, Tab, NavigateFn } from "./types/nav";

const APP_NAME = "Slate";

// Tab order used for swipe-to-switch-tab gesture.
const TABS_ORDER: Tab[] = ["acute", "pre-assess", "follow-up", "archive"];

// Minimum horizontal pixel distance to register as a swipe.
const SWIPE_THRESHOLD = 60;

// ── Local data warning banner ──────────────────────────────────
// Shown at the top of the app until the user dismisses it.
// Dismissal is permanent (stored in localStorage).
function LocalDataBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="local-data-banner" role="status" aria-live="polite">
      <p className="local-data-banner-text">
        <strong>Data is stored locally on this device only.</strong>{" "}
        Secure login, encrypted cloud backup and multi-device sync are coming
        in a future release.
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
  const [nav, setNav] = useState<NavState>({ tab: "acute", view: "list" });

  // Ref kept in sync with nav so event listeners and callbacks
  // can always read the current value without stale closures.
  const navRef = useRef<NavState>({ tab: "acute", view: "list" });
  useEffect(() => { navRef.current = nav; }, [nav]);

  // Internal history stack for the Android hardware back key and
  // the in-app Back button. Each "navigate to detail" push pushes
  // the previous NavState here and calls window.history.pushState
  // so the popstate event fires when the hardware back key is pressed.
  const navHistoryRef = useRef<NavState[]>([]);

  // Set to true before calling window.history.back() from the
  // in-app back button so the resulting popstate event is ignored
  // (we've already navigated — no need to do it again).
  const suppressNextPopState = useRef(false);

  // ── Settings modal ─────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      // window.history.back() call in goBack().
      if (suppressNextPopState.current) {
        suppressNextPopState.current = false;
        return;
      }

      if (navHistoryRef.current.length > 0) {
        // Navigate back within the app.
        const prev = navHistoryRef.current[navHistoryRef.current.length - 1];
        navHistoryRef.current = navHistoryRef.current.slice(0, -1);
        setNav(prev);

        // If there is still more in-app history, push another
        // browser state entry so the NEXT back press is also
        // intercepted. If not, don't push — letting the next
        // back press exit the PWA naturally.
        if (navHistoryRef.current.length > 0) {
          window.history.pushState(
            { slateNav: true, depth: navHistoryRef.current.length },
            ""
          );
        }
      }
      // If history is empty, let the browser handle the event
      // (which exits the PWA on Android).
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
      navHistoryRef.current = [...navHistoryRef.current, navRef.current];
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
      // (Should not normally be reached since goBack is only shown
      // in detail screens, which always have history.)
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
        <Brand appName={APP_NAME} onSettingsOpen={() => setSettingsOpen(true)} />
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
      <Brand appName={APP_NAME} onSettingsOpen={() => setSettingsOpen(true)} />

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
          <SettingsScreen onClose={() => setSettingsOpen(false)} />
        </div>
      )}
    </div>
  );
}

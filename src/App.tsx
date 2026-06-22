// ============================================================
// Charted PWA — App.tsx
// ============================================================
// The root component. Owns three things:
//   1. Profile gate: runs ensureActiveProfile() on startup so
//      there is always an active profile before any screen mounts.
//   2. Navigation state: a single NavState value that describes
//      what is on screen. Screens receive a `navigate` callback
//      and call it — they never touch this state directly.
//   3. Layout shell: Brand bar (top) + content area (scrollable)
//      + TabBar (bottom). Content area renders the current screen.
// ============================================================

import { useState, useEffect } from "react";
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

// ── Placeholder: replace with the final name when decided ──
const APP_NAME = "Slate";

export default function App() {
  // null = not yet loaded; Profile = ready.
  const [profile, setProfile] = useState<Profile | null>(null);

  // Start on the Acute list — most urgent module first.
  const [nav, setNav] = useState<NavState>({ tab: "acute", view: "list" });

  // Ensure there is always an active profile before anything renders.
  // ensureActiveProfile() creates a default one if none exists, so
  // this never blocks the user on first launch.
  useEffect(() => {
    ensureActiveProfile().then(setProfile).catch(console.error);
  }, []);

  // ── Navigation helpers ─────────────────────────────────────
  const navigate: NavigateFn = (to) => setNav(to);

  // "Back" always returns to the list view of the current tab.
  const goBack = () => {
    const { tab } = nav;
    if (tab === "settings") {
      setNav({ tab: "settings", view: "main" });
    } else {
      setNav({ tab: tab as Exclude<Tab, "settings">, view: "list" });
    }
  };

  // Switching tabs always lands on that tab's list.
  const selectTab = (tab: Tab) => {
    if (tab === "settings") {
      setNav({ tab: "settings", view: "main" });
    } else {
      setNav({ tab, view: "list" });
    }
  };

  // ── Screen renderer ────────────────────────────────────────
  function renderScreen() {
    switch (nav.tab) {
      case "acute":
        if (nav.view === "detail") {
          return <AcuteDetailScreen id={nav.id} navigate={navigate} goBack={goBack} />;
        }
        if (nav.view === "archive") return <ArchiveScreen goBack={goBack} />;
        if (nav.view === "import")  return <ImportScreen module="acute" navigate={navigate} goBack={goBack} />;
        return <AcuteListScreen navigate={navigate} />;

      case "pre-assess":
        if (nav.view === "detail") {
          return <PreAssessDetailScreen id={nav.id} navigate={navigate} goBack={goBack} />;
        }
        if (nav.view === "archive") return <ArchiveScreen goBack={goBack} />;
        if (nav.view === "import")  return <ImportScreen module="pre-assess" navigate={navigate} goBack={goBack} />;
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
        if (nav.view === "archive") return <ArchiveScreen goBack={goBack} />;
        if (nav.view === "import")  return <ImportScreen module="follow-up" navigate={navigate} goBack={goBack} />;
        return <FollowUpListScreen navigate={navigate} />;

      case "settings":
        return <SettingsScreen />;
    }
  }

  // ── Loading gate ───────────────────────────────────────────
  // Shown for the fraction of a second before IndexedDB opens.
  // Once the profile is ready, the full shell mounts.
  if (!profile) {
    return (
      <div className="app-shell">
        <Brand appName={APP_NAME} />
        <div className="loading-screen" aria-live="polite">
          Starting up…
        </div>
      </div>
    );
  }

  // ── Main shell ─────────────────────────────────────────────
  return (
    <div className="app-shell">
      <Brand appName={APP_NAME} />
      <main className="app-content">{renderScreen()}</main>
      <TabBar active={nav.tab} onSelect={selectTab} />
    </div>
  );
}

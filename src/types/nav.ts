// ============================================================
// Charted PWA — types/nav.ts
// ============================================================
// All navigation state lives here. The app uses simple state-
// based routing (no React Router) — a single NavState value in
// App.tsx describes what's on screen. Screens receive a
// `navigate` callback and call it to move around.
// ============================================================

// Bottom-nav tabs. "settings" is no longer a tab — it lives
// behind the gear icon in the Brand bar. "archive" is now its
// own top-level tab (previously a sub-view within each module).
export type Tab = "acute" | "pre-assess" | "follow-up" | "archive";

export type NavState =
  | { tab: "acute"; view: "list" }
  | { tab: "acute"; view: "detail"; id: number | "new" }
  | { tab: "acute"; view: "import" }
  | { tab: "pre-assess"; view: "list" }
  | { tab: "pre-assess"; view: "detail"; id: number | "new" }
  | { tab: "pre-assess"; view: "import" }
  | { tab: "follow-up"; view: "list" }
  | {
      tab: "follow-up";
      view: "detail";
      id: number | "new";
      draftSource?: { module: "ACUTE" | "PRE_ASSESSMENT"; sourceId: number };
    }
  | { tab: "follow-up"; view: "import" }
  // Archive is a flat list — no detail view within it.
  | { tab: "archive"; view: "list" };

export type NavigateFn = (to: NavState) => void;

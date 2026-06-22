// ============================================================
// Charted PWA — types/nav.ts
// ============================================================
// All navigation state lives here. The app uses simple state-
// based routing (no React Router) — a single NavState value in
// App.tsx describes what's on screen. Screens receive a
// `navigate` callback and call it to move around.
// ============================================================

export type Tab = "acute" | "pre-assess" | "follow-up" | "settings";

export type NavState =
  | { tab: "acute"; view: "list" }
  | { tab: "acute"; view: "detail"; id: number | "new" }
  | { tab: "acute"; view: "archive" }
  | { tab: "acute"; view: "import" }
  | { tab: "pre-assess"; view: "list" }
  | { tab: "pre-assess"; view: "detail"; id: number | "new" }
  | { tab: "pre-assess"; view: "archive" }
  | { tab: "pre-assess"; view: "import" }
  | { tab: "follow-up"; view: "list" }
  | {
      tab: "follow-up";
      view: "detail";
      id: number | "new";
      draftSource?: { module: "ACUTE" | "PRE_ASSESSMENT"; sourceId: number };
    }
  | { tab: "follow-up"; view: "archive" }
  | { tab: "follow-up"; view: "import" }
  | { tab: "settings"; view: "main" };

export type NavigateFn = (to: NavState) => void;

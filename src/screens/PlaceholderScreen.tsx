// ============================================================
// Charted PWA — PlaceholderScreen.tsx
// ============================================================
// Shown for tabs that haven't been built yet (Pre-assess,
// Follow-up, Settings). Replaced module by module as each is
// built. The message is intentionally informative rather than
// generic, so it reads as a real state rather than a bug.
//
// FILE LOCATION:
//   src/screens/PlaceholderScreen.tsx
// ============================================================

import { Construction } from "lucide-react";
import type { Tab } from "../types/nav";

const LABELS: Record<Tab, string> = {
  "acute": "Acute referrals",
  "pre-assess": "Pre-assessment",
  "follow-up": "Follow-up",
  "settings": "Settings",
};

interface PlaceholderScreenProps {
  tab: Tab;
}

export function PlaceholderScreen({ tab }: PlaceholderScreenProps) {
  return (
    <div className="placeholder-screen">
      <Construction size={36} color="var(--dim)" aria-hidden />
      <p className="placeholder-screen-title">{LABELS[tab]}</p>
      <p>This module is coming soon.</p>
    </div>
  );
}

// ============================================================
// Charted PWA — TabBar.tsx
// ============================================================
// The bottom navigation bar. Four tabs: Acute, Pre-assess,
// Follow-up, Settings. Each tab is a button with an icon +
// label; the active one turns navy, the rest stay dim.
//
// Uses Lucide React for icons — they're tree-shaken so we only
// bundle the four we import here.
//
// FILE LOCATION:
//   src/components/TabBar.tsx
// ============================================================

import { AlertCircle, ClipboardList, Bell, Settings } from "lucide-react";
import type { Tab } from "../types/nav";

interface TabBarProps {
  active: Tab;
  onSelect: (tab: Tab) => void;
}

// Tab definitions — icon, label, value in one place so adding a
// tab is a one-line change here rather than scattered edits.
const TABS: { id: Tab; label: string; Icon: React.FC<{ size: number }> }[] = [
  { id: "acute", label: "Acute", Icon: AlertCircle },
  { id: "pre-assess", label: "Pre-assess", Icon: ClipboardList },
  { id: "follow-up", label: "Follow-up", Icon: Bell },
  { id: "settings", label: "Settings", Icon: Settings },
];

export function TabBar({ active, onSelect }: TabBarProps) {
  return (
    <nav className="tabbar" aria-label="Main navigation">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={`tabbar-btn${active === id ? " active" : ""}`}
          onClick={() => onSelect(id)}
          aria-current={active === id ? "page" : undefined}
        >
          <Icon size={22} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

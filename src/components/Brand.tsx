// ============================================================
// Charted PWA — Brand.tsx
// ============================================================
// The Hypnos Medical brand bar, matching the suite branding.
// A dark navy bar with the crescent-moon mark, the
// "Hypnos / MEDICAL" lockup, a divider, then the individual app
// name. Styling lives in index.css (the .brand* classes).
//
// The app name is passed in as a prop because it's still TBC —
// swap the value where this component is used and nothing else
// needs to change.
//
// FILE LOCATION:
//   src/components/Brand.tsx
// ============================================================

interface BrandProps {
  // The individual app's name (currently a placeholder for the
  // Charted replacement — e.g. "Nexus360" in the mock).
  appName: string;
}

export function Brand({ appName }: BrandProps) {
  return (
    <header className="brandbar">
      <div className="brand-lockup" aria-label="Hypnos Medical">
        {/* Feather "moon" crescent — the shared Hypnos mark */}
        <svg
          className="brand-moon"
          width="30"
          height="30"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <div className="brand-names">
          <span className="brand-hypnos">Hypnos</span>
          <span className="brand-medical">Medical</span>
        </div>
      </div>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-app">{appName}</span>
    </header>
  );
}

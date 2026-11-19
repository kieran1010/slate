// ============================================================
// Slate — components/ImportStatus.tsx
// ============================================================
// The spinner and the error panel shared by the AI import screens
// (screens/ImportScreen.tsx and screens/OperatingListImport.tsx).
//
// FILE LOCATION:
//   src/components/ImportStatus.tsx
// ============================================================

import { AlertTriangle, RefreshCw } from "lucide-react";

export function Spinner({ message }: { message: string }) {
  return (
    <div
      className="loading-screen"
      style={{ flexDirection: "column", gap: 16 }}
      aria-live="polite"
    >
      <div
        style={{
          width: 40,
          height: 40,
          border: "3px solid var(--border)",
          borderTopColor: "var(--teal)",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
        aria-hidden
      />
      <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>{message}</p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function ImportError({
  message,
  onRetry,
  title = "Import failed",
}: {
  message: string;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <div className="form-body">
      <div
        style={{
          background: "#FEE2E2",
          border: "1px solid #FECACA",
          borderRadius: 10,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <p
          style={{
            fontWeight: 500,
            color: "#991B1B",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "0.9rem",
          }}
        >
          <AlertTriangle size={16} aria-hidden />
          {title}
        </p>
        <p style={{ fontSize: "0.82rem", color: "#7F1D1D", lineHeight: 1.6 }}>{message}</p>
        <button
          className="btn btn-secondary"
          onClick={onRetry}
          style={{ alignSelf: "flex-start" }}
        >
          <RefreshCw size={14} aria-hidden />
          Try again
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Charted PWA — vite.config.ts
// ============================================================
// Vite is the build tool + dev server. This file configures it.
// We add two plugins:
//   • @vitejs/plugin-react — lets Vite understand React/JSX
//   • vite-plugin-pwa      — generates the service worker and
//     web app manifest that make this installable + offline.
// ============================================================

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  // ── base path ────────────────────────────────────────────
  // Where the app is served FROM on the web server.
  //   • "/"            → served at the domain root (e.g. an app
  //                      subdomain like charted.hypnos.one)
  //   • "/charted/"    → served from a subfolder
  //                      (e.g. hypnos.one/charted/)
  // Left as "/" for now. We'll set this once hypnos.one's
  // hosting layout is confirmed — it MUST match or the service
  // worker and asset URLs will 404.
  base: "/",

  plugins: [
    react(),

    VitePWA({
      // autoUpdate: when a new version is deployed, the service
      // worker updates itself in the background on next visit.
      registerType: "autoUpdate",

      // The web app manifest — metadata browsers use when the
      // user "installs" the PWA to their home screen / desktop.
      manifest: {
        name: "Slate",
        short_name: "Slate",
        description: "Anaesthesia workflow: acute referrals, pre-assessment, follow-up.",
        theme_color: "#0F3557", // matches the existing Charted accent
        background_color: "#121212",
        display: "standalone", // looks like a native app, no browser chrome
        orientation: "portrait",
        start_url: "/",
        // ICONS: intentionally omitted for now. Installable PWAs
        // want 192x192 and 512x512 PNGs in /public. We'll add real
        // Charted icons when we have artwork; the app builds and
        // runs without them (the install prompt just won't show a
        // custom icon yet).
      },

      // Dev-time: enable the service worker during `npm run dev`
      // so PWA behaviour can be tested without a production build.
      devOptions: {
        enabled: false, // keep off until we're ready to test offline
      },
    }),
  ],
});

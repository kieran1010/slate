// ============================================================
// Slate — utils/driveLink.ts
// ============================================================
// Background Drive sync: this device's connection to the Hypnos
// sign-in server (supabase/functions/google-drive-auth).
//
// WHY: Google only renews Slate's one-hour Drive access through a
// window of its own, and only from a tap (see driveSync.ts). Once
// this device is connected, Slate asks the Hypnos server instead,
// which holds a long-lived Google permission for this device and
// hands out fresh access with no window at all.
//
// CONNECTING (once per device): Slate sends the user to Google's
// consent screen (offline access, PKCE), Google sends them back to
// https://slate.hypnos.one/?code=…&state=…, and Slate passes the
// code to the server together with a random device key. The server
// locks Google's permission with that key; the key itself stays
// only on this device (localStorage), so the server's copy is
// useless without it.
//
// The server never sees any records: they are encrypted on the
// device before they go to Drive, as before.
//
// FILE LOCATION:
//   src/utils/driveLink.ts
// ============================================================

/** The Hypnos sign-in server (DB2 project, Sydney). */
export const DRIVE_AUTH_URL = "https://cwgdsiqxydhaqpsicafb.supabase.co/functions/v1/google-drive-auth";
const APP = "slate";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const LINK_KEY = "slateDriveLink";             // { deviceId, deviceKey }
const PENDING_KEY = "slateDriveLinkPending";   // a connection on its way through Google
const OUTCOME_KEY = "slateDriveLinkOutcome";   // shown in Settings once
const PENDING_MAX_AGE_MS = 30 * 60_000;
const SERVER_TIMEOUT_MS = 10_000;

export interface DeviceLink {
  deviceId: string;
  deviceKey: string;
}

interface PendingLink {
  state: string;
  codeVerifier: string;
  deviceKey: string;
  redirectUri: string;
  at: number;
  // This connection is also switching Google Drive sync on: sync is only
  // switched on if it succeeds (see App.tsx).
  enableSync: boolean;
}

export interface LinkOutcome {
  ok: boolean;
  message: string;
  enableSync?: boolean;
}

// ── Storage (every access guarded: storage can be unavailable) ──

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: background sync just stays off.
  }
}

const listeners = new Set<() => void>();

/** For useSyncExternalStore: re-render when this device connects or disconnects. */
export function subscribeDeviceLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let cachedLink: DeviceLink | null | undefined;

export function getDeviceLink(): DeviceLink | null {
  if (cachedLink === undefined) {
    const saved = readJson<DeviceLink>(LINK_KEY);
    cachedLink = saved && typeof saved.deviceId === "string" && typeof saved.deviceKey === "string" ? saved : null;
  }
  return cachedLink;
}

function setDeviceLink(link: DeviceLink | null): void {
  cachedLink = link;
  writeJson(LINK_KEY, link);
  listeners.forEach((l) => l());
}

// ── Small crypto helpers ─────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64url(byteCount: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

// ── Talking to the server ────────────────────────────────────

interface ServerReply {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

async function callServer(body: Record<string, unknown>): Promise<ServerReply> {
  const res = await fetch(DRIVE_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app: APP, ...body }),
    // A background sync mustn't hang on a slow connection.
    signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

// ── Connecting ───────────────────────────────────────────────

/**
 * Sends this page to Google's consent screen to connect this device.
 * Slate reloads when Google sends the user back (see completeDeviceLink).
 */
export async function startDeviceLink(clientId: string, { enableSync = false } = {}): Promise<void> {
  const pending: PendingLink = {
    state: randomB64url(16),
    codeVerifier: randomB64url(32),
    deviceKey: randomB64url(32),
    redirectUri: `${location.origin}/`,
    at: Date.now(),
    enableSync,
  };
  writeJson(PENDING_KEY, pending);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: pending.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    // A fresh long-lived permission for this device, even if another
    // device (or app) already has one.
    prompt: "consent",
    state: pending.state,
    code_challenge: await pkceChallenge(pending.codeVerifier),
    code_challenge_method: "S256",
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/**
 * If this page load is Google sending the user back, finishes connecting
 * this device. Returns the outcome (also kept for Settings to show), or
 * null when this isn't a return from Google. The ?code=… is removed from
 * the address straight away. On success, also returns the first access
 * token so the first sync needs no further request.
 */
export async function completeDeviceLink(): Promise<(LinkOutcome & { accessToken?: string; expiresIn?: number }) | null> {
  const params = new URLSearchParams(location.search);
  const state = params.get("state");
  if (!state) return null;
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return null;
  // Never leave Google's one-time code in the address bar or history.
  history.replaceState(history.state, "", location.pathname);
  const pending = readJson<PendingLink>(PENDING_KEY);
  if (!pending || pending.state !== state) {
    return keepForSettings({ ok: false, message: "Sync wasn't set up: the sign-in didn't match. Please try again." });
  }
  writeJson(PENDING_KEY, null);

  let outcome: LinkOutcome & { accessToken?: string; expiresIn?: number };
  if (Date.now() - pending.at > PENDING_MAX_AGE_MS) {
    outcome = { ok: false, message: "That took too long. Please try again." };
  } else if (error || !code) {
    outcome = {
      ok: false,
      message: error === "access_denied"
        ? "Google Drive access wasn't allowed, so sync wasn't set up."
        : "Sync wasn't set up. Please try again.",
    };
  } else {
    try {
      const reply = await callServer({
        action: "link",
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        deviceKey: pending.deviceKey,
      });
      if (reply.ok && typeof reply.data.deviceId === "string") {
        setDeviceLink({ deviceId: reply.data.deviceId, deviceKey: pending.deviceKey });
        outcome = {
          ok: true,
          message: pending.enableSync
            ? "Google Drive sync is on."
            : "Done: this device now syncs without Google's sign-in pop-up.",
          accessToken: typeof reply.data.accessToken === "string" ? reply.data.accessToken : undefined,
          expiresIn: Number(reply.data.expiresIn) || undefined,
        };
      } else {
        const why = typeof reply.data.error === "string" ? reply.data.error : "Please try again.";
        outcome = { ok: false, message: `Sync wasn't set up. ${why}` };
      }
    } catch {
      outcome = { ok: false, message: "Sync wasn't set up: couldn't reach the Hypnos server. Please try again." };
    }
  }
  outcome.enableSync = pending.enableSync === true;
  return keepForSettings(outcome);
}

// Keeps the outcome's message for Settings to show once.
function keepForSettings<T extends LinkOutcome>(outcome: T): T {
  try {
    sessionStorage.setItem(OUTCOME_KEY, JSON.stringify({ ok: outcome.ok, message: outcome.message, enableSync: outcome.enableSync }));
  } catch {
    // Settings just won't show the message.
  }
  return outcome;
}

/** The connection outcome waiting to be shown in Settings, if any. */
export function peekLinkOutcome(): LinkOutcome | null {
  try {
    const raw = sessionStorage.getItem(OUTCOME_KEY);
    return raw ? (JSON.parse(raw) as LinkOutcome) : null;
  } catch {
    return null;
  }
}

/** Call once Settings has shown the outcome. */
export function clearLinkOutcome(): void {
  try {
    sessionStorage.removeItem(OUTCOME_KEY);
  } catch {
    // Nothing stored.
  }
}

// ── Everyday use ─────────────────────────────────────────────

export type ServerToken =
  | { kind: "token"; accessToken: string; expiresIn: number }
  | { kind: "relink" }        // this device must connect again
  | { kind: "unavailable" };  // server unreachable, busy or failing

/** Asks the server for a fresh Drive access token for this device. */
export async function fetchServerToken(): Promise<ServerToken> {
  const link = getDeviceLink();
  if (!link) return { kind: "relink" };
  try {
    const reply = await callServer({ action: "token", deviceId: link.deviceId, deviceKey: link.deviceKey });
    if (reply.ok && typeof reply.data.accessToken === "string") {
      return { kind: "token", accessToken: reply.data.accessToken, expiresIn: Number(reply.data.expiresIn) || 3600 };
    }
    if (reply.data.code === "RELINK") {
      setDeviceLink(null);
      return { kind: "relink" };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Disconnects this device: the server deletes its locked permission, which
 * can then never be used again. Nothing is revoked with Google — that would
 * disconnect every device and Hypnos app (see disconnectDrive in googleDrive.ts).
 */
export async function unlinkDevice(): Promise<void> {
  const link = getDeviceLink();
  if (!link) return;
  setDeviceLink(null);
  try {
    await callServer({ action: "unlink", deviceId: link.deviceId, deviceKey: link.deviceKey });
  } catch {
    // Best effort: if the server didn't hear, the permission still can't be
    // used without this device's key (now deleted), lapses after six months
    // unused, and the server prunes it.
  }
}

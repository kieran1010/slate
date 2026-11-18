// ============================================================
// Slate — utils/googleDrive.ts
// ============================================================
// Google Drive access for the optional encrypted Drive sync.
// Modelled on Tribulator's Drive sync (kieran1010/Tribulator,
// web/src/lib/googleDrive.js).
//
// AUTH:
//   Google Identity Services token client, talking to Google
//   directly (Slate has no account of its own). The consent popup
//   appears once, on the first Sync now; after that, tokens are
//   refreshed silently (prompt: "none"), as Tribulator does, so
//   automatic syncs don't need the user to sign in again.
//
// BACKGROUND SYNC (utils/driveLink.ts):
//   A device connected to the Hypnos sign-in server gets its tokens
//   from the server instead, with no Google window at all; the
//   methods above are then only the fallback for when the server
//   can't help.
//
// CLIENT ID:
//   Built in at build time from the VITE_GOOGLE_CLIENT_ID GitHub
//   Actions variable: the Hypnos Medical OAuth client, shared
//   across the Hypnos suite, so users need no Google Cloud setup.
//   A client ID is public by design, so shipping it is safe.
//
// SCOPE:  drive.file
//   Slate can only see files it created itself, never the rest
//   of the user's Drive. It is a non-sensitive scope, so the
//   OAuth client needs no Google verification review.
//
// STORAGE:
//   One file, slate-backup.slate, holding the encrypted payload
//   from crypto.ts — every device merges into it (driveSync.ts).
//   The plaintext never reaches Google.
//
// TOKEN:
//   Tokens last about an hour. The current one is kept in memory and
//   in localStorage until it expires, so reopening Slate within the
//   hour (Android often closes a PWA in the background) can sync
//   straight away without asking Google again. It can only reach the
//   files Slate created (drive.file). Forgotten when Google rejects
//   it, and on disconnect / erase (never revoked: see disconnectDrive).
//
// FILE LOCATION:
//   src/utils/googleDrive.ts
// ============================================================

import { getDeviceLink, fetchServerToken, startDeviceLink, completeDeviceLink, unlinkDevice } from "./driveLink";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILES_API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

export const BACKUP_FILENAME = "slate-backup.slate";

// Pasting into a CI variable can pick up stray whitespace.
const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").replace(/\s+/g, "");

/** False when this build has no client ID, so Drive sync can't work. */
export function isDriveConfigured(): boolean {
  return !!CLIENT_ID;
}

// ── Google Identity Services (minimal typings) ────────────────

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(): void;
}

interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    prompt?: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): TokenClient;
}

interface GoogleGlobal {
  accounts?: { oauth2?: GoogleOAuth2 };
}

function gisOAuth2(): GoogleOAuth2 | undefined {
  return (globalThis as { google?: GoogleGlobal }).google?.accounts?.oauth2;
}

let gisPromise: Promise<GoogleOAuth2> | null = null;

function loadGis(): Promise<GoogleOAuth2> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const existing = gisOAuth2();
    if (existing) return resolve(existing);
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      const oauth2 = gisOAuth2();
      if (oauth2) resolve(oauth2);
      else reject(new Error("Google sign-in loaded but is unavailable."));
    };
    script.onerror = () => {
      gisPromise = null; // let a later attempt retry once the network returns
      reject(new Error("Could not reach Google sign-in. Check your connection."));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

/** Starts loading Google's sign-in script ahead of the first tap. */
export function preloadGoogleSignIn(): void {
  loadGis().catch(() => { /* surfaced when the user actually taps */ });
}

// ── Token ─────────────────────────────────────────────────────

const TOKEN_STORAGE_KEY = "slateDriveToken";

let cachedToken: string | null = null;
let cachedExpiry = 0;

// Picks up a token saved before Slate was last closed, if it hasn't
// expired. Storage can be unavailable (private mode, blocked site
// data): the token is then simply in memory only.
function restoreToken(): void {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { token?: unknown; expiry?: unknown };
    if (typeof saved.token === "string" && typeof saved.expiry === "number" && Date.now() < saved.expiry) {
      cachedToken = saved.token;
      cachedExpiry = saved.expiry;
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Unreadable: ignore.
  }
}
restoreToken();

function rememberToken(token: string, expiry: number): void {
  cachedToken = token;
  cachedExpiry = expiry;
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, expiry }));
  } catch {
    // Storage unavailable: keep it in memory only.
  }
}

function forgetToken(): void {
  cachedToken = null;
  cachedExpiry = 0;
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

/** The cached token if it is still valid, else null. Never shows a popup. */
export function peekDriveToken(): string | null {
  return cachedToken && Date.now() < cachedExpiry ? cachedToken : null;
}

export interface TokenOptions {
  /**
   * false asks Google for a token without showing any UI, which works
   * once the user has granted access in this browser. Automatic syncs use
   * it so they fail quietly rather than throwing a popup at the user.
   */
  interactive?: boolean;
  /**
   * Bounds a silent request. Neither loading Google's script nor the
   * token request has a timeout of its own, so on a poor connection a
   * background sync would otherwise hang. Interactive requests never
   * pass one: the user may be taking their time in a real consent popup.
   */
  timeoutMs?: number;
}

/**
 * Returns a Drive access token. Interactive requests show Google's
 * consent popup the first time and must come from a tap so the popup
 * isn't blocked.
 */
export async function getDriveToken({ interactive = true, timeoutMs }: TokenOptions = {}): Promise<string> {
  if (!CLIENT_ID) throw new Error("Google Drive sync isn't set up in this version of Slate.");
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  // Background sync: a connected device asks the Hypnos server — no window.
  // If it's no longer connected, or the server can't help right now, carry
  // on the usual way below.
  if (getDeviceLink()) {
    const fromServer = await serverToken();
    if (fromServer) return fromServer;
  }

  const attempt = (async () => {
    const oauth2 = await loadGis();
    return new Promise<string>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: DRIVE_SCOPE,
        prompt: interactive ? "" : "none",
        callback: (response) => {
          if (!response.access_token) {
            reject(new Error(response.error_description || response.error || "Google authorisation failed."));
            return;
          }
          // Expire a minute early so a request never starts on a dying token.
          rememberToken(
            response.access_token,
            Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60_000
          );
          resolve(response.access_token);
        },
        error_callback: (error) =>
          reject(new Error(error.type === "popup_closed"
            ? "Google sign-in was cancelled."
            : error.message || "Google authorisation failed.")),
      });
      client.requestAccessToken();
    });
  })();

  if (!timeoutMs) return attempt;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Could not reach Google. Check your connection and try again.")),
      timeoutMs
    );
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
    // If the timeout won, the real attempt may still settle later — a
    // success harmlessly fills the token cache; swallow a failure.
    attempt.catch(() => {});
  }
}

// Concurrent callers (a background sync and a tap, say) share one request:
// the server allows a device one token request every few seconds.
let serverAttempt: Promise<string | null> | null = null;

function serverToken(): Promise<string | null> {
  if (!serverAttempt) {
    serverAttempt = fetchServerToken()
      .then((result) => {
        if (result.kind !== "token") return null;
        rememberToken(result.accessToken, Date.now() + result.expiresIn * 1000 - 60_000);
        return result.accessToken;
      })
      .finally(() => { serverAttempt = null; });
  }
  return serverAttempt;
}

/**
 * Starts background sync for this device: leaves Slate for Google's consent
 * screen, which returns to Slate (finishBackgroundSyncSetup).
 */
export async function beginBackgroundSyncSetup(): Promise<void> {
  if (!CLIENT_ID) throw new Error("Google Drive sync isn't set up in this version of Slate.");
  await startDeviceLink(CLIENT_ID);
}

/**
 * Call once at startup, before syncing: if Google has just sent the user
 * back, finishes connecting this device. True when that happened (whether
 * or not it worked — Settings shows the outcome).
 */
export async function finishBackgroundSyncSetup(): Promise<boolean> {
  const outcome = await completeDeviceLink();
  if (!outcome) return false;
  if (outcome.accessToken) {
    rememberToken(outcome.accessToken, Date.now() + (outcome.expiresIn ?? 3600) * 1000 - 60_000);
  }
  return true;
}

/** Turns background sync off for this device: the server forgets its permission. */
export async function stopBackgroundSync(): Promise<void> {
  forgetToken();
  await unlinkDevice();
}

/**
 * Disconnects this device from Google Drive: forgets its token and its
 * background-sync connection. Best effort.
 *
 * It deliberately does NOT revoke anything with Google. Revoking any one
 * token removes everything granted to the whole Google project — every
 * token, on every device, for every Hypnos app sharing the project (Google,
 * "OAuth 2.0 for web server apps", token revocation). A forgotten token
 * expires within the hour; a forgotten background-sync permission can't be
 * used again (only this device's key could unlock it). To withdraw access
 * everywhere, the user removes Hypnos from their Google Account.
 */
export async function disconnectDrive(): Promise<void> {
  forgetToken();
  await unlinkDevice();
}

// ── Drive REST ────────────────────────────────────────────────

async function driveFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.ok) return res;

  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const message = body?.error?.message ?? "";
  console.error("Drive request failed:", res.status, message);

  if (res.status === 401) {
    forgetToken();
    throw new Error("Google sign-in expired. Tap Sync now to reconnect.");
  }
  if (res.status === 403) {
    if (/has not been used in project|is disabled/i.test(message)) {
      // The token is fine; the fix is in the Google Cloud console.
      throw new Error("The Google Drive API isn't enabled for Slate's Google Cloud project.");
    }
    forgetToken();
    if (/insufficient/i.test(message)) {
      throw new Error("Drive access wasn't granted. Switch Google Drive sync off and on again, and allow access when Google asks.");
    }
    throw new Error("Google Drive refused the request.");
  }
  if (res.status === 404) throw new DriveNotFoundError("Drive file not found.");
  throw new Error(`Google Drive request failed (${res.status}).`);
}

/** The file asked for no longer exists (or belongs to another account). */
export class DriveNotFoundError extends Error {}

export interface DriveFile {
  id: string;
  modifiedTime: string;
  // Increments on every change to the file, which is what lets a sync
  // notice that another device wrote while it was merging.
  version: string;
}

const FILE_FIELDS = "id,modifiedTime,version";

/**
 * Finds Slate's backup file. With drive.file, Drive only returns
 * files Slate itself created, so a name match is sufficient.
 */
export async function findBackupFile(token: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(`name='${BACKUP_FILENAME}' and trashed=false`);
  const res = await driveFetch(
    token,
    `${FILES_API}?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(${FILE_FIELDS})&pageSize=10`
  );
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files?.[0] ?? null;
}

export async function getFileMetadata(token: string, fileId: string): Promise<DriveFile> {
  const res = await driveFetch(token, `${FILES_API}/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`);
  return (await res.json()) as DriveFile;
}

/** Permanently deletes the backup file (Slate can only touch its own). */
export async function deleteBackupFile(token: string, fileId: string): Promise<void> {
  await driveFetch(token, `${FILES_API}/${encodeURIComponent(fileId)}`, { method: "DELETE" });
}

/** Downloads the backup file's (encrypted) contents. */
export async function readBackupFile(token: string, fileId: string): Promise<string> {
  const res = await driveFetch(token, `${FILES_API}/${encodeURIComponent(fileId)}?alt=media`);
  return res.text();
}

/**
 * Writes the encrypted payload to Drive: overwrites the existing
 * backup file when fileId is given, otherwise creates it.
 */
export async function writeBackupFile(
  token: string,
  encrypted: string,
  fileId: string | null
): Promise<DriveFile> {
  if (fileId) {
    const res = await driveFetch(
      token,
      `${UPLOAD_API}/${encodeURIComponent(fileId)}?uploadType=media&fields=${FILE_FIELDS}`,
      { method: "PATCH", headers: { "Content-Type": "text/plain" }, body: encrypted }
    );
    return (await res.json()) as DriveFile;
  }

  const metadata = { name: BACKUP_FILENAME, mimeType: "text/plain" };
  const boundary = `slate-${crypto.randomUUID()}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${encrypted}\r\n` +
    `--${boundary}--`;
  const res = await driveFetch(token, `${UPLOAD_API}?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json()) as DriveFile;
}

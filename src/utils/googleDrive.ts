// ============================================================
// Slate — utils/googleDrive.ts
// ============================================================
// Google Drive access for the optional encrypted Drive backup.
// Modelled on Tribulator's Drive sync (kieran1010/Tribulator,
// web/src/lib/googleDrive.js).
//
// AUTH:
//   Google Identity Services token client, talking to Google
//   directly (Slate has no account of its own). Slate asks for
//   Drive access only when the user first backs up or restores.
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
//   from crypto.ts. Each backup overwrites it — there is exactly
//   one copy. The plaintext never reaches Google.
//
// TOKEN:
//   Kept in memory only (never written to storage) and revoked
//   on disconnect / sign-out. Tokens last about an hour.
//
// FILE LOCATION:
//   src/utils/googleDrive.ts
// ============================================================

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILES_API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

export const BACKUP_FILENAME = "slate-backup.slate";

// Pasting into a CI variable can pick up stray whitespace.
const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").replace(/\s+/g, "");

/** False when this build has no client ID, so Drive backup can't work. */
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
  revoke(token: string, done: () => void): void;
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

let cachedToken: string | null = null;
let cachedExpiry = 0;

function forgetToken(): void {
  cachedToken = null;
  cachedExpiry = 0;
}

/**
 * Returns a Drive access token, showing Google's consent popup
 * the first time (or when the cached token has expired). Must be
 * called from a user gesture so the popup isn't blocked.
 */
export async function getDriveToken(): Promise<string> {
  if (!CLIENT_ID) throw new Error("Google Drive backup isn't set up in this version of Slate.");
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  const oauth2 = await loadGis();
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_SCOPE,
      prompt: "",
      callback: (response) => {
        if (!response.access_token) {
          reject(new Error(response.error_description || response.error || "Google authorisation failed."));
          return;
        }
        cachedToken = response.access_token;
        // Expire a minute early so a request never starts on a dying token.
        cachedExpiry = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60_000;
        resolve(cachedToken);
      },
      error_callback: (error) =>
        reject(new Error(error.type === "popup_closed"
          ? "Google sign-in was cancelled."
          : error.message || "Google authorisation failed.")),
    });
    client.requestAccessToken();
  });
}

/** Revokes the Drive grant for this session. Best effort. */
export async function revokeDriveToken(): Promise<void> {
  const token = cachedToken;
  forgetToken();
  if (!token) return;
  try {
    const oauth2 = await loadGis();
    await new Promise<void>((resolve) => oauth2.revoke(token, resolve));
  } catch {
    // The token expires within the hour regardless.
  }
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
    throw new Error("Google sign-in expired. Please try again.");
  }
  if (res.status === 403) {
    forgetToken();
    if (/has not been used in project|is disabled/i.test(message)) {
      throw new Error("The Google Drive API isn't enabled for Slate's Google Cloud project.");
    }
    if (/insufficient/i.test(message)) {
      throw new Error("Drive access wasn't granted. Try again and allow access when Google asks.");
    }
    throw new Error("Google Drive refused the request.");
  }
  throw new Error(`Google Drive request failed (${res.status}).`);
}

export interface DriveFile {
  id: string;
  modifiedTime: string;
}

const FILE_FIELDS = "id,modifiedTime";

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

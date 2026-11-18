// =============================================================================
// google-drive-auth — the Hypnos suite's sign-in server for Google Drive sync.
// -----------------------------------------------------------------------------
// Lets a Hypnos app (Slate, Tribulator) get a fresh Google Drive access token
// whenever it needs one, without Google's sign-in window. Each device connects
// once; after that it asks this server instead of Google.
//
// POST { action: "link", app, code, codeVerifier, redirectUri, deviceKey }
//      -> { deviceId, accessToken, expiresIn }
//   The app sent the user to Google's consent screen (offline access, PKCE)
//   and got `code` back on its own page. This swaps it for Google's long-lived
//   permission (refresh token), seals that under a key derived from
//   `deviceKey` — a random secret that only the device keeps — and stores the
//   sealed copy. The device key itself is never stored.
//
// POST { action: "token", app, deviceId, deviceKey } -> { accessToken, expiresIn }
//   Unseals the device's permission and asks Google for a one-hour token.
//
// POST { action: "unlink", app, deviceId, deviceKey } -> { ok: true }
//   Forgets the device: its sealed permission is deleted, and without it
//   (and the device's key) Google's permission can never be used again.
//
// NEVER CALL GOOGLE'S REVOKE ENDPOINT HERE: revoking any one token "removes
// all OAuth 2.0 scopes previously granted to a project, invalidating any
// issued access or refresh tokens for all clients registered under that
// project" (Google, OAuth 2.0 for web server apps). That would disconnect
// every device and every Hypnos app sharing the project. A forgotten
// permission simply lapses once unused for six months; a user who wants to
// withdraw access everywhere does so from their Google Account.
//
// WHAT IS STORED (drive_auth.devices, via public.drive_auth_* functions):
//   a random device id, the app name, the sealed permission and timestamps.
//   No names, email addresses or health data. A copy of the table alone can't
//   unlock anything: each permission needs that device's key. The token never
//   reaches Drive data either — apps encrypt everything before it leaves the
//   device, and the permission only covers files the app created (drive.file).
//
// ERRORS: { error: <message for the user>, code } — codes the apps act on:
//   RELINK        this device must connect again (unknown device, wrong key,
//                 or Google no longer honours the permission)
//   RATE_LIMITED  asked again within MIN_TOKEN_INTERVAL_S
//   SCOPE_DENIED  the user didn't tick Drive access on Google's screen
//   NO_REFRESH    Google issued no long-lived permission
//   LINK_FAILED   Google refused the code (expired, used, or mismatched)
//   BAD_REQUEST / FORBIDDEN_ORIGIN / GOOGLE / SERVER
//
// SECRETS (Supabase dashboard → Edge Functions → Secrets):
//   GOOGLE_CLIENT_ID      the Hypnos OAuth client ID (same one the apps use)
//   GOOGLE_CLIENT_SECRET  that client's secret — never in any app
//   SUPABASE_URL and SUPABASE_SECRET_KEYS are injected automatically.
//
// Deploy with verify_jwt off: apps call this anonymously; the device key is
// the credential. Never log request bodies, codes, keys or tokens.
// =============================================================================

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const MIN_TOKEN_INTERVAL_S = 10;
const MAX_BODY_BYTES = 8192;

// The apps allowed to use this server: the origins they run on, and the exact
// return addresses registered for them in the Google OAuth client.
const APPS: Record<string, { origins: string[]; redirectUris: string[] }> = {
  slate: {
    origins: ["https://slate.hypnos.one"],
    redirectUris: ["https://slate.hypnos.one/"],
  },
  tribulator: {
    origins: ["https://tribulator.hypnos.one"],
    redirectUris: ["https://tribulator.hypnos.one/"],
  },
};

// ── Responses ────────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = !!origin && Object.values(APPS).some((a) => a.origins.includes(origin));
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(origin: string | null, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const MESSAGES: Record<string, string> = {
  RELINK: "This device needs to connect Google Drive again.",
  RATE_LIMITED: "Too many requests. Please wait a few seconds.",
  SCOPE_DENIED: "Google Drive access wasn't allowed. Connect again and tick the Google Drive box.",
  NO_REFRESH: "Google didn't grant ongoing access. Please connect again.",
  LINK_FAILED: "Google didn't accept the sign-in. Please connect again.",
  BAD_REQUEST: "The request wasn't understood.",
  FORBIDDEN_ORIGIN: "This app isn't allowed to use Hypnos Drive sign-in.",
  GOOGLE: "Couldn't reach Google. Please try again shortly.",
  SERVER: "Something went wrong on our end. Please try again.",
};

const STATUS: Record<string, number> = {
  RELINK: 410, RATE_LIMITED: 429, SCOPE_DENIED: 400, NO_REFRESH: 400, LINK_FAILED: 400,
  BAD_REQUEST: 400, FORBIDDEN_ORIGIN: 403, GOOGLE: 502, SERVER: 500,
};

class Fail extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) {
    super(code);
    this.code = code;
  }
}

// ── Encoding ─────────────────────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// An exact, standalone copy of the bytes, as the crypto functions want them.
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── Input checks ─────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function str(body: Record<string, unknown>, key: string, max = 2048): string {
  const v = body[key];
  if (typeof v !== "string" || !v || v.length > max) throw new Fail("BAD_REQUEST");
  return v;
}

function deviceKeyBytes(body: Record<string, unknown>): Uint8Array {
  const k = str(body, "deviceKey", 64);
  if (!DEVICE_KEY.test(k)) throw new Fail("BAD_REQUEST");
  return fromB64url(k);
}

function deviceId(body: Record<string, unknown>): string {
  const id = str(body, "deviceId", 64).toLowerCase();
  if (!UUID.test(id)) throw new Fail("BAD_REQUEST");
  return id;
}

// ── Sealing the permission ───────────────────────────────────────────────────
// AES-256-GCM under HKDF-SHA-256(deviceKey, salt = deviceId, info = app).
// The device id and app are also bound in as associated data, so a sealed
// value can't be moved to another row. Format: "v1.<iv>.<ciphertext>".

async function grantKey(key: Uint8Array, id: string, app: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(key), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc(id), info: enc(`hypnos-drive-grant-v1:${app}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(secret: string, key: Uint8Array, id: string, app: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc(`${id}|${app}`) },
    await grantKey(key, id, app),
    enc(secret),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

async function unseal(sealed: string, key: Uint8Array, id: string, app: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Fail("SERVER");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(fromB64url(iv)), additionalData: enc(`${id}|${app}`) },
      await grantKey(key, id, app),
      buf(fromB64url(ct)),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Fail("RELINK"); // wrong device key
  }
}

// ── Database (same pattern as the redeem function) ───────────────────────────

function dbHeaders(): Record<string, string> {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (typeof keys.default === "string" && keys.default) return { apikey: keys.default };
  } catch (_) { /* fall back to the legacy key */ }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { apikey: legacy, Authorization: `Bearer ${legacy}` };
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...dbHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let parsed: { message?: string } | unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  if (!res.ok) {
    const message = (parsed as { message?: string } | null)?.message ?? "";
    if (message.includes("RATE_LIMITED")) throw new Fail("RATE_LIMITED");
    if (message.includes("UNKNOWN_DEVICE")) throw new Fail("RELINK");
    console.error(`rpc ${fn} failed:`, res.status, message.slice(0, 200));
    throw new Fail("SERVER");
  }
  return parsed;
}

// ── Google ───────────────────────────────────────────────────────────────────

function clientCredentials(): { client_id: string; client_secret: string } {
  const client_id = (Deno.env.get("GOOGLE_CLIENT_ID") ?? "").trim();
  const client_secret = (Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "").trim();
  if (!client_id || !client_secret) {
    console.error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets are not set");
    throw new Fail("SERVER");
  }
  return { client_id, client_secret };
}

interface GoogleTokens {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

async function googleToken(params: Record<string, string>): Promise<{ ok: boolean; status: number; data: GoogleTokens }> {
  // Outside the try: missing secrets are our setup problem, not Google's.
  const body = new URLSearchParams({ ...clientCredentials(), ...params });
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new Fail("GOOGLE");
  }
  const data = (await res.json().catch(() => ({}))) as GoogleTokens;
  return { ok: res.ok, status: res.status, data };
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function link(app: string, body: Record<string, unknown>) {
  const code = str(body, "code", 1024);
  const codeVerifier = str(body, "codeVerifier", 128);
  const redirectUri = str(body, "redirectUri", 256);
  const key = deviceKeyBytes(body);
  if (!PKCE_VERIFIER.test(codeVerifier)) throw new Fail("BAD_REQUEST");
  if (!APPS[app].redirectUris.includes(redirectUri)) throw new Fail("BAD_REQUEST");

  const { ok, status, data } = await googleToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
  if (!ok) {
    if (data.error === "invalid_client" || data.error === "unauthorized_client") {
      console.error("Google rejected the client credentials:", status, data.error);
      throw new Fail("SERVER");
    }
    console.warn("Google refused the code:", status, data.error ?? "");
    throw new Fail("LINK_FAILED");
  }
  if (!data.access_token) throw new Fail("GOOGLE");
  // On either failure the tokens are simply dropped, not revoked (see the
  // note at the top: revoking would disconnect the user everywhere).
  if (!(data.scope ?? "").split(" ").includes(DRIVE_SCOPE)) throw new Fail("SCOPE_DENIED");
  if (!data.refresh_token) throw new Fail("NO_REFRESH");

  const id = crypto.randomUUID();
  await rpc("drive_auth_register", { p_id: id, p_app: app, p_sealed: await seal(data.refresh_token, key, id, app) });
  // Now and then, clear out devices Google will no longer honour anyway.
  if (Math.random() < 0.05) rpc("drive_auth_prune", {}).catch(() => {});
  return { deviceId: id, accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

async function token(app: string, body: Record<string, unknown>) {
  const id = deviceId(body);
  const key = deviceKeyBytes(body);
  const sealed = await rpc("drive_auth_claim", { p_id: id, p_app: app, p_min_interval_seconds: MIN_TOKEN_INTERVAL_S });
  if (typeof sealed !== "string") throw new Fail("RELINK");
  const refreshToken = await unseal(sealed, key, id, app);

  const { ok, status, data } = await googleToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (!ok) {
    if (data.error === "invalid_grant") {
      // Revoked by the user, unused for six months, or otherwise expired.
      await rpc("drive_auth_forget", { p_id: id, p_app: app });
      throw new Fail("RELINK");
    }
    if (data.error === "invalid_client" || data.error === "unauthorized_client") {
      console.error("Google rejected the client credentials:", status, data.error);
      throw new Fail("SERVER");
    }
    console.warn("Google refused to refresh:", status, data.error ?? "");
    throw new Fail("GOOGLE");
  }
  if (!data.access_token) throw new Fail("GOOGLE");
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

async function unlink(app: string, body: Record<string, unknown>) {
  const id = deviceId(body);
  const key = deviceKeyBytes(body);
  const sealed = await rpc("drive_auth_peek", { p_id: id, p_app: app });
  if (typeof sealed !== "string") return { ok: true }; // already gone
  await unseal(sealed, key, id, app); // proves it's this device asking
  await rpc("drive_auth_forget", { p_id: id, p_app: app });
  return { ok: true };
}

// ── Entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  try {
    if (req.method !== "POST") throw new Fail("BAD_REQUEST");
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new Fail("BAD_REQUEST");
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { throw new Fail("BAD_REQUEST"); }
    if (!body || typeof body !== "object") throw new Fail("BAD_REQUEST");

    const app = typeof body.app === "string" ? body.app : "";
    if (!Object.hasOwn(APPS, app)) throw new Fail("BAD_REQUEST");
    // Browsers always send Origin on these requests; only the app's own pages may call.
    if (!origin || !APPS[app].origins.includes(origin)) throw new Fail("FORBIDDEN_ORIGIN");

    switch (body.action) {
      case "link": return reply(origin, await link(app, body));
      case "token": return reply(origin, await token(app, body));
      case "unlink": return reply(origin, await unlink(app, body));
      default: throw new Fail("BAD_REQUEST");
    }
  } catch (err) {
    const code = err instanceof Fail ? err.code : "SERVER";
    if (!(err instanceof Fail)) console.error("Unexpected error:", err instanceof Error ? err.message : "unknown");
    return reply(origin, { error: MESSAGES[code], code }, STATUS[code]);
  }
});

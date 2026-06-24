// ============================================================
// Slate — utils/gdocs.ts
// ============================================================
// Google Drive + Docs API helpers for the optional GDocs
// Integration feature.
//
// SCOPE:  drive.file
//   Grants access only to files the Slate app created (or the
//   user opened via Google Picker). Less sensitive than the
//   full `documents` scope and requires no app verification for
//   private use.
//
// AUTH:
//   Uses Firebase's signInWithPopup with GoogleAuthProvider +
//   drive.file scope to get an OAuth access token. Requires the
//   user to be signed in with Google in Firebase. Email/password
//   users receive a clear error message.
//
// TOKEN CACHING:
//   The access token (valid ~1 hour) is cached at module level
//   so repeated export/import calls in the same session don't
//   trigger multiple popups.
//
// DOCUMENT FORMAT (appended, never overwritten):
//   === SLATE EXPORT <ISO timestamp> ===
//   SLATE_ENC_V1|<base64 salt>|<base64 iv>|<base64 ciphertext>
//
//   Multiple exports accumulate in the Doc. Import always reads
//   the MOST RECENT block, so stale exports on other devices
//   cannot overwrite a newer backup.
//
// FILE LOCATION:
//   src/utils/gdocs.ts
// ============================================================

import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { firebaseAuth } from "../firebase";

// ── Scope ─────────────────────────────────────────────────────
// The Google Docs API requires the `documents` scope specifically —
// drive.file is not accepted for docs.googleapis.com endpoints.
// Users see a "this app isn't verified" screen on first use; they
// click Advanced → Go to Slate. Normal for private/internal tools.
const GDOCS_SCOPE = "https://www.googleapis.com/auth/documents";

// ── Token cache (module-level, session-scoped) ────────────────
let _cachedToken: string | null = null;
let _tokenExpiry = 0;

// ── Helpers ───────────────────────────────────────────────────

/**
 * Extracts the Google Doc ID from a full URL or returns the
 * input as-is if it already looks like a raw ID.
 */
export function parseGoogleDocId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : trimmed;
}

// ── Auth ──────────────────────────────────────────────────────

/**
 * Returns a Google OAuth access token with drive.file scope.
 * Opens a Google consent popup on first call (or when the
 * cached token has expired). Throws with a clear message if the
 * user is not signed in with Google.
 */
export async function requestDriveToken(): Promise<string> {
  // GDocs requires a Google-authenticated Firebase user.
  const currentUser = firebaseAuth.currentUser;
  const isGoogleUser =
    currentUser?.providerData.some((p) => p.providerId === "google.com") ??
    false;

  if (!isGoogleUser) {
    throw new Error(
      "GDocs integration requires signing in with Google. " +
        'Please sign out and use "Continue with Google" to sign in.'
    );
  }

  // Return cached token if still fresh (5-minute buffer before expiry).
  if (_cachedToken && Date.now() < _tokenExpiry - 5 * 60 * 1000) {
    return _cachedToken;
  }

  // Re-authenticate with the Drive scope to get an access token.
  // For existing Google users Firebase often skips the popup if
  // the scope was already consented to.
  const provider = new GoogleAuthProvider();
  provider.addScope(GDOCS_SCOPE);

  const result = await signInWithPopup(firebaseAuth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);

  if (!credential?.accessToken) {
    throw new Error(
      "Could not obtain Google Drive access. Please try again."
    );
  }

  // Cache for slightly under 1 hour (Google tokens last 3600 s).
  _cachedToken = credential.accessToken;
  _tokenExpiry = Date.now() + 55 * 60 * 1000;
  return _cachedToken;
}

// ── Drive API — document creation ─────────────────────────────

/**
 * Creates a new Google Doc titled "Slate Backup" using the
 * Docs v1 API (requires `documents` scope). Returns the new
 * document's ID.
 */
export async function createBackupDoc(token: string): Promise<string> {
  const res = await fetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Slate Backup" }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("createBackupDoc error:", body);
    throw new Error(
      `Failed to create Google Doc (${res.status}). Please try again.`
    );
  }

  // Docs API returns documentId (Drive API returns id).
  const doc = (await res.json()) as { documentId: string };
  return doc.documentId;
}

// ── Docs API — append ─────────────────────────────────────────

/**
 * Appends a timestamped encrypted-export block to the end of
 * the specified Google Doc. Never overwrites existing content —
 * previous exports accumulate so the most recent one can always
 * be found on import.
 */
export async function appendToGoogleDoc(
  docId: string,
  encryptedText: string,
  token: string
): Promise<void> {
  const authHeader = { Authorization: `Bearer ${token}` };

  // Fetch current document to find the insertion point.
  const docRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`,
    { headers: authHeader }
  );

  if (!docRes.ok) {
    if (docRes.status === 404)
      throw new Error("Google Doc not found. Check the Doc ID in Settings.");
    if (docRes.status === 403)
      throw new Error(
        "Access denied to Google Doc. Make sure this Doc was created by Slate."
      );
    throw new Error(`Failed to access Google Doc (${docRes.status}).`);
  }

  const doc = (await docRes.json()) as {
    body: { content: Array<{ endIndex?: number }> };
  };

  // Insert just before the trailing paragraph marker (endIndex - 1).
  const lastEl = doc.body.content[doc.body.content.length - 1];
  const insertAt = (lastEl?.endIndex ?? 2) - 1;

  const timestamp = new Date().toISOString();
  const block = `\n=== SLATE EXPORT ${timestamp} ===\n${encryptedText}\n`;

  const updateRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`,
    {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          { insertText: { location: { index: insertAt }, text: block } },
        ],
      }),
    }
  );

  if (!updateRes.ok) {
    const body = await updateRes.text();
    console.error("appendToGoogleDoc error:", body);
    throw new Error("Failed to write to Google Doc. Please try again.");
  }
}

// ── Docs API — read latest ────────────────────────────────────

/**
 * Reads the Google Doc and returns the encrypted text from the
 * MOST RECENT === SLATE EXPORT === block. Throws if none found.
 */
export async function readLatestFromGoogleDoc(
  docId: string,
  token: string
): Promise<string> {
  const docRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!docRes.ok) {
    if (docRes.status === 404)
      throw new Error("Google Doc not found. Check the Doc ID in Settings.");
    if (docRes.status === 403)
      throw new Error(
        "Access denied to Google Doc. Make sure this Doc was created by Slate."
      );
    throw new Error(`Failed to read Google Doc (${docRes.status}).`);
  }

  const doc = (await docRes.json()) as {
    body: {
      content: Array<{
        paragraph?: {
          elements: Array<{ textRun?: { content: string } }>;
        };
      }>;
    };
  };

  // Reconstruct full document text by concatenating all text runs.
  const fullText = doc.body.content
    .flatMap((c) => c.paragraph?.elements ?? [])
    .map((e) => e.textRun?.content ?? "")
    .join("");

  // Find the last SLATE EXPORT block (the most recent).
  // Pattern: header line then the encrypted payload on the next line.
  const pattern =
    /=== SLATE EXPORT [^\n]+ ===\n(SLATE_ENC_V1\|[^\n]+)/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(fullText)) !== null) {
    lastMatch = m;
  }

  if (!lastMatch) {
    throw new Error("No Slate backup found in this Google Doc.");
  }

  return lastMatch[1]; // the encrypted payload string
}

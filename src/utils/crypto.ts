// ============================================================
// Slate — utils/crypto.ts
// ============================================================
// AES-256-GCM encryption / decryption via the browser's native
// Web Crypto API (no dependencies, available in all modern
// browsers and secure PWA contexts).
//
// KEY DERIVATION: PBKDF2 with SHA-256, 100 000 iterations.
//   A random 16-byte salt is generated on every encrypt so the
//   derived key differs even when the passphrase is the same.
//
// OUTPUT FORMAT (text, safe to copy/paste or store in a Doc):
//   SLATE_ENC_V1|<base64 salt>|<base64 IV>|<base64 ciphertext>
//
//   The version tag lets us evolve the format in future without
//   breaking existing backups.
//
// FILE LOCATION:
//   src/utils/crypto.ts
// ============================================================

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256; // bits
const PBKDF2_ITERATIONS = 100_000;
const VERSION_TAG = "SLATE_ENC_V1";

// ── Helpers ──────────────────────────────────────────────────

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// ── Public API ────────────────────────────────────────────────

/**
 * Encrypts a plaintext string with the given passphrase.
 * Returns a versioned, pipe-delimited base64 string that can
 * be stored as plain text (file, Google Doc, clipboard, etc.).
 */
export async function encryptPayload(
  plaintext: string,
  passphrase: string
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    enc.encode(plaintext)
  );
  return [
    VERSION_TAG,
    bufToBase64(salt),
    bufToBase64(iv),
    bufToBase64(ciphertext),
  ].join("|");
}

/**
 * Decrypts a payload produced by encryptPayload().
 * Throws a user-friendly Error if the format is wrong or the
 * passphrase is incorrect.
 */
export async function decryptPayload(
  payload: string,
  passphrase: string
): Promise<string> {
  const parts = payload.trim().split("|");
  if (parts.length !== 4 || parts[0] !== VERSION_TAG) {
    throw new Error(
      "Unrecognised file format. Make sure you selected a Slate encrypted backup (.slate)."
    );
  }
  const salt = base64ToBuf(parts[1]);
  const iv = base64ToBuf(parts[2]);
  const ciphertext = base64ToBuf(parts[3]);
  const key = await deriveKey(passphrase, salt);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // AES-GCM authentication tag failure = wrong passphrase or
    // corrupted data. Surface a clear message.
    throw new Error(
      "Decryption failed. Check your passphrase and try again."
    );
  }
}

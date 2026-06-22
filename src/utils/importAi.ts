// ============================================================
// Charted PWA — utils/importAi.ts
// ============================================================
// Handles the AI document import pipeline:
//   1. Convert a File to base64
//   2. Call the Anthropic API with a module-specific system prompt
//   3. Parse the JSON response into typed extracted data
//
// DIRECT BROWSER ACCESS: the Anthropic API requires two extra
// headers when called from a browser (not a server):
//   • anthropic-dangerous-direct-browser-access: true  → enables CORS
//   • anthropic-beta: pdfs-2024-09-25                  → PDF documents
// These are opt-in on Anthropic's side so are deliberately verbose.
//
// UNCERTAIN VALUES: the system prompt instructs the model to
// prefix uncertain values with "[UNCERTAIN] ". These are stored
// as-is so they remain visible in the edit form after import.
//
// FILE LOCATION:
//   src/utils/importAi.ts
// ============================================================

// ── System prompts ────────────────────────────────────────────
// Ported from AnthropicRepository.kt; the pre-assess prompt is
// the full clinical extraction. Acute and follow-up are simpler.

export const PRE_ASSESS_SYSTEM_PROMPT = `\
You are a clinical data extraction assistant. Your job is to extract \
structured clinical information from medical documents such as clinic \
letters, referral letters, and patient records.

Extract every field you can find and return ONLY a valid JSON object \
with these exact keys. Use null for any field you cannot find.
For fields you find but are uncertain about, prefix the value with \
"[UNCERTAIN] " so the clinician can review it carefully.

FORMATTING RULES — follow these exactly:

For pastMedicalHistory, anaestheticHistory, socialHistory, \
functionalStatus, investigations, and airwayAssessment:
- Each item on its own line
- Sub-details indented underneath with "  - " prefix
- No commas or numbers to separate items
- Example:
  Hypertension
    - On ramipril 5mg
    - Well controlled
  Type 2 diabetes
    - Diet controlled

For medications:
- Each medication with dose on its own line
- No commas, semicolons or numbers
- Example:
  Ramipril 5mg daily
  Metformin 500mg twice daily

For allergies:
- If no known allergies, enter exactly: NKDA
- Otherwise list each allergy on its own line with reaction if known

For weight and height:
- Round to nearest integer
- Weight in kg, height in cm
- Return as plain number only (e.g. "82" not "82kg")

For dob: return in YYYY-MM-DD format if possible.

For all other fields: use plain text, no bullet points or numbering.

Required JSON structure:
{
  "nhi": string or null,
  "surname": string or null,
  "givenName": string or null,
  "dob": string or null,
  "procedure": string or null,
  "surgeon": string or null,
  "indicationForSurgery": string or null,
  "pastMedicalHistory": string or null,
  "anaestheticHistory": string or null,
  "socialHistory": string or null,
  "functionalStatus": string or null,
  "investigations": string or null,
  "medications": string or null,
  "allergies": string or null,
  "weight": string or null,
  "height": string or null,
  "airwayAssessment": string or null,
  "notes": string or null
}

Return ONLY the JSON object. No preamble, no explanation, no markdown code fences.`;

export const ACUTE_SYSTEM_PROMPT = `\
You are a clinical data extraction assistant. Extract structured \
information from this clinical document for an acute anaesthetic referral.

Return ONLY a valid JSON object with these exact keys. Use null for \
missing fields. Prefix uncertain values with "[UNCERTAIN] ".

For dob: return in YYYY-MM-DD format if possible.
For background and taskToComplete: use plain text, no bullet points.

{
  "nhi": string or null,
  "surname": string or null,
  "givenName": string or null,
  "dob": string or null,
  "location": string or null,
  "background": string or null,
  "taskToComplete": string or null
}

Return ONLY the JSON object. No preamble, no explanation, no markdown.`;

export const FOLLOW_UP_SYSTEM_PROMPT = `\
You are a clinical data extraction assistant. Extract structured \
information from this clinical document for a patient follow-up record.

Return ONLY a valid JSON object with these exact keys. Use null for \
missing fields. Prefix uncertain values with "[UNCERTAIN] ".

For dob and interventionDate: return in YYYY-MM-DD or YYYY-MM-DDThh:mm \
format if possible.

{
  "nhi": string or null,
  "surname": string or null,
  "givenName": string or null,
  "dob": string or null,
  "intervention": string or null,
  "interventionDate": string or null,
  "phoneNumber": string or null,
  "outcome": string or null
}

Return ONLY the JSON object. No preamble, no explanation, no markdown.`;

// ── Module prompt selector ────────────────────────────────────

export type ImportModule = "acute" | "pre-assess" | "follow-up";

export function getSystemPrompt(module: ImportModule): string {
  switch (module) {
    case "acute":       return ACUTE_SYSTEM_PROMPT;
    case "pre-assess":  return PRE_ASSESS_SYSTEM_PROMPT;
    case "follow-up":   return FOLLOW_UP_SYSTEM_PROMPT;
  }
}

// ── Extracted data types ──────────────────────────────────────
// Loose Record<string, string | null> from the API, then
// typed accessors below.

export type ExtractedData = Record<string, string | null>;

// ── File → base64 ─────────────────────────────────────────────

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:<mediaType>;base64,<data>" — strip the prefix.
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

// ── Anthropic API call ────────────────────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

export async function callImportApi(
  apiKey: string,
  systemPrompt: string,
  base64Data: string,
  mediaType: string
): Promise<ExtractedData> {
  const isPdf = mediaType === "application/pdf";

  // Document block: PDFs use "document" type, images use "image".
  const contentBlock = isPdf
    ? {
        type: "document",
        source: { type: "base64", media_type: mediaType, data: base64Data },
      }
    : {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64Data },
      };

  const body = {
    model: MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: "Please extract the clinical information from this document." },
        ],
      },
    ],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Required for direct browser access (enables CORS on Anthropic's side).
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      // Required for PDF document support.
      "anthropic-beta": "pdfs-2024-09-25",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = (err as { error?: { message?: string } }).error?.message;
    throw new Error(msg ?? `API error ${res.status}`);
  }

  const data = await res.json();
  // The model returns a text block containing the JSON.
  const text: string =
    data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";

  // Strip any markdown fences the model added despite being told not to.
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  try {
    return JSON.parse(cleaned) as ExtractedData;
  } catch {
    throw new Error(
      "The model returned a response that could not be parsed. Try again or use a clearer document."
    );
  }
}

// ── DOB normalisation ─────────────────────────────────────────
// The model is asked for YYYY-MM-DD but may return other formats.
// We try common patterns; if none match we store as-is.

export function normaliseDob(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // dd/MM/yyyy or d/M/yyyy
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  // MM/dd/yyyy (US format — unlikely in NZ clinical docs but handle it)
  // We can't reliably distinguish from dd/MM when both values ≤ 12.
  // Default to returning as-is for ambiguous cases.
  return s;
}

// ── Uncertainty helpers ───────────────────────────────────────

export function isUncertain(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("[UNCERTAIN]");
}

export function displayValue(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/^\[UNCERTAIN\]\s*/, "");
}

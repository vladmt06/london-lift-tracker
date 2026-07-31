import { createHash } from "node:crypto";

/**
 * Text normalisation used for identity and matching.
 *
 * The guiding rule from the spec: strip what varies without changing meaning
 * (case, spacing, punctuation, dates) but PRESERVE what distinguishes one asset
 * from another (platform numbers, directions, lift numbers).
 */

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";

/** Lowercase, de-accent, drop punctuation, collapse whitespace. Digits survive. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Possessives and contractions join up: "king's" -> "kings".
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ")
    // Anything that is not a letter or digit becomes a separator.
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STATION_NOISE_WORDS = new Set([
  "underground",
  "tube",
  "overground",
  "dlr",
  "rail",
  "railway",
  "national",
  "elizabeth",
  "line",
  "station",
  "stations",
]);

/**
 * Normalise a station name for cross-source matching, so that
 * "Wembley Park Underground Station", "WEMBLEY PARK STATION" and
 * "Wembley Park" all collapse to "wembley park".
 */
export function normalizeStationName(input: string): string {
  const words = normalizeText(input)
    .split(" ")
    .filter((word) => word.length > 0 && !STATION_NOISE_WORDS.has(word));

  // Guard against over-stripping: "Elizabeth line station" would otherwise
  // normalise to the empty string, which must never become an identity.
  if (words.length === 0) return normalizeText(input);

  return words.join(" ");
}

/** URL slug: "King's Cross & St Pancras" -> "kings-cross-and-st-pancras". */
export function slugify(input: string): string {
  const slug = normalizeText(input).split(" ").filter(Boolean).join("-");
  return slug.length > 0 ? slug : "station";
}

/**
 * Remove date and time references so that a message re-issued with a new ETA
 * still produces the same signature. Bare numbers that are not part of a date
 * (platform 3, Lift 5) are deliberately left alone.
 */
export function stripVolatileTimeReferences(input: string): string {
  return input
    .toLowerCase()
    // ISO-8601 timestamps
    .replace(/\b\d{4}-\d{2}-\d{2}(t\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?)?\b/g, " ")
    // 10/03/2026, 10-03-26
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, " ")
    // clock times: 09:30, 09.30, 5pm, 5 pm
    .replace(/\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/g, " ")
    .replace(/\b\d{1,2}\s*(am|pm)\b/g, " ")
    // "10 March" / "10th March" / "March 10"
    .replace(new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(${MONTHS})\\b`, "g"), " ")
    .replace(new RegExp(`\\b(${MONTHS})\\s+\\d{1,2}(st|nd|rd|th)?\\b`, "g"), " ")
    // leftover weekday / month / season / year words
    .replace(new RegExp(`\\b(${WEEKDAYS})\\b`, "g"), " ")
    .replace(new RegExp(`\\b(${MONTHS})\\b`, "g"), " ")
    .replace(/\b(spring|summer|autumn|winter)\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,2}(st|nd|rd|th)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A short, stable fingerprint of a disruption message. Used only as the last
 * identity fallback, when TfL gives us neither a lift id nor a lift name.
 */
export function messageSignature(message: string): string {
  const stable = normalizeText(stripVolatileTimeReferences(message));
  return sha256(stable).slice(0, 16);
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Stable hash of a JSON payload: key order must not change the result. */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}

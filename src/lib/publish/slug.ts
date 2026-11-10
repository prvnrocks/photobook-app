// Public book slugs (D-039): `{ascii-title ≤ 30}-{10 base58}`, or just the random part when the
// title has no ASCII letters/digits (Arabic, emoji). Slugs never change after first publish.
// Pure + isomorphic (Web Crypto `crypto.getRandomValues` exists in Node ≥ 19 and browsers).

export const SLUG_BASE_MAX_LENGTH = 30;
export const SLUG_RANDOM_LENGTH = 10;
/** Longest valid slug: 30-char base + "-" + 10 random. */
export const SLUG_MAX_LENGTH = SLUG_BASE_MAX_LENGTH + 1 + SLUG_RANDOM_LENGTH;

/** Bitcoin base58: no 0, O, I, l (easy to read aloud / type from a printed card). */
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * ASCII, lowercase, hyphen-separated, ≤ 30 chars, no leading/trailing/double hyphens.
 * Diacritics are stripped ("Café Noël" → "cafe-noel"); anything that isn't [a-z0-9] after that
 * (Arabic, emoji, punctuation) becomes a separator, so an Arabic-only title gives "".
 */
export function slugifyTitle(title: string): string {
  const ascii = String(title ?? "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.slice(0, SLUG_BASE_MAX_LENGTH).replace(/-+$/, "");
}

/**
 * `n` base58 characters from crypto.getRandomValues, unbiased: bytes ≥ 232 (= 4 × 58) are
 * rejected instead of taken modulo 58. ~10 chars ≈ 58.6 bits.
 */
export function randomSlugPart(n: number = SLUG_RANDOM_LENGTH): string {
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new RangeError("randomSlugPart: n must be 1..64");
  const limit = 256 - (256 % BASE58_ALPHABET.length); // 232
  let out = "";
  const buf = new Uint8Array(n * 2);
  while (out.length < n) {
    globalThis.crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i];
      if (b < limit) out += BASE58_ALPHABET[b % BASE58_ALPHABET.length];
    }
  }
  return out;
}

/** New slug for a book: `${slugifyTitle(title)}-${random}` or just `random`. */
export function makeSlug(title: string): string {
  const base = slugifyTitle(title);
  const rand = randomSlugPart(SLUG_RANDOM_LENGTH);
  return base ? `${base}-${rand}` : rand;
}

const RANDOM_RE = /^[1-9A-HJ-NP-Za-km-z]{10}$/;
const BASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Strict check for slugs coming from a URL (`/b/[slug]`) before any DB lookup or cookie work.
 * Accepts exactly what makeSlug can produce.
 */
export function isValidSlug(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length < SLUG_RANDOM_LENGTH || s.length > SLUG_MAX_LENGTH) return false;
  const rand = s.slice(-SLUG_RANDOM_LENGTH);
  if (!RANDOM_RE.test(rand)) return false;
  if (s.length === SLUG_RANDOM_LENGTH) return true;
  if (s[s.length - SLUG_RANDOM_LENGTH - 1] !== "-") return false;
  const base = s.slice(0, -(SLUG_RANDOM_LENGTH + 1));
  return base.length >= 1 && base.length <= SLUG_BASE_MAX_LENGTH && BASE_RE.test(base);
}

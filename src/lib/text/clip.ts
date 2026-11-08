// Unicode-safe text clipping (pure, shared by client + server).
//
// Why: `s.slice(0, n)` cuts on UTF-16 code units and can leave a lone surrogate (half an emoji).
// Postgres jsonb rejects such strings ("\ud83d"), so a single bad cut makes a doc unsaveable.
// These helpers never split a surrogate pair and prefer grapheme boundaries (Intl.Segmenter),
// so ZWJ emoji sequences, flags, skin tones and Arabic letters + diacritics stay whole.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove unpaired UTF-16 surrogates (valid pairs are kept). */
export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE, "");
}

/** True when `s` contains an unpaired UTF-16 surrogate (not valid for Postgres jsonb/text). */
export function hasLoneSurrogate(s: string): boolean {
  LONE_SURROGATE.lastIndex = 0;
  const found = LONE_SURROGATE.test(s);
  LONE_SURROGATE.lastIndex = 0;
  return found;
}

/** Number of Unicode code points (what Postgres `char_length` counts). */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

type Segmenter = { segment(s: string): Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;

function graphemeSegmenter(): Segmenter | null {
  if (segmenter === undefined) {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => Segmenter }).Segmenter;
    segmenter = typeof Seg === "function" ? new Seg(undefined, { granularity: "grapheme" }) : null;
  }
  return segmenter;
}

/** Grapheme clusters when Intl.Segmenter exists, otherwise code points. */
function graphemes(s: string): string[] {
  const seg = graphemeSegmenter();
  if (!seg) return [...s];
  const out: string[] = [];
  for (const { segment } of seg.segment(s)) out.push(segment);
  return out;
}

const units = (s: string) => s.length;

function takeWithin(parts: string[], budget: number, measure: (s: string) => number): string {
  let out = "";
  let used = 0;
  for (const p of parts) {
    const m = measure(p);
    if (used + m > budget) break;
    out += p;
    used += m;
  }
  return out;
}

function clipBy(s: string, max: number, ellipsis: string, measure: (s: string) => number): string {
  const clean = stripLoneSurrogates(s);
  const limit = Math.max(0, Math.floor(max));
  if (measure(clean) <= limit) return clean;

  const ell = stripLoneSurrogates(ellipsis);
  const ellSize = measure(ell);
  // Ellipsis does not fit: hard cut on grapheme (then code point) boundaries, no ellipsis.
  if (ellSize >= limit) {
    return takeWithin(graphemes(clean), limit, measure) || takeWithin([...clean], limit, measure);
  }

  const budget = limit - ellSize;
  let head = takeWithin(graphemes(clean), budget, measure);
  // A single oversized grapheme (e.g. stacked combining marks) → fall back to code points.
  if (head === "") head = takeWithin([...clean], budget, measure);
  return head.trimEnd() + ell;
}

/**
 * Clip `s` so that `result.length` (UTF-16 units, ellipsis included) ≤ `maxUnits`.
 * Returns `s` unchanged (minus any lone surrogates) when it already fits. Cuts only on grapheme
 * boundaries (code points without Intl.Segmenter); trailing whitespace before the ellipsis is trimmed.
 */
export function clipText(s: string, maxUnits: number, ellipsis = "…"): string {
  return clipBy(s, maxUnits, ellipsis, units);
}

/** Same as clipText but the limit counts code points (Postgres char_length / TITLE_MAX_CHARS). */
export function clipCodePoints(s: string, maxCodePoints: number, ellipsis = "…"): string {
  return clipBy(s, maxCodePoints, ellipsis, codePointLength);
}

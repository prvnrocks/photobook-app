// Album origin + "may the AI replace this doc?" (D-018). Pure: safe on client and server.
//
// Rules:
// - `{}` (a fresh book, the books.doc default)          → generator "none", replaceable.
// - shape-valid doc without `meta` (written by M2)      → generator "rule", not edited, replaceable.
// - shape-valid doc with `meta`                          → from meta; replaceable iff !userEdited.
// - anything else (unparsable shape, unknown meta keys, null, arrays, …) → userEdited = true,
//   NOT replaceable. We can't prove it isn't the user's work, so we never overwrite it (safe side).
//   The generator is read from a raw `meta.generator` when it is "rule"/"ai", else "rule".
//
// This is the in-code check only. The DB write must also be conditional (writeDocIfReplaceable:
// isAiReplaceableDoc / isReplaceableDoc on the row read + `updated_at` lock in the UPDATE) so an edit that lands
// between the read and the write is never clobbered.

import { DocMetaSchema, GENERATORS, parseBookDoc } from "./schema";
import type { BookDoc, DocMeta, Generator } from "./types";

export interface DocOrigin {
  generator: Generator | "none";
  userEdited: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for exactly `{}` (a plain object with no own keys). */
export function isEmptyDoc(doc: unknown): boolean {
  return isPlainObject(doc) && Object.keys(doc).length === 0;
}

export function docOrigin(doc: unknown): DocOrigin {
  if (isEmptyDoc(doc)) return { generator: "none", userEdited: false };

  const parsed = parseBookDoc(doc);
  if (parsed.ok) {
    const meta = parsed.doc.meta;
    if (!meta) return { generator: "rule", userEdited: false };
    return { generator: meta.generator, userEdited: meta.userEdited };
  }

  // Unparsable: never overwrite.
  const raw = isPlainObject(doc) && isPlainObject(doc.meta) ? doc.meta.generator : undefined;
  const generator = (GENERATORS as readonly unknown[]).includes(raw) ? (raw as Generator) : "rule";
  return { generator, userEdited: true };
}

/**
 * `{}` or a draft nobody has marked edited. Used by "Update album" (relayout, D-028), which keeps
 * user captions. AI runs must use isAiReplaceableDoc (D-031).
 */
export function isReplaceableDoc(doc: unknown): boolean {
  const o = docOrigin(doc);
  return o.generator === "none" || !o.userEdited;
}

/**
 * True when any page caption was written by the user (`caption.source === "user"`). Reads the raw
 * value (no schema parse) so an unparsable doc with user text still counts. Cover title/subtitle
 * have no source marker; the user's `books.title` is protected separately (D-018).
 */
export function hasUserCaptions(doc: unknown): boolean {
  if (!isPlainObject(doc) || !Array.isArray(doc.pages)) return false;
  return doc.pages.some(
    (p) => isPlainObject(p) && isPlainObject(p.caption) && p.caption.source === "user",
  );
}

/**
 * May an AI run (build / rebuild / rule fallback written by a run) overwrite this doc?
 * isReplaceableDoc AND no user captions (D-031). The free "Update album" relayout (D-028) keeps
 * using isReplaceableDoc: it preserves user captions instead of replacing the doc.
 */
export function isAiReplaceableDoc(doc: unknown): boolean {
  return isReplaceableDoc(doc) && !hasUserCaptions(doc);
}

/** Copy of `doc` with `meta` set (replaced, not merged). Throws on an invalid meta (code bug). */
export function withMeta(doc: BookDoc, meta: DocMeta): BookDoc {
  return { ...doc, meta: DocMetaSchema.parse(meta) };
}

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
// isReplaceableDoc on the row read + `updated_at` lock in the UPDATE) so an edit that lands
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

/** May the AI (or a rebuild) overwrite this doc? `{}` or a draft nobody has edited. */
export function isReplaceableDoc(doc: unknown): boolean {
  const o = docOrigin(doc);
  return o.generator === "none" || !o.userEdited;
}

/** Copy of `doc` with `meta` set (replaced, not merged). Throws on an invalid meta (code bug). */
export function withMeta(doc: BookDoc, meta: DocMeta): BookDoc {
  return { ...doc, meta: DocMetaSchema.parse(meta) };
}

// Book doc versions (M10, plan decision 1). The in-memory doc is always v2 (parseBookDoc upgrades
// v1 on read). Every writer stores `serializeDoc(doc)`: v1 JSON whenever the doc uses no v2-only
// feature, so books that don't use M10 features stay byte-identical in the DB and a rollback to
// M9 code can still read them. Drop the v1 downgrade once M10c has settled.
// Pure: used by client editor, API routes, AI pipeline and tests.

import { getLayout } from "@/lib/layouts";
import { isV2CaptionFont } from "./fonts-v2";
import { DEFAULT_DESIGN_STYLE, MAX_SLOTS_V1, upgradeV1 } from "./schema";
import type { BookDoc, BookDocV1, BookPageV1 } from "./types";

/** v1 → v2, 1:1: hex background → {kind:'color'}, format unchanged, designStyle 'classic'. */
export function upgradeDocV1(v1: BookDocV1): BookDoc {
  return upgradeV1(v1);
}

/**
 * True when `doc` cannot be written as v1 without losing something: landscape format, a non-colour
 * book background, a book backgroundSource (M10c D5), a non-classic design style, any page background or spread side, more slots
 * on a page than v1 allows, a spread or non-classic layout (page or cover), or a v2-only caption
 * font (fonts-v2.ts) as book font or on a page caption. (An explicit `page.background: null` is
 * the same as absent.) Unknown layout ids are not v2 by themselves (validation rejects them).
 */
export function usesV2Features(doc: BookDoc): boolean {
  if (doc.format !== "A5_PORTRAIT") return true;
  if (doc.style.background.kind !== "color") return true;
  if (doc.style.backgroundSource !== undefined) return true;
  if ((doc.style.designStyle ?? DEFAULT_DESIGN_STYLE) !== DEFAULT_DESIGN_STYLE) return true;
  if (isV2CaptionFont(doc.style.font)) return true;
  if (isV2Layout(doc.cover.layout)) return true;
  return doc.pages.some(
    (p) =>
      (p.background !== undefined && p.background !== null) ||
      p.side !== undefined ||
      p.slots.length > MAX_SLOTS_V1 ||
      isV2Layout(p.layout) ||
      (p.caption !== null && isV2CaptionFont(p.caption.font)),
  );
}

/** A known layout that M9 cannot render: a spread, a non-classic style or a non-portrait format. */
function isV2Layout(id: string): boolean {
  const l = getLayout(id);
  return !!l && (l.role === "spread" || l.style !== DEFAULT_DESIGN_STYLE || l.format !== "A5_PORTRAIT");
}

/** v2 → v1. Caller must have checked !usesV2Features(doc). Copies only v1 keys, in v1 order. */
function downgradeToV1(doc: BookDoc): BookDocV1 {
  if (doc.style.background.kind !== "color" || doc.format !== "A5_PORTRAIT") {
    throw new Error("downgradeToV1: doc uses v2 features");
  }
  const v1: BookDocV1 = {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: doc.occasion,
    cover: { ...doc.cover },
    chapters: doc.chapters.map((c) => ({ ...c })),
    pages: doc.pages.map(
      (p): BookPageV1 => ({
        id: p.id,
        chapterId: p.chapterId,
        layout: p.layout,
        slots: p.slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
        caption: p.caption === null ? null : { ...p.caption },
      }),
    ),
    style: { background: doc.style.background.hex, font: doc.style.font },
  };
  if (doc.meta !== undefined) v1.meta = { ...doc.meta };
  return v1;
}

/** v2 doc as stored: drops `undefined` keys and normalises `background: null` to absent. */
function normaliseV2(doc: BookDoc): BookDoc {
  const out: BookDoc = {
    version: 2,
    format: doc.format,
    occasion: doc.occasion,
    cover: { ...doc.cover },
    chapters: doc.chapters.map((c) => ({ ...c })),
    pages: doc.pages.map((p) => {
      const page: BookDoc["pages"][number] = {
        id: p.id,
        chapterId: p.chapterId,
        layout: p.layout,
        slots: p.slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
        caption: p.caption === null ? null : { ...p.caption },
      };
      if (p.background) page.background = { ...p.background };
      if (p.side !== undefined) page.side = p.side;
      return page;
    }),
    style: {
      background: { ...doc.style.background },
      designStyle: doc.style.designStyle ?? DEFAULT_DESIGN_STYLE,
      font: doc.style.font,
    },
  };
  if (doc.style.backgroundSource !== undefined) out.style.backgroundSource = doc.style.backgroundSource;
  if (doc.meta !== undefined) out.meta = { ...doc.meta };
  return out;
}

/**
 * The JSON to store for `doc` (books.doc, export snapshots, AI writes): v1 when the doc uses no
 * v2-only feature, else v2. parseBookDoc(serializeDoc(doc)) deep-equals the upgraded doc.
 * Fresh objects: never aliases `doc`.
 */
export function serializeDoc(doc: BookDoc): BookDocV1 | BookDoc {
  return usesV2Features(doc) ? normaliseV2(doc) : downgradeToV1(doc);
}

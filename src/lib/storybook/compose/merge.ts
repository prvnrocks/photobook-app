// Merging a fresh composition with the book's current doc (Task 7). Pure.
//
// The composer records a content hash of every element it writes in doc.meta.story.hashes
// ("cover", "ch:<id>", "pg:<id>"). On the next composition an element of the current doc is the
// USER's when its hash is missing (the user added it) or differs (the user changed its layout,
// photos, crops, caption, texts or background) — such elements are kept byte-identical; their
// photos are reserved (never placed twice) and their page ids are never recomposed. Everything
// else is replaced by the fresh composition. A book style the user set (background, colourway)
// is kept as it is.
//
// A current doc that is not a composed storybook (no meta.story) is replaced only when an AI run
// could replace it (isAiReplaceableDoc: empty, or an unedited rule / AI album with no user
// captions, backgrounds, descriptions or page texts) — anything else is `user_edited` and nothing
// is written (the caller reports it).

import { isAiReplaceableDoc, isEmptyDoc } from "@/lib/book/replaceable";
import { repairSpreads } from "@/lib/book/spreads";
import type { BookDesign } from "@/lib/book/book-design";
import type { BookDoc, BookPage, Chapter, Cover } from "@/lib/book/types";
import { contentHash } from "./hash";

export const coverKey = "cover";
export const chapterKey = (id: string) => `ch:${id}`;
export const pageKey = (id: string) => `pg:${id}`;

/** The page as hashed: stored fields only, `background: null` = absent. */
export function pageHash(p: BookPage): string {
  const { background, ...rest } = p;
  return contentHash(background ? { ...rest, background } : rest);
}
export const chapterHash = (c: Chapter) => contentHash(c);
export function coverHash(c: Cover): string {
  const { background, ...rest } = c;
  return contentHash(background ? { ...rest, background } : rest);
}

export type UserOwned = {
  /** User pages in current-doc order. */
  pages: BookPage[];
  pageIds: Set<string>;
  /** Photos on user pages (never placed again by the composer). */
  photoIds: Set<string>;
  chapters: Map<string, Chapter>;
  cover: Cover | null;
  /** The current doc's style (kept for composed books). */
  style: BookDoc["style"] | null;
  /** Stored hashes of the user elements (kept so they stay the user's). */
  hashes: Record<string, string>;
};

export type OwnershipResult = { ok: true; owned: UserOwned } | { ok: false; reason: "user_edited" };

const NONE = (): UserOwned => ({ pages: [], pageIds: new Set(), photoIds: new Set(), chapters: new Map(), cover: null, style: null, hashes: {} });

/**
 * What of `current` (parsed books.doc, or null for `{}` / unparsable-but-replaceable) the user
 * owns. `raw` = the stored value (for the replaceability rules on non-story docs).
 */
export function userOwnedElements(current: BookDoc | null, raw: unknown): OwnershipResult {
  if (current === null) return isEmptyDoc(raw) || raw === null || raw === undefined || isAiReplaceableDoc(raw) ? { ok: true, owned: NONE() } : { ok: false, reason: "user_edited" };
  const story = current.meta?.story;
  if (!story) return isAiReplaceableDoc(raw) ? { ok: true, owned: NONE() } : { ok: false, reason: "user_edited" };
  const owned = NONE();
  owned.style = current.style;
  for (const p of current.pages) {
    const stored = story.hashes[pageKey(p.id)];
    if (stored !== undefined && stored === pageHash(p)) continue;
    owned.pages.push(p);
    owned.pageIds.add(p.id);
    if (stored !== undefined) owned.hashes[pageKey(p.id)] = stored;
    for (const s of p.slots) if (s.photoId) owned.photoIds.add(s.photoId);
  }
  for (const c of current.chapters) {
    const stored = story.hashes[chapterKey(c.id)];
    if (stored !== undefined && stored === chapterHash(c)) continue;
    owned.chapters.set(c.id, c);
    if (stored !== undefined) owned.hashes[chapterKey(c.id)] = stored;
  }
  const coverStored = story.hashes[coverKey];
  if (coverStored === undefined || coverStored !== coverHash(current.cover)) {
    owned.cover = current.cover;
    if (coverStored !== undefined) owned.hashes[coverKey] = coverStored;
  }
  return { ok: true, owned };
}

export type MergeInput = {
  fresh: BookDoc;
  current: BookDoc | null;
  owned: UserOwned;
  design: BookDesign;
  storybookVersion: number;
};

/**
 * The doc to store: fresh pages in order with every user page placed back after the page that
 * preceded it in the current doc (else first), user chapters / cover kept, the current style
 * kept for composed books, hashes of every composer-written element recorded. Spreads the merge
 * misaligned are split (repairSpreads) — only possible when the user made spreads.
 */
export function mergeComposition({ fresh, current, owned, design, storybookVersion }: MergeInput): BookDoc {
  const pages: BookPage[] = fresh.pages.filter((p) => !owned.pageIds.has(p.id));
  if (current) {
    current.pages.forEach((p, idx) => {
      if (!owned.pageIds.has(p.id)) return;
      let at = 0;
      for (let k = idx - 1; k >= 0; k--) {
        const prevId = current.pages[k]!.id;
        const found = pages.findIndex((x) => x.id === prevId);
        if (found >= 0) {
          at = found + 1;
          break;
        }
      }
      pages.splice(at, 0, p);
    });
  }

  const chapterIds = new Set(pages.map((p) => p.chapterId).filter((x): x is string => !!x));
  const chapters: Chapter[] = fresh.chapters.map((c) => owned.chapters.get(c.id) ?? c);
  // a chapter only a user page still uses (gone from the story): kept as it is
  for (const c of current?.chapters ?? []) if (chapterIds.has(c.id) && !chapters.some((x) => x.id === c.id)) chapters.push(owned.chapters.get(c.id) ?? c);

  const cover = owned.cover ?? fresh.cover;
  const style = owned.style ? { ...owned.style, designStyle: design.designStyle } : fresh.style;
  const userAny = owned.pages.length > 0 || owned.cover !== null || owned.chapters.size > 0;

  let doc: BookDoc = {
    ...fresh,
    format: design.format,
    cover,
    chapters: chapters.filter((c) => chapterIds.has(c.id)),
    pages,
    style,
  };
  if (current?.filters) {
    const placed = new Set([cover.photoId, ...pages.flatMap((p) => p.slots.map((s) => s.photoId))].filter((x): x is string => !!x));
    const filters = Object.fromEntries(Object.entries(current.filters).filter(([id]) => placed.has(id)));
    if (Object.keys(filters).length) doc.filters = filters;
  }
  doc = repairSpreads(doc).doc;

  const hashes: Record<string, string> = { ...owned.hashes };
  if (!owned.cover) hashes[coverKey] = coverHash(doc.cover);
  for (const c of doc.chapters) if (!owned.chapters.has(c.id)) hashes[chapterKey(c.id)] = chapterHash(c);
  for (const p of doc.pages) {
    if (owned.pageIds.has(p.id)) continue;
    hashes[pageKey(p.id)] = pageHash(p);
  }
  const meta = fresh.meta!;
  doc.meta = {
    generator: meta.generator,
    generatorVersion: meta.generatorVersion,
    runId: meta.runId,
    userEdited: userAny && current?.meta?.userEdited === true,
    story: { v: 1, version: storybookVersion, hashes: sortKeys(hashes) },
  };
  return doc;
}

function sortKeys(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

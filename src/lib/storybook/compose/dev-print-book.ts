// Fixture storybooks for print checks (Task 7 /dev-print?story=, extended in Task 10). Pure and
// deterministic: a storyFixture storybook composed by the real page composer, optionally with the
// user edits the editor would save. Shared by /dev-print (what Chromium renders) and
// tests/print-fixtures.live.test.ts (which needs the same doc to plan chunks and check the PDF).
// Never used by the product.

import { setCover, setPageText } from "@/lib/book/edit-ops";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { composeStoryDoc } from "./compose";
import { DEV_EDIT_TEXT, devStoryRenderPhotos, storyFixture } from "./dev-fixture";

export type DevPrintBookOptions = {
  /** Photos in the fixture (≥ 40 composes with the paid page limit). Default 24. */
  photos?: number;
  /** Every 3rd photo stored at 800 × 600 px (default: only photo 5). */
  lowRes?: boolean;
  /** Apply a user page text + title (DEV_EDIT_TEXT). */
  edits?: boolean;
};

export function devStoryPrintBook(style: DesignStyle, format: BookFormat, lang: "en" | "ar", opts: DevPrintBookOptions = {}) {
  const count = opts.photos ?? 24;
  const design = { format, designStyle: style };
  const maxPages = count >= 40 ? 100 : 20;
  const lowRes = opts.lowRes ? Array.from({ length: count }, (_, i) => i + 1).filter((n) => n % 3 === 0) : [5];
  const f = storyFixture({ photos: count, lang, design, lowRes, maxPages });
  let doc = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang, occasion: "travel", bookTitle: null, maxPages }).doc;
  if (opts.edits) {
    const at = doc.pages.findIndex((p) => (p.texts ?? []).length > 0);
    if (at >= 0) doc = setPageText(doc, at, doc.pages[at]!.texts![0]!.panel, DEV_EDIT_TEXT.page);
    doc = setCover(doc, { title: DEV_EDIT_TEXT.title });
  }
  return { doc, photos: devStoryRenderPhotos(f.photos), fixturePhotos: f.photos, maxPages };
}

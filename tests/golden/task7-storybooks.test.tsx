// Task 7 — goldens for COMPOSED storybooks (the page composer's output rendered by <BookPage>), so
// later changes cannot drift them unnoticed:
//
//   books/<style>-<shape>/  a 24-photo fixture storybook (mixed orientations, one low-resolution
//                           photo), English, composed deterministically (no AI): doc.json (as
//                           stored, serializeDoc) + view.html (cover + every page, screen mode).
//                           All six styles × both formats.
//   hashes.json             SHA-256 of doc + view + print markup for the other cases of every
//                           style × format: 10 photos, 60 photos (free, 20 pages), 60 photos on a
//                           paid book, an Arabic book, a book with several low-resolution photos.
//
// Composing twice is byte-identical (asserted). The older goldens (m9 … m30) are separate files
// and stay unchanged. An intended change → `GOLDEN_UPDATE=1 npx vitest run tests/golden/task7-storybooks.test.tsx`
// and review the git diff of tests/golden/fixtures/task7/.

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { serializeDoc } from "@/lib/book/doc-version";
import type { RenderPhotos } from "@/lib/book/render";
import { BOOK_FORMATS, DESIGN_STYLES } from "@/lib/book/schema";
import type { BookDoc, BookFormat, DesignStyle } from "@/lib/book/types";
import { composeStoryDoc } from "@/lib/storybook/compose";
import { storyFixture, type StoryFixtureOptions } from "@/lib/storybook/compose/dev-fixture";
import { expectGolden, GOLDEN_DIR, GOLDEN_UPDATE, goldenJson, listGoldenFiles, splitTags } from "./golden";

const PREFIX = "task7";
const OWNED = new Set<string>();
function golden(name: string, actual: string) {
  OWNED.add(`${PREFIX}/${name}`);
  expectGolden(`${PREFIX}/${name}`, actual);
}
const shape = (f: BookFormat) => (f === "A5_PORTRAIT" ? "portrait" : "landscape");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function compose(style: DesignStyle, format: BookFormat, o: Partial<StoryFixtureOptions> & { maxPages?: number } = {}) {
  const design = { format, designStyle: style };
  const f = storyFixture({ photos: 24, lowRes: [5], ...o, design, maxPages: o.maxPages ?? 20 });
  const r = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang: o.lang ?? "en", occasion: "travel", bookTitle: null, maxPages: o.maxPages ?? 20 });
  const photos: RenderPhotos = Object.fromEntries(f.photos.map((p) => [p.id, { url: `https://photos.test/${p.id}.jpg`, width: p.width, height: p.height }]));
  return { doc: r.doc, report: r.report, photos, lang: o.lang ?? "en" };
}

function bookMarkup(doc: BookDoc, mode: BookRenderMode, photos: RenderPhotos, lang: string): string {
  const parts = [`<!-- cover ${doc.cover.layout} -->`, splitTags(renderToStaticMarkup(<BookPage doc={doc} page="cover" mode={mode} photos={photos} captionLang={lang} />))];
  doc.pages.forEach((p, i) => {
    parts.push(`<!-- page ${i} ${p.id} ${p.layout} -->`);
    parts.push(splitTags(renderToStaticMarkup(<BookPage doc={doc} page={i} mode={mode} photos={photos} captionLang={lang} />)));
  });
  return `${parts.join("\n")}\n`;
}

describe("golden task7: composed storybooks, every style × format", () => {
  for (const style of DESIGN_STYLES) {
    for (const format of BOOK_FORMATS) {
      const dir = `books/${style}-${shape(format)}`;
      it(`${dir}: doc + view markup; composing twice is byte-identical`, () => {
        const a = compose(style, format);
        const b = compose(style, format);
        const json = goldenJson(serializeDoc(a.doc));
        expect(goldenJson(serializeDoc(b.doc))).toBe(json);
        const html = bookMarkup(a.doc, "view", a.photos, "en");
        expect(html).toContain('data-text-panel="pageText"');
        expect(html).not.toMatch(/<script/i);
        golden(`${dir}/doc.json`, json);
        golden(`${dir}/view.html`, html);
      });
    }
  }
});

describe("golden task7: other cases (hashes)", () => {
  const CASES: Record<string, Partial<StoryFixtureOptions> & { maxPages?: number }> = {
    "photos-10": { photos: 10 },
    "photos-60-free": { photos: 60 },
    "photos-60-paid": { photos: 60, maxPages: 100 },
    arabic: { lang: "ar" },
    "low-res": { photos: 16, lowRes: [1, 2, 5, 9, 13] },
  };
  it("hashes.json", () => {
    const out: Record<string, Record<string, { pages: number; narrative: number; doc: string; view: string; print: string }>> = {};
    for (const [name, o] of Object.entries(CASES)) {
      out[name] = {};
      for (const style of DESIGN_STYLES) {
        for (const format of BOOK_FORMATS) {
          const c = compose(style, format, o);
          out[name][`${style}-${shape(format)}`] = {
            pages: c.report.interiorPages,
            narrative: c.report.balance.narrativeShare,
            doc: sha(JSON.stringify(serializeDoc(c.doc))),
            view: sha(bookMarkup(c.doc, "view", c.photos, c.lang)),
            print: sha(bookMarkup(c.doc, "print", c.photos, c.lang)),
          };
          if (name === "arabic") expect(bookMarkup(c.doc, "view", c.photos, c.lang)).toContain('lang="ar"');
        }
      }
    }
    golden("hashes.json", goldenJson(out));
  });
});

describe("golden task7: no orphaned golden files", () => {
  it("every file under fixtures/task7 is owned by a case", () => {
    const existing = listGoldenFiles(join(GOLDEN_DIR, PREFIX));
    const orphans = existing.filter((f) => !OWNED.has(f));
    if (GOLDEN_UPDATE) {
      for (const f of orphans) unlinkSync(join(GOLDEN_DIR, f));
      return;
    }
    expect(orphans).toEqual([]);
    expect(existing).toEqual([...OWNED].sort());
  });
});

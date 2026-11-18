// M30 T14a — golden set for whole magazine + editorial BOOKS (D-090), so later milestones cannot
// drift them unnoticed:
//
//   rule/<style>-<shape>-<lang>/      a RULE-built album (buildRuleDraft: autolayout → book design →
//                                     rule backgrounds → suggested accent colourway; what AI off /
//                                     an AI failure gives the user). doc.json + the <BookPage> markup
//                                     of the cover and every page in screen (view) and print mode.
//                                     All four designs in English, both portrait designs in Arabic.
//   described/<style>-<shape>-<lang>/ the small book with chapter descriptions an AI build makes
//                                     (m30EditorDoc — the /dev-editor?style=… fixture: description
//                                     pages, a chapter without one, a spread, an AI colourway), in
//                                     English and Arabic, view + print, plus the edit-mode markup
//                                     (description tap targets incl. the empty one).
//
// Per-layout geometry is covered by tests/m30-render.test.tsx / m30-g0.test.tsx and the layout
// hashes by tests/autolayout-m30-golden.test.ts; this file freezes the RENDERED books.
// The m9 / m10b / m10c / m29 goldens are separate files and must stay byte-identical.
// An intended rendering change → `GOLDEN_UPDATE=1 npx vitest run tests/golden/m30-books.test.tsx`
// and review the git diff of tests/golden/fixtures/m30/ (that diff IS the visual change).

import type { ReactElement } from "react";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { m30EditorDoc } from "@/lib/book/dev-m30";
import { devSamplePhotos } from "@/lib/book/dev-sample";
import type { RenderPhotos } from "@/lib/book/render";
import { buildRuleDraft, type DraftPhotoRow } from "@/lib/book/rule-draft";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc, BookFormat } from "@/lib/book/types";
import { colourwaysFor } from "@/lib/design/colourways";
import { getLayout } from "@/lib/layouts";
import { layoutIdShowsDescription } from "@/lib/layouts/description";
import { printRenderPhotos } from "@/lib/pdf/print-doc";
import { momentSet } from "../fixtures/autolayout-sets";
import { expectGolden, GOLDEN_DIR, GOLDEN_UPDATE, goldenJson, listGoldenFiles, splitTags } from "./golden";

const PREFIX = "m30";
const OWNED = new Set<string>();
function golden(name: string, actual: string) {
  OWNED.add(`${PREFIX}/${name}`);
  expectGolden(`${PREFIX}/${name}`, actual);
}

type Style = "magazine" | "editorial";
type Lang = "en" | "ar";
const STYLES: readonly Style[] = ["magazine", "editorial"];
const FORMATS: readonly BookFormat[] = ["A5_PORTRAIT", "A5_LANDSCAPE"];
const shape = (f: BookFormat) => (f === "A5_PORTRAIT" ? "portrait" : "landscape");
const DESCRIPTION_PANEL = 'data-text-panel="chapterDescription"';

const markup = (el: ReactElement) => splitTags(renderToStaticMarkup(el));

/** Cover + every page of a book in one reviewable file (one tag per line, a marker line per page). */
function bookMarkup(doc: BookDoc, mode: BookRenderMode, photos: RenderPhotos, lang: Lang): string {
  const parts = [`<!-- cover ${doc.cover.layout} -->`, markup(<BookPage doc={doc} page="cover" mode={mode} photos={photos} captionLang={lang} />)];
  doc.pages.forEach((p, i) => {
    parts.push(`<!-- page ${i} ${p.layout}${p.side ? ` ${p.side}` : ""} -->`);
    parts.push(markup(<BookPage doc={doc} page={i} mode={mode} photos={photos} captionLang={lang} />));
  });
  return `${parts.join("\n")}\n`;
}

// --- rule-built albums ---------------------------------------------------------------------------

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Dominant colours cycling through warm / cool / neutral, so the colourway vote has something to count. */
const COLOURS = ["#C8743A", "#2F6F8F", "#8C9A5B", "#D9B36C", "#3B4A5A", "#B5533C", "#6FA8A0", null] as const;

/** 26 photos in a few moments (the autolayout fixture set) as ready `photos` rows with uuid ids. */
function photoRows(seed: number): DraftPhotoRow[] {
  return momentSet(26, seed).map((p, i) => ({
    id: uuid(i + 1),
    width: p.width,
    height: p.height,
    taken_at: p.takenAt,
    date_source: p.dateSource,
    place: p.place,
    blur_score: p.blurScore,
    status: p.status,
    dup_group: p.dupGroup,
    color: COLOURS[i % COLOURS.length],
  }));
}

const TITLE: Record<Lang, string> = { en: "Ten days across the Hajar peaks", ar: "عشرة أيام بين قمم جبال الحجر" };

const RULE_BOOKS: Array<{ style: Style; format: BookFormat; lang: Lang }> = [
  ...STYLES.flatMap((style) => FORMATS.map((format) => ({ style, format, lang: "en" as const }))),
  { style: "magazine", format: "A5_PORTRAIT", lang: "ar" },
  { style: "editorial", format: "A5_PORTRAIT", lang: "ar" },
];

describe("golden m30: rule-built magazine + editorial albums (no AI)", () => {
  for (const b of RULE_BOOKS) {
    const dir = `rule/${b.style}-${shape(b.format)}-${b.lang}`;
    describe(dir, () => {
      const rows = photoRows(b.style === "magazine" ? 2611 : 2612);
      const screen: RenderPhotos = Object.fromEntries(rows.map((r) => [r.id, { url: `/dev/photo/${r.id}.jpg`, width: r.width, height: r.height }]));
      const print = printRenderPhotos(rows.map((r) => ({ id: r.id, width: r.width, height: r.height })));
      const build = () => {
        const r = buildRuleDraft(rows, { occasion: "travel", title: TITLE[b.lang], captionLang: b.lang, isPaid: false, design: { format: b.format, designStyle: b.style } });
        if (!r.ok) throw new Error(`rule draft refused: ${r.reason}`);
        return r;
      };

      it("builds a valid free album of this design: no descriptions, no description layouts, an AI-suggested colourway", () => {
        const { doc, pageCount } = build();
        expect(parseBookDoc(doc).ok).toBe(true);
        expect(doc.version).toBe(2);
        expect({ format: doc.format, style: doc.style.designStyle }).toEqual({ format: b.format, style: b.style });
        expect(pageCount).toBe(doc.pages.length);
        expect(doc.pages.length).toBeGreaterThanOrEqual(6);
        expect(doc.pages.length).toBeLessThanOrEqual(20);
        expect(getLayout(doc.cover.layout)).toMatchObject({ role: "cover", style: b.style, format: b.format });
        expect(getLayout(doc.cover.layout)?.autoPick).not.toBe(false);
        for (const p of doc.pages) expect(getLayout(p.layout), p.layout).toMatchObject({ style: b.style, format: b.format });
        // A rule album has no chapter descriptions, so it never picks a layout that would show an
        // empty description panel (PLAN: "rule/AI-off albums show no description panel text").
        expect(doc.chapters.filter((c) => c.description)).toEqual([]);
        expect(doc.pages.filter((p) => layoutIdShowsDescription(p.layout)).map((p) => p.layout)).toEqual([]);
        expect(doc.pages.every((p) => p.caption === null)).toBe(true);
        expect(doc.style.colourway?.source).toBe("ai");
        expect(colourwaysFor(b.style).map((c) => c.id)).toContain(doc.style.colourway?.id);
      });

      it("doc.json", () => {
        golden(`${dir}/doc.json`, goldenJson(build().doc));
      });

      for (const mode of ["view", "print"] as const) {
        it(`${mode}.html — cover + every page`, () => {
          const { doc } = build();
          const html = bookMarkup(doc, mode, mode === "print" ? print : screen, b.lang);
          expect(html).not.toContain(DESCRIPTION_PANEL);
          expect(html).not.toContain("data-description-area");
          expect(html).toContain('data-text-panel="coverTitle"');
          expect(html.match(/<!-- (cover|page) /g)).toHaveLength(doc.pages.length + 1);
          golden(`${dir}/${mode}.html`, html);
        });
      }
    });
  }
});

// --- books with chapter descriptions -------------------------------------------------------------

const SAMPLE_SCREEN: RenderPhotos = devSamplePhotos();
const SAMPLE_PRINT: RenderPhotos = printRenderPhotos(Object.entries(SAMPLE_SCREEN).map(([id, p]) => ({ id, width: p?.width ?? null, height: p?.height ?? null })));

describe("golden m30: magazine + editorial books with chapter descriptions", () => {
  for (const style of STYLES) {
    for (const format of FORMATS) {
      for (const lang of ["en", "ar"] as const) {
        const dir = `described/${style}-${shape(format)}-${lang}`;
        describe(dir, () => {
          const doc = m30EditorDoc(style, format, { arabic: lang === "ar" });

          it("fixture: two AI descriptions, one description page whose chapter has none, the style's second colourway", () => {
            expect(parseBookDoc(doc).ok).toBe(true);
            expect(doc.chapters.map((c) => c.description?.source ?? null)).toEqual(["ai", null, "ai", null]);
            expect(layoutIdShowsDescription(doc.pages[0].layout)).toBe(true);
            expect(layoutIdShowsDescription(doc.pages[2].layout)).toBe(true);
            expect(doc.style.colourway).toEqual({ id: colourwaysFor(style)[1].id, source: "ai" });
          });

          for (const mode of ["view", "print"] as const) {
            it(`${mode}.html — cover + every page`, () => {
              const html = bookMarkup(doc, mode, mode === "print" ? SAMPLE_PRINT : SAMPLE_SCREEN, lang);
              // Chapter 1's description page draws the paragraph; chapter 2's draws nothing there.
              expect(html).toContain(DESCRIPTION_PANEL);
              expect(html).not.toContain("data-description-area");
              golden(`${dir}/${mode}.html`, html);
            });
          }

          it("edit.html — description tap targets (filled + empty) on the description pages", () => {
            const parts: string[] = [];
            doc.pages.forEach((p, i) => {
              if (!layoutIdShowsDescription(p.layout)) return;
              parts.push(`<!-- page ${i} ${p.layout}${p.side ? ` ${p.side}` : ""} -->`);
              parts.push(
                markup(
                  <BookPage
                    doc={doc}
                    page={i}
                    mode="edit"
                    photos={{}}
                    captionLang={lang}
                    renderSlotOverlay={(s, owner) => <span data-overlay={`${owner}:${s}`} />}
                    renderCaption={(c, m, ink, owner) => <span data-edit-caption={`${owner}:${ink}:${m.align}`}>{c?.text ?? ""}</span>}
                    renderDescription={(a) => <span data-edit-description={`${a.ownerIndex}:${a.empty ? "empty" : "filled"}`} />}
                  />,
                ),
              );
            });
            const html = `${parts.join("\n")}\n`;
            expect(html).toContain('data-description-area="filled"');
            expect(html).toContain('data-description-area="empty"');
            golden(`${dir}/edit.html`, html);
          });
        });
      }
    }
  }
});

describe("golden m30: no orphaned golden files", () => {
  it("every file under fixtures/m30 is owned by a case", () => {
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

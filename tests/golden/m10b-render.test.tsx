// M10b A9 — golden set for the new layouts (classic landscape, modern portrait, modern landscape):
// <BookPage> markup for every layout × format in screen (view) and print modes — both halves of
// every spread, every cover — with English and Arabic text, plus edit-mode markup of a few cases
// and the render models of both sample books. Files: tests/golden/fixtures/m10b/ (one tag per line).
//
// The classic A5 portrait goldens (m9-render.test.tsx) are separate and must stay byte-identical.
// Layout geometry signed off by the user 2026-11-11; an intended change → regenerate with
// `GOLDEN_UPDATE=1 npx vitest run tests/golden/m10b-render.test.tsx` and review the diff.

import type { ReactElement } from "react";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import { coverRenderModel, pageRenderModel, type RenderPhotos } from "@/lib/book/render";
import type { BookDoc, BookPage as DocPage, Caption, Layout } from "@/lib/book/types";
import { CLASSIC_LANDSCAPE_LAYOUTS } from "@/lib/layouts/classic/landscape";
import { MODERN_LANDSCAPE_LAYOUTS } from "@/lib/layouts/modern/landscape";
import { MODERN_PORTRAIT_LAYOUTS } from "@/lib/layouts/modern/portrait";
import { printRenderPhotos } from "@/lib/pdf/print-doc";
import { expectGolden, GOLDEN_DIR, GOLDEN_UPDATE, goldenJson, listGoldenFiles, splitTags } from "./golden";

const PREFIX = "m10b";
const OWNED = new Set<string>();
function golden(name: string, actual: string) {
  OWNED.add(`${PREFIX}/${name}`);
  expectGolden(`${PREFIX}/${name}`, actual);
}

const LAYOUTS: readonly Layout[] = [...CLASSIC_LANDSCAPE_LAYOUTS, ...MODERN_PORTRAIT_LAYOUTS, ...MODERN_LANDSCAPE_LAYOUTS];
const SCREEN = devSamplePhotos();
const PRINT: RenderPhotos = printRenderPhotos(
  Object.entries(SCREEN).map(([id, p]) => ({ id, width: p?.width ?? null, height: p?.height ?? null })),
);
const photosFor = (mode: BookRenderMode) => (mode === "print" ? PRINT : SCREEN);
const markup = (el: ReactElement) => `${splitTags(renderToStaticMarkup(el))}\n`;

const EN: Caption = { text: "The longest table, the loudest laughs, and everyone we love.", font: "Playfair", align: "center", source: "ai" };
const AR: Caption = { text: "أجمل ليلة بدأت بضحكة، وانتهت بذكرى لا تُنسى", font: "Cairo", align: "center", source: "ai" };
const CHAPTERS = {
  en: { id: "c1", title: "The mehndi night", dateLabel: "12 Oct 2026", place: null },
  ar: { id: "c1", title: "ليلة العمر", dateLabel: "١٢ أكتوبر ٢٠٢٦", place: null },
};

/** A doc of the layout's format/style with `layout` on pages[0] (spreads: pages[0..1]) or as cover. */
function docFor(l: Layout, lang: "en" | "ar"): BookDoc {
  const modern = l.style !== "classic";
  const cap = l.caption ? { ...(lang === "ar" ? AR : EN), ...(modern ? { font: lang === "ar" ? "Amiri" : "Cormorant" } : {}) } : null;
  const page = (id: string, layout: Layout, slots: number): DocPage => ({
    id,
    chapterId: "c1",
    layout: layout.id,
    slots: Array.from({ length: slots }, (_, i) => ({ photoId: `sp${i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
    caption: layout.role === "cover" ? null : cap,
  });
  const pages: DocPage[] =
    l.role === "spread"
      ? [
          { ...page("g0", l, l.slots.length), side: "left" },
          { id: "g1", chapterId: "c1", layout: l.id, side: "right", slots: [], caption: null },
        ]
      : l.role === "page"
        ? [page("g0", l, l.slots.length)]
        : [];
  const coverLayout = l.role === "cover" ? l.id : LAYOUTS.find((c) => c.role === "cover" && c.format === l.format && c.style === l.style)!.id;
  return {
    version: 2,
    format: l.format,
    occasion: "wedding",
    cover: {
      layout: coverLayout,
      photoId: "d0",
      title: lang === "ar" ? "سارة وعمر" : "Sara & Omar",
      subtitle: lang === "ar" ? "أبوظبي · ٢٠٢٦" : "Abu Dhabi · 2026",
    },
    chapters: [CHAPTERS[lang]],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: l.style, font: modern ? "Cormorant" : "Playfair" },
  };
}

/** The doc page(s) a layout renders on: cover, single page 0, or both spread halves. */
function targets(l: Layout): Array<{ name: string; page: number | "cover" }> {
  if (l.role === "cover") return [{ name: "cover", page: "cover" }];
  if (l.role === "page") return [{ name: "page", page: 0 }];
  return [
    { name: "left", page: 0 },
    { name: "right", page: 1 },
  ];
}

describe("golden m10b: every new layout × screen/print × EN/AR", () => {
  for (const l of LAYOUTS) {
    describe(l.id, () => {
      for (const lang of ["en", "ar"] as const) {
        for (const mode of ["view", "print"] as const) {
          for (const t of targets(l)) {
            const file = `${l.format === "A5_PORTRAIT" ? "portrait" : "landscape"}/${l.id}/${t.name}-${mode}-${lang}.html`;
            it(file, () => {
              golden(file, markup(<BookPage doc={docFor(l, lang)} page={t.page} mode={mode} photos={photosFor(mode)} captionLang={lang} />));
            });
          }
        }
      }
      // Edit mode once per layout target (English): placeholders, overlays, caption/cover-text targets.
      for (const t of targets(l)) {
        const file = `${l.format === "A5_PORTRAIT" ? "portrait" : "landscape"}/${l.id}/${t.name}-edit-en.html`;
        it(file, () => {
          golden(
            file,
            markup(
              <BookPage
                doc={docFor(l, "en")}
                page={t.page}
                mode="edit"
                photos={{}}
                captionLang="en"
                renderSlotOverlay={(i, owner) => <span data-overlay={`${owner}:${i}`} />}
                renderCaption={(c, m, ink, owner) => <span data-edit-caption={`${owner}:${ink}:${m.align}`}>{c?.text ?? ""}</span>}
                renderCoverTextOverlay={() => <span data-edit-cover="" />}
              />,
            ),
          );
        });
      }
    });
  }
});

describe("golden m10b: sample books", () => {
  for (const sample of ["modern-portrait", "modern-landscape"] as const) {
    it(`${sample} render models (screen + bleed)`, () => {
      const doc = devSampleDoc(sample);
      golden(
        `samples/${sample}-render-models.json`,
        goldenJson({
          cover: { screen: coverRenderModel(doc, SCREEN, "en"), bleed: coverRenderModel(doc, PRINT, "en", { bleed: true }) },
          pages: doc.pages.map((_p, i) => ({
            index: i,
            screen: pageRenderModel(doc, i, SCREEN, "en"),
            bleed: pageRenderModel(doc, i, PRINT, "en", { bleed: true }),
          })),
        }),
      );
    });
  }
});

describe("golden m10b: no orphaned golden files", () => {
  it("every file under fixtures/m10b is owned by a case", () => {
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

// M10c T15 — golden set for the geometric + scrapbook layouts (portrait + landscape):
// <BookPage> markup for every g-* / s-* layout in screen (view) and print modes — both halves of
// every spread, every cover — with English and Arabic text (decorations, label plates, frames,
// tilt, crisp drawn shadows, shaped clips all live in this markup), edit-mode markup per layout
// target, the occasion accent sticker on every cover, faded-photo / texture backgrounds, and the
// render models of all eight m10c dev samples. Files: tests/golden/fixtures/m10c/ (one tag per line).
//
// The m9 (classic portrait) and m10b goldens are separate and must stay byte-identical.
// Layout geometry signed off by the user at G1 (2026-11-11); an intended change → regenerate with
// `GOLDEN_UPDATE=1 npx vitest run tests/golden/m10c-render.test.tsx` and review the diff.

import type { ReactElement } from "react";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { devSampleDoc, devSamplePhotos, M10C_SAMPLES } from "@/lib/book/dev-sample";
import { coverRenderModel, pageRenderModel, type RenderPhotos } from "@/lib/book/render";
import type { Background, BookDoc, BookPage as DocPage, Caption, Layout, Occasion } from "@/lib/book/types";
import { GEOMETRIC_LANDSCAPE_LAYOUTS } from "@/lib/layouts/geometric/landscape";
import { GEOMETRIC_PORTRAIT_LAYOUTS } from "@/lib/layouts/geometric/portrait";
import { SCRAPBOOK_LANDSCAPE_LAYOUTS } from "@/lib/layouts/scrapbook/landscape";
import { SCRAPBOOK_PORTRAIT_LAYOUTS } from "@/lib/layouts/scrapbook/portrait";
import { printRenderPhotos } from "@/lib/pdf/print-doc";
import { expectGolden, GOLDEN_DIR, GOLDEN_UPDATE, goldenJson, listGoldenFiles, splitTags } from "./golden";

const PREFIX = "m10c";
const OWNED = new Set<string>();
function golden(name: string, actual: string) {
  OWNED.add(`${PREFIX}/${name}`);
  expectGolden(`${PREFIX}/${name}`, actual);
}

/**
 * Explicit list: a new or renamed m10c layout must be added here on purpose (and its goldens
 * reviewed), never picked up silently. Order = catalogue order (append-only, AI prompt cache).
 */
const EXPECTED_IDS = {
  geometricPortrait: [
    "g-p-cover",
    "g-p-one-band",
    "g-p-two-diag",
    "g-p-two-circle",
    "g-p-three-diamond",
    "g-p-four-petals",
    "g-p-five-hex",
    "g-p-spread-band",
    "g-p-two-pair",
  ],
  geometricLandscape: [
    "g-l-cover",
    "g-l-one-band",
    "g-l-two-diag",
    "g-l-two-circle",
    "g-l-three-diamond",
    "g-l-four-petals",
    "g-l-five-hex",
    "g-l-spread-band",
    "g-l-two-stack",
  ],
  scrapbookPortrait: [
    "s-p-cover-polaroid",
    "s-p-one-polaroid",
    "s-p-two-overlap",
    "s-p-two-land",
    "s-p-three-pile",
    "s-p-four-pinned",
    "s-p-five-collage",
    "s-p-spread-hero",
    "s-p-spread-wall",
  ],
  scrapbookLandscape: [
    "s-l-cover-polaroid",
    "s-l-one-polaroid",
    "s-l-two-overlap",
    "s-l-two-land",
    "s-l-three-row",
    "s-l-four-scatter",
    "s-l-five-collage",
    "s-l-spread-hero",
    "s-l-spread-wall",
  ],
};

const LISTS = {
  geometricPortrait: GEOMETRIC_PORTRAIT_LAYOUTS,
  geometricLandscape: GEOMETRIC_LANDSCAPE_LAYOUTS,
  scrapbookPortrait: SCRAPBOOK_PORTRAIT_LAYOUTS,
  scrapbookLandscape: SCRAPBOOK_LANDSCAPE_LAYOUTS,
} as const;

const LAYOUTS: readonly Layout[] = [
  ...GEOMETRIC_PORTRAIT_LAYOUTS,
  ...GEOMETRIC_LANDSCAPE_LAYOUTS,
  ...SCRAPBOOK_PORTRAIT_LAYOUTS,
  ...SCRAPBOOK_LANDSCAPE_LAYOUTS,
];

/** A faded-photo background needs a uuid photo id (schema); it renders the d3 placeholder. */
const BG_PHOTO = "0b7c5e2a-9d41-4c3e-8f6a-2d1e0c9b8a71";
const SCREEN: RenderPhotos = { ...devSamplePhotos(), [BG_PHOTO]: devSamplePhotos().sp2 };
const PRINT: RenderPhotos = printRenderPhotos(
  Object.entries(SCREEN).map(([id, p]) => ({ id, width: p?.width ?? null, height: p?.height ?? null })),
);
const photosFor = (mode: BookRenderMode) => (mode === "print" ? PRINT : SCREEN);
const markup = (el: ReactElement) => `${splitTags(renderToStaticMarkup(el))}\n`;

const EN: Caption = { text: "Narrow lanes, warm stone walls, and the slow light of late afternoon.", font: "Cormorant", align: "center", source: "ai" };
const AR: Caption = { text: "أزقة ضيقة وجدران دافئة وضوء العصر الهادئ", font: "Amiri", align: "center", source: "ai" };
const CHAPTERS = {
  en: { id: "c1", title: "Old town walks", dateLabel: "3 Nov 2026", place: null },
  ar: { id: "c1", title: "جولة في المدينة القديمة", dateLabel: "٣ نوفمبر ٢٠٢٦", place: null },
};
const OCCASIONS: readonly Occasion[] = ["wedding", "travel", "graduation", "baby", "family", "other"];

const fmt = (l: Layout) => (l.format === "A5_PORTRAIT" ? "portrait" : "landscape");

/** A doc of the layout's format/style with `layout` on pages[0] (spreads: pages[0..1]) or as cover. */
function docFor(
  l: Layout,
  lang: "en" | "ar",
  opts: { occasion?: Occasion; background?: Background; pageBackground?: DocPage["background"] } = {},
): BookDoc {
  const cap = l.caption ? (lang === "ar" ? AR : EN) : null;
  const page = (id: string, layout: Layout, slots: number): DocPage => ({
    id,
    chapterId: "c1",
    layout: layout.id,
    slots: Array.from({ length: slots }, (_, i) => ({ photoId: `sp${i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
    caption: layout.role === "cover" ? null : cap,
    ...(opts.pageBackground ? { background: opts.pageBackground } : {}),
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
    occasion: opts.occasion ?? (l.style === "scrapbook" ? "baby" : "travel"),
    cover: {
      layout: coverLayout,
      photoId: "d0",
      title: lang === "ar" ? "أزقة وضوء" : "Lanes & Light",
      subtitle: lang === "ar" ? "أسبوع بعيدًا، ٢٠٢٦" : "A week away · 2026",
    },
    chapters: [CHAPTERS[lang]],
    pages,
    style: {
      background: opts.background ?? (l.style === "scrapbook" ? { kind: "color", hex: "#F6F0E4" } : { kind: "color", hex: "#FFFFFF" }),
      designStyle: l.style,
      font: lang === "ar" ? "Amiri" : "Cormorant",
    },
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

describe("golden m10c: explicit layout lists", () => {
  for (const key of Object.keys(LISTS) as Array<keyof typeof LISTS>) {
    it(`${key}: frozen ids, style/format-pure`, () => {
      const list = LISTS[key];
      expect(list.map((l) => l.id)).toEqual(EXPECTED_IDS[key]);
      const style = key.startsWith("geometric") ? "geometric" : "scrapbook";
      const format = key.endsWith("Portrait") ? "A5_PORTRAIT" : "A5_LANDSCAPE";
      for (const l of list) {
        expect(l.style, l.id).toBe(style);
        expect(l.format, l.id).toBe(format);
      }
    });
  }
});

describe("golden m10c: every geometric/scrapbook layout × screen/print × EN/AR", () => {
  for (const l of LAYOUTS) {
    describe(l.id, () => {
      for (const lang of ["en", "ar"] as const) {
        for (const mode of ["view", "print"] as const) {
          for (const t of targets(l)) {
            const file = `${l.style}/${fmt(l)}/${l.id}/${t.name}-${mode}-${lang}.html`;
            it(file, () => {
              golden(file, markup(<BookPage doc={docFor(l, lang)} page={t.page} mode={mode} photos={photosFor(mode)} captionLang={lang} />));
            });
          }
        }
      }
      for (const t of targets(l)) {
        const file = `${l.style}/${fmt(l)}/${l.id}/${t.name}-edit-en.html`;
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

describe("golden m10c: occasion accent sticker on every cover", () => {
  for (const l of LAYOUTS.filter((x) => x.role === "cover")) {
    for (const occasion of OCCASIONS) {
      const file = `accent/${l.id}-${occasion}-view-en.html`;
      it(file, () => {
        golden(file, markup(<BookPage doc={docFor(l, "en", { occasion })} page="cover" mode="view" photos={SCREEN} captionLang="en" />));
      });
    }
  }
});

describe("golden m10c: backgrounds on shaped pages", () => {
  const cases: Array<{ name: string; id: string; opts: Parameters<typeof docFor>[2] }> = [
    {
      name: "faded-photo-page-ai",
      id: "s-p-one-polaroid",
      opts: { pageBackground: { kind: "photo", photoId: BG_PHOTO, veil: 0.8, veilColor: "#F6F0E4", source: "ai" } },
    },
    {
      name: "faded-photo-page-user",
      id: "s-l-spread-hero",
      opts: { pageBackground: { kind: "photo", photoId: BG_PHOTO, veil: 0.7, veilColor: "#FFFFFF", source: "user" } },
    },
    { name: "texture-book", id: "s-l-three-row", opts: { background: { kind: "texture", textureId: "paper-cream" } } },
    { name: "tinted-texture-book", id: "g-p-two-circle", opts: { background: { kind: "texture", textureId: "paper-cream", tint: "#E8EEF0" } } },
    { name: "color-book", id: "g-l-five-hex", opts: { background: { kind: "color", hex: "#EEF2F1" } } },
  ];
  for (const c of cases) {
    for (const mode of ["view", "print"] as const) {
      const file = `backgrounds/${c.name}-${c.id}-${mode}.html`;
      it(file, () => {
        const l = LAYOUTS.find((x) => x.id === c.id)!;
        golden(file, markup(<BookPage doc={docFor(l, "en", c.opts)} page={0} mode={mode} photos={photosFor(mode)} captionLang="en" />));
      });
    }
  }
});

describe("golden m10c: sample books", () => {
  for (const sample of M10C_SAMPLES) {
    it(`${sample} render models (screen + bleed)`, () => {
      const doc = devSampleDoc(sample);
      const lang = sample.endsWith("-ar") ? "ar" : "en";
      golden(
        `samples/${sample}-render-models.json`,
        goldenJson({
          cover: { screen: coverRenderModel(doc, SCREEN, lang), bleed: coverRenderModel(doc, PRINT, lang, { bleed: true }) },
          pages: doc.pages.map((_p, i) => ({
            index: i,
            screen: pageRenderModel(doc, i, SCREEN, lang),
            bleed: pageRenderModel(doc, i, PRINT, lang, { bleed: true }),
          })),
        }),
      );
    });
  }
});

describe("golden m10c: no orphaned golden files", () => {
  it("every file under fixtures/m10c is owned by a case", () => {
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

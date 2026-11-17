// M29 (D-080) — golden set for the new SCRAPBOOK cover styles (covers-m29 arrays, portrait +
// landscape): <BookPage> cover markup in screen (view) and print-bleed modes with an English title,
// a long English title and a 120-code-point Arabic title, plus edit-mode markup, and the cover
// render models (screen + bleed). Long titles must fit their panels without hitting the panel's
// minimum font size (panelFontMm never truncates — below the minimum the box would clip).
// Files: tests/golden/fixtures/m29/scrapbook/ (one tag per line).
//
// Pre-M29 goldens (m9 / m10b / m10c) are separate and must stay byte-identical. An intended change
// to these covers → `GOLDEN_UPDATE=1 npx vitest run tests/golden/m29-covers-scrapbook.test.tsx` and
// review the diff.

import type { ReactElement } from "react";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { devSamplePhotos } from "@/lib/book/dev-sample";
import { pageMm } from "@/lib/book/format";
import { coverRenderModel, type RenderPhotos } from "@/lib/book/render";
import { BookDocSchema, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, Layout } from "@/lib/book/types";
import { SCRAPBOOK_LANDSCAPE_COVERS } from "@/lib/layouts/scrapbook/landscape/covers-m29";
import { SCRAPBOOK_PORTRAIT_COVERS } from "@/lib/layouts/scrapbook/portrait/covers-m29";
import { printRenderPhotos } from "@/lib/pdf/print-doc";
import { expectGolden, GOLDEN_DIR, GOLDEN_UPDATE, goldenJson, listGoldenFiles, splitTags } from "./golden";

const PREFIX = "m29/scrapbook";
const OWNED = new Set<string>();
function golden(name: string, actual: string) {
  OWNED.add(`${PREFIX}/${name}`);
  expectGolden(`${PREFIX}/${name}`, actual);
}

/** Explicit list: a new or renamed scrapbook M29 cover must be added here on purpose (and reviewed). */
const EXPECTED_IDS = {
  portrait: ["s-p-cover-tape", "s-p-cover-tag", "s-p-cover-stack"],
  landscape: ["s-l-cover-tape", "s-l-cover-tag", "s-l-cover-stack"],
};
const LISTS = { portrait: SCRAPBOOK_PORTRAIT_COVERS, landscape: SCRAPBOOK_LANDSCAPE_COVERS } as const;
const COVERS: readonly Layout[] = [...SCRAPBOOK_PORTRAIT_COVERS, ...SCRAPBOOK_LANDSCAPE_COVERS];

const SCREEN: RenderPhotos = devSamplePhotos();
const PRINT: RenderPhotos = printRenderPhotos(
  Object.entries(SCREEN).map(([id, p]) => ({ id, width: p?.width ?? null, height: p?.height ?? null })),
);
const photosFor = (mode: BookRenderMode) => (mode === "print" ? PRINT : SCREEN);
const markup = (el: ReactElement) => `${splitTags(renderToStaticMarkup(el))}\n`;

/** 120 code points of Arabic (the longest title the cover must hold). */
const AR_120 = Array.from(
  "رحلتنا الطويلة إلى الجبال والبحر مع العائلة كلها في صيف لا ينسى أبدا مليء بالضحك والحب والذكريات الجميلة معا في كل يوم جديد",
)
  .slice(0, 120)
  .join("");
const TITLES = {
  en: { title: "Lanes & Light", subtitle: "A week away · 2026", lang: "en" },
  long: {
    title: "Our long summer by the sea with grandma, the cousins, three dogs and far too much ice cream every single day",
    subtitle: "Summer 2026 · Abu Dhabi, Muscat and the long road home",
    lang: "en",
  },
  ar: { title: AR_120, subtitle: "أسبوع بعيدًا، ٢٠٢٦", lang: "ar" },
} as const;
type Variant = keyof typeof TITLES;

const fmt = (l: Layout) => (l.format === "A5_PORTRAIT" ? "portrait" : "landscape");

function docFor(l: Layout, v: Variant): BookDoc {
  const t = TITLES[v];
  return {
    version: 2,
    format: l.format,
    occasion: "travel",
    cover: { layout: l.id, photoId: "d0", title: t.title, subtitle: t.subtitle },
    chapters: [],
    pages: [],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "scrapbook", font: t.lang === "ar" ? "Amiri" : "Cormorant" },
  };
}

/** Smallest size panelFontMm shrinks to per font role (render.ts PANEL_TYPE). */
const MIN_MM: Record<string, number> = { title: 5, chapter: 3.5, subtitle: 2.8, year: 2.8, caption: 2.8 };

describe("golden m29 scrapbook: explicit cover lists", () => {
  for (const key of Object.keys(LISTS) as Array<keyof typeof LISTS>) {
    it(`${key}: frozen ids, scrapbook/format-pure, user-chosen only`, () => {
      const list: readonly Layout[] = LISTS[key];
      expect(list.map((l) => l.id)).toEqual(EXPECTED_IDS[key]);
      for (const l of list) {
        expect(l.style, l.id).toBe("scrapbook");
        expect(l.format, l.id).toBe(key === "portrait" ? "A5_PORTRAIT" : "A5_LANDSCAPE");
        expect(l.role, l.id).toBe("cover");
        expect(l.autoPick, l.id).toBe(false);
      }
    });
  }
});

describe("golden m29 scrapbook: docs are valid and long titles fit", () => {
  for (const l of COVERS) {
    for (const v of Object.keys(TITLES) as Variant[]) {
      it(`${l.id} ${v}`, () => {
        const doc = docFor(l, v);
        expect(validateBookDoc(BookDocSchema.parse(doc), { photoIds: new Set(Object.keys(SCREEN)), maxPages: 100 })).toEqual([]);
        const page = pageMm(l.format);
        for (const bleed of [false, true]) {
          const m = coverRenderModel(doc, bleed ? PRINT : SCREEN, TITLES[v].lang, { bleed });
          expect(m.panels?.map((p) => p.bind)).toEqual(["coverTitle", "coverSubtitle"]);
          for (const p of m.panels ?? []) {
            const sizeMm = (p.fontSizeCqw / 100) * page.w;
            expect(sizeMm, `${l.id} ${v} ${p.bind} hit the minimum size`).toBeGreaterThan(MIN_MM[p.role] + 1e-6);
          }
        }
      });
    }
  }
});

describe("golden m29 scrapbook: every cover × screen/print × EN/long/AR + edit", () => {
  for (const l of COVERS) {
    describe(l.id, () => {
      for (const v of Object.keys(TITLES) as Variant[]) {
        for (const mode of ["view", "print"] as const) {
          const file = `${fmt(l)}/${l.id}/cover-${mode}-${v}.html`;
          it(file, () => {
            golden(file, markup(<BookPage doc={docFor(l, v)} page="cover" mode={mode} photos={photosFor(mode)} captionLang={TITLES[v].lang} />));
          });
        }
        const models = `${fmt(l)}/${l.id}/render-models-${v}.json`;
        it(models, () => {
          const doc = docFor(l, v);
          golden(
            models,
            goldenJson({ screen: coverRenderModel(doc, SCREEN, TITLES[v].lang), bleed: coverRenderModel(doc, PRINT, TITLES[v].lang, { bleed: true }) }),
          );
        });
      }
      const edit = `${fmt(l)}/${l.id}/cover-edit-en.html`;
      it(edit, () => {
        golden(
          edit,
          markup(
            <BookPage
              doc={docFor(l, "en")}
              page="cover"
              mode="edit"
              photos={{}}
              captionLang="en"
              renderSlotOverlay={(i, owner) => <span data-overlay={`${owner}:${i}`} />}
              renderCoverTextOverlay={() => <span data-edit-cover="" />}
            />,
          ),
        );
      });
    });
  }
});

describe("golden m29 scrapbook: no orphaned golden files", () => {
  it("every file under fixtures/m29/scrapbook is owned by a case", () => {
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

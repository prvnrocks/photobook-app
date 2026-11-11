// M10a A0 — golden freeze of the M9 renderer and the pure maths around it, taken BEFORE any M10
// change. Every case is compared byte-for-byte with an explicit, committed file under
// tests/golden/fixtures/m9/ (markup: one tag per line; data: pretty JSON) — no vitest
// auto-snapshots, so a rendering change is a reviewable git diff.
//
// Default run (`npm test`): compare. A mismatch means M9 output changed.
// Intended change only: `GOLDEN_UPDATE=1 npx vitest run tests/golden` rewrites the goldens (and
// deletes orphaned ones); review `git diff tests/golden/fixtures` before committing.
//
// Coverage: <BookPage> for every page layout × mode (edit/view/print) × cases (photos, missing
// photo, empty slot, EN/AR/mixed captions, every caption font + unknown font, alignments,
// crop zoom/focal variations, unknown pixel size, non-white background, edit overlays,
// priority); <BookCover> per mode (EN/AR title+subtitle, long titles, fonts, missing photo);
// blank pages (out of range / unknown layout); Watermark; planPrintImages; printSheetTargets /
// printPhotoIds / printRenderPhotos; toPublicDoc ↔ parsePublicDoc (+ old snapshot without
// captionLang); flipLayout / flipPageKind / pageCounterLabel; bleedRect / printSlotSizeMm /
// slotSizeMm for every slot; effectiveDpi / isSlotLowRes samples.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookCover } from "@/components/book/BookCover";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { Watermark } from "@/components/book/Watermark";
import { bleedRect, printSlotSizeMm } from "@/lib/book/bleed";
import { coverRenderModel, pageRenderModel, type RenderPhotos } from "@/lib/book/render";
import { effectiveDpi, isSlotLowRes, layoutSlotMm, slotSizeMm } from "@/lib/book/resolution";
import type { BookDoc, BookPage as DocPage, Caption } from "@/lib/book/types";
// M10b: the M9 goldens freeze the classic A5 portrait catalogue; other formats/styles have their own tests.
import { CLASSIC_PORTRAIT_LAYOUTS as LAYOUTS, layoutsByRole } from "@/lib/layouts";
import { planPrintImages } from "@/lib/pdf/image-plan";
import { printPhotoIds, printRenderPhotos, printSheetTargets } from "@/lib/pdf/print-doc";
import { parsePublicDoc, publicDocToRenderDoc, publicPhotoIds, toPublicDoc } from "@/lib/publish/public-doc";
import { firstVisiblePageIdx, flipLayout, flipPageKind, pageCounterLabel, startIndexFor } from "@/lib/viewer/pages";
import { expectGolden, GOLDEN_DIR, GOLDEN_UPDATE, goldenJson, listGoldenFiles, splitTags } from "./golden";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  AR_CAPTION,
  AR_SUBTITLE,
  AR_TITLE,
  baseDoc,
  caption,
  CROP_DEFAULT,
  CROP_VARIANTS,
  EN_CAPTION,
  EN_SUBTITLE,
  EN_TITLE,
  FILL_CYCLE,
  LONG_TITLE,
  MISSING_PHOTO_ID,
  MIXED_CAPTION,
  PHOTO_DIMS,
  representativeDoc,
  representativeDocV1,
  webPhotos,
} from "./m9-inputs";
import { serializeDoc } from "@/lib/book/doc-version";

const PREFIX = "m9";
const MODES: readonly BookRenderMode[] = ["edit", "view", "print"];
const PAGE_LAYOUTS = layoutsByRole("page");
const FONTS = ["Inter", "Playfair", "Cairo", "Tajawal", "Comic Sans"] as const;

/** Files this suite owns (for the orphan check), registered as cases are declared. */
const OWNED = new Set<string>();
function golden(name: string, actual: string) {
  expectGolden(`${PREFIX}/${name}`, actual);
}
function own(name: string): string {
  OWNED.add(`${PREFIX}/${name}`);
  return name;
}

/** Photos as each surface really passes them: web URLs (editor/viewer), print-asset URLs (print). */
function photosFor(mode: BookRenderMode): RenderPhotos {
  return mode === "print" ? printRenderPhotos(PHOTO_DIMS) : webPhotos();
}

const markup = (el: ReactElement) => splitTags(renderToStaticMarkup(el));

// ---------------------------------------------------------------- page cases

interface PageCase {
  name: string;
  page: DocPage;
  captionLang?: string;
  background?: string;
  priority?: boolean;
  /** Edit hooks (renderSlotOverlay / renderCaption) — only rendered in edit mode by design. */
  overlays?: boolean;
}

function filledSlots(n: number, crop = CROP_DEFAULT) {
  return Array.from({ length: n }, (_, i) => ({ photoId: FILL_CYCLE[i % FILL_CYCLE.length] as string, crop }));
}

function pageCases(layoutId: string): PageCase[] {
  const layout = PAGE_LAYOUTS.find((l) => l.id === layoutId)!;
  const n = layout.photoCount;
  const hasCaption = layout.caption !== null;
  const mk = (slots: DocPage["slots"], cap: Caption | null = null): DocPage => ({
    id: `pg-${layoutId}`,
    chapterId: "ch-1",
    layout: layoutId,
    slots,
    caption: hasCaption ? cap : null,
  });
  const enCap = caption(EN_CAPTION, "Playfair");
  const cases: PageCase[] = [
    { name: "photos", page: mk(filledSlots(n), enCap) },
    { name: "photos-priority", page: mk(filledSlots(n), enCap), priority: true },
    {
      name: "missing-photo",
      // Slot 0: photo deleted (id not in the map); slot 1 (if any): empty slot.
      page: mk(filledSlots(n).map((s, i) => (i === 0 ? { ...s, photoId: MISSING_PHOTO_ID } : i === 1 ? { ...s, photoId: null } : s)), enCap),
    },
    { name: "all-empty", page: mk(filledSlots(n).map((s) => ({ ...s, photoId: null }))) },
    { name: "unknown-pixel-size", page: mk(filledSlots(n).map((s) => ({ ...s, photoId: "p-nodims" })), enCap) },
    { name: "low-res-photo", page: mk(filledSlots(n).map((s) => ({ ...s, photoId: "p-tiny" })), enCap) },
    { name: "background-F5EFE6", page: mk(filledSlots(n), enCap), background: "#F5EFE6" },
    { name: "background-1F2937", page: mk(filledSlots(n), enCap), background: "#1F2937" },
    { name: "edit-overlays", page: mk(filledSlots(n).map((s, i) => (i === 1 ? { ...s, photoId: null } : s)), enCap), overlays: true },
    // Fewer slots in the doc than the layout has (malformed but rendered: missing → empty).
    { name: "short-slots-array", page: mk([]) },
  ];
  for (const [crop, c] of Object.entries(CROP_VARIANTS)) {
    cases.push({ name: `crop-${crop}`, page: mk(filledSlots(n, c), enCap) });
  }
  if (hasCaption) {
    cases.push(
      { name: "caption-none", page: mk(filledSlots(n), null) },
      { name: "caption-none-edit-overlays", page: mk(filledSlots(n), null), overlays: true },
      { name: "caption-none-lang-ar-edit-overlays", page: mk(filledSlots(n), null), captionLang: "ar", overlays: true },
      { name: "caption-empty-text", page: mk(filledSlots(n), caption("", "Playfair")) },
      { name: "caption-en", page: mk(filledSlots(n), enCap) },
      { name: "caption-ar", page: mk(filledSlots(n), caption(AR_CAPTION, "Cairo", "center", "user")), captionLang: "ar" },
      { name: "caption-ar-in-en-book", page: mk(filledSlots(n), caption(AR_CAPTION, "Cairo")), captionLang: "en" },
      { name: "caption-ar-latin-font", page: mk(filledSlots(n), caption(AR_CAPTION, "Playfair")), captionLang: "ar" },
      { name: "caption-mixed", page: mk(filledSlots(n), caption(MIXED_CAPTION, "Tajawal")), captionLang: "ar" },
      { name: "caption-digits-only-lang-ar", page: mk(filledSlots(n), caption("2026 · 12/02", "Cairo")), captionLang: "ar" },
      { name: "caption-multiline", page: mk(filledSlots(n), caption("Line one\nLine two\nLine three", "Inter")) },
      { name: "caption-html-chars", page: mk(filledSlots(n), caption(`Tom & "Jerry" <3 'ok'`, "Inter")) },
      { name: "caption-align-left", page: mk(filledSlots(n), caption(EN_CAPTION, "Inter", "left")) },
      { name: "caption-align-right", page: mk(filledSlots(n), caption(AR_CAPTION, "Tajawal", "right")), captionLang: "ar" },
    );
    for (const f of FONTS) {
      cases.push({ name: `font-${f.replace(/ /g, "-")}-en`, page: mk(filledSlots(n), caption(EN_CAPTION, f)) });
      cases.push({ name: `font-${f.replace(/ /g, "-")}-ar`, page: mk(filledSlots(n), caption(AR_CAPTION, f)), captionLang: "ar" });
    }
  }
  return cases;
}

function slotOverlay(i: number) {
  return <span data-test-overlay={String(i)}>overlay {i}</span>;
}

function renderPageCase(c: PageCase, mode: BookRenderMode): string {
  const doc = baseDoc([c.page], { background: c.background });
  return markup(
    <BookPage
      doc={doc}
      page={0}
      mode={mode}
      photos={photosFor(mode)}
      captionLang={c.captionLang}
      priority={c.priority}
      renderSlotOverlay={c.overlays ? slotOverlay : undefined}
      renderCaption={
        c.overlays
          ? (cap, model) => <pre data-test-caption-model="">{JSON.stringify({ cap, model })}</pre>
          : undefined
      }
    />,
  );
}

function sectioned(header: string, parts: { name: string; body: string }[]): string {
  return `${header}\n${parts.map((p) => `\n=== case: ${p.name} ===\n${p.body}\n`).join("")}`;
}

describe("golden: <BookPage> every page layout × mode", () => {
  for (const layout of PAGE_LAYOUTS) {
    for (const mode of MODES) {
      const file = own(`book-page/${layout.id}.${mode}.html`);
      it(`${layout.id} / ${mode}`, () => {
        const cases = pageCases(layout.id);
        const body = sectioned(
          `<!-- golden: <BookPage> layout=${layout.id} mode=${mode} cases=${cases.length} -->`,
          cases.map((c) => ({ name: c.name, body: renderPageCase(c, mode) })),
        );
        golden(file, body);
      });
    }
  }

  it("covers every page layout in the catalogue", () => {
    expect(PAGE_LAYOUTS.map((l) => l.id)).toEqual(["full-page", "one-portrait", "two-vertical", "two-horizontal", "three-mixed", "four-grid"]);
    expect(LAYOUTS.map((l) => l.id)).toEqual(["cover", ...PAGE_LAYOUTS.map((l) => l.id)]);
  });

  for (const mode of MODES) {
    const file = own(`book-page/blank.${mode}.html`);
    it(`blank pages / ${mode}`, () => {
      const unknownLayout: DocPage = { id: "pg-x", chapterId: null, layout: "no-such-layout", slots: filledSlots(2), caption: caption(EN_CAPTION, "Inter") };
      const coverAsPage: DocPage = { id: "pg-c", chapterId: null, layout: "cover", slots: filledSlots(1), caption: null };
      const doc = baseDoc([unknownLayout, coverAsPage], { background: "#F5EFE6" });
      const photos = photosFor(mode);
      golden(
        file,
        sectioned(`<!-- golden: <BookPage> blank pages mode=${mode} -->`, [
          { name: "unknown-layout", body: markup(<BookPage doc={doc} page={0} mode={mode} photos={photos} />) },
          { name: "cover-layout-on-page", body: markup(<BookPage doc={doc} page={1} mode={mode} photos={photos} />) },
          { name: "out-of-range-index", body: markup(<BookPage doc={doc} page={7} mode={mode} photos={photos} />) },
          { name: "negative-index", body: markup(<BookPage doc={doc} page={-1} mode={mode} photos={photos} />) },
          { name: "fractional-index", body: markup(<BookPage doc={doc} page={0.5} mode={mode} photos={photos} />) },
          { name: "class-name", body: markup(<BookPage doc={doc} page={0} mode={mode} photos={photos} className="extra-class" />) },
        ]),
      );
    });
  }
});

// ---------------------------------------------------------------- cover cases

interface CoverCase {
  name: string;
  cover?: Partial<BookDoc["cover"]>;
  font?: string;
  captionLang?: string;
  background?: string;
  priority?: boolean;
  overlays?: boolean;
}

const COVER_CASES: CoverCase[] = [
  { name: "en-title-subtitle" },
  { name: "en-priority", priority: true },
  { name: "ar-title-subtitle", cover: { title: AR_TITLE, subtitle: AR_SUBTITLE }, captionLang: "ar" },
  { name: "ar-title-in-en-book", cover: { title: AR_TITLE, subtitle: AR_SUBTITLE }, captionLang: "en" },
  { name: "ar-title-en-subtitle", cover: { title: AR_TITLE, subtitle: EN_SUBTITLE } },
  { name: "en-title-ar-subtitle", cover: { title: EN_TITLE, subtitle: AR_SUBTITLE } },
  { name: "title-only", cover: { subtitle: "" } },
  { name: "subtitle-only", cover: { title: "" } },
  { name: "no-text", cover: { title: "", subtitle: "" } },
  { name: "title-25-chars", cover: { title: "Abcdefghij Klmnopqrst Uvw" } },
  { name: "title-49-chars", cover: { title: LONG_TITLE.slice(0, 49) } },
  { name: "title-long", cover: { title: LONG_TITLE } },
  { name: "missing-photo", cover: { photoId: MISSING_PHOTO_ID } },
  { name: "null-photo", cover: { photoId: null } },
  { name: "landscape-photo", cover: { photoId: "p-pano" } },
  { name: "unknown-pixel-size", cover: { photoId: "p-nodims" } },
  { name: "unknown-cover-layout", cover: { layout: "no-such-cover" } },
  { name: "page-layout-as-cover", cover: { layout: "full-page" } },
  { name: "background-F5EFE6", background: "#F5EFE6" },
  { name: "edit-overlays", overlays: true },
  { name: "edit-overlays-no-text", cover: { title: "", subtitle: "" }, overlays: true },
];
for (const f of ["Inter", "Playfair", "Cairo", "Tajawal", "Comic Sans"]) {
  COVER_CASES.push({ name: `style-font-${f.replace(/ /g, "-")}-en`, font: f });
  COVER_CASES.push({ name: `style-font-${f.replace(/ /g, "-")}-ar`, font: f, cover: { title: AR_TITLE, subtitle: AR_SUBTITLE }, captionLang: "ar" });
}

describe("golden: <BookCover> per mode", () => {
  for (const mode of MODES) {
    const file = own(`book-cover/cover.${mode}.html`);
    it(`cover / ${mode}`, () => {
      const parts = COVER_CASES.map((c) => {
        const doc = baseDoc([], { cover: c.cover, font: c.font, background: c.background });
        const props = {
          doc,
          mode,
          photos: photosFor(mode),
          captionLang: c.captionLang,
          priority: c.priority,
          renderSlotOverlay: c.overlays ? slotOverlay : undefined,
        };
        const direct = markup(
          <BookCover {...props} renderTextOverlay={c.overlays ? () => <span data-test-cover-overlay="">cover text</span> : undefined} />,
        );
        // <BookPage page="cover"> must be the same markup as <BookCover>.
        const viaPage = markup(
          <BookPage
            {...props}
            page="cover"
            renderCoverTextOverlay={c.overlays ? () => <span data-test-cover-overlay="">cover text</span> : undefined}
          />,
        );
        expect(viaPage, c.name).toBe(direct);
        return { name: c.name, body: direct };
      });
      golden(file, sectioned(`<!-- golden: <BookCover> mode=${mode} cases=${parts.length} -->`, parts));
    });
  }
});

describe("golden: Watermark", () => {
  const file = own("watermark.html");
  it("watermark markup", () => {
    golden(file, `${markup(<Watermark />)}\n\n${markup(<Watermark className="extra-class" />)}\n`);
  });
});

// ---------------------------------------------------------------- render models (data view of the same)

describe("golden: render models of the representative doc", () => {
  const file = own("render-models.json");
  it("pageRenderModel / coverRenderModel, screen + bleed", () => {
    const doc = representativeDoc();
    const photos = webPhotos();
    const out = {
      cover: {
        screen: coverRenderModel(doc, photos, "en"),
        bleed: coverRenderModel(doc, photos, "en", { bleed: true }),
        arBook: coverRenderModel(doc, photos, "ar"),
      },
      pages: doc.pages.map((_p, i) => ({
        index: i,
        screen: pageRenderModel(doc, i, photos, "en"),
        bleed: pageRenderModel(doc, i, photos, "en", { bleed: true }),
        arBook: pageRenderModel(doc, i, photos, "ar"),
      })),
    };
    golden(file, goldenJson(out));
  });
});

// ---------------------------------------------------------------- print plan + print doc

describe("golden: print image plan", () => {
  const file = own("print-image-plan.json");
  it("planPrintImages for the representative doc (+ option variants)", () => {
    const doc = representativeDoc();
    const out = {
      default: planPrintImages(doc, PHOTO_DIMS),
      dpi150: planPrintImages(doc, PHOTO_DIMS, { dpi: 150 }),
      bleed0: planPrintImages(doc, PHOTO_DIMS, { bleedMm: 0 }),
      bleed5: planPrintImages(doc, PHOTO_DIMS, { bleedMm: 5 }),
      maxLongEdge1000: planPrintImages(doc, PHOTO_DIMS, { maxLongEdge: 1000 }),
      invalidOpts: planPrintImages(doc, PHOTO_DIMS, { dpi: -1, bleedMm: Number.NaN, maxLongEdge: 0 }),
      subsetPhotos: planPrintImages(doc, PHOTO_DIMS.slice(0, 2)),
      noCoverPhoto: planPrintImages({ ...doc, cover: { ...doc.cover, photoId: null } }, PHOTO_DIMS),
    };
    golden(file, goldenJson(out));
  });
});

describe("golden: print doc helpers", () => {
  const file = own("print-doc.json");
  it("printSheetTargets / printPhotoIds / printRenderPhotos", () => {
    const doc = representativeDoc();
    const n = doc.pages.length;
    const ranges: [number, number, number][] = [
      [n, 0, n],
      [n, 0, 0],
      [n, 1, 1],
      [n, 2, 4],
      [n, n, n],
      [n, 0, n + 1],
      [n, 3, 2],
      [n, -1, 2],
      [n, 0.5, 2],
      [0, 0, 0],
      [-1, 0, 0],
      [Number.NaN, 0, 0],
    ];
    const out = {
      targets: ranges.map(([pc, from, to]) => {
        const targets = printSheetTargets(pc, from, to);
        return {
          pageCount: String(pc),
          from: String(from),
          to: String(to),
          targets,
          photoIds: targets ? printPhotoIds(doc, targets) : null,
        };
      }),
      photoIdsOutOfRangeTarget: printPhotoIds(doc, ["cover", 99]),
      renderPhotos: printRenderPhotos([
        ...PHOTO_DIMS,
        { id: "p-float-dims", width: 10.5, height: 20 },
        { id: "p-zero-dims", width: 0, height: -3 },
        { id: "id with space/ü", width: 100, height: 100 },
      ]),
    };
    golden(file, goldenJson(out));
  });
});

// ---------------------------------------------------------------- public doc

describe("golden: public doc snapshot", () => {
  const file = own("public-doc.json");
  it("toPublicDoc → parsePublicDoc round trip, old snapshot, render adapter", () => {
    const doc = representativeDoc();
    const pubEn = toPublicDoc(doc, { captionLang: "en" });
    const pubAr = toPublicDoc(doc, { captionLang: "ar" });
    const pubNone = toPublicDoc(doc);
    const pubNull = toPublicDoc(doc, { captionLang: null });

    // Round trip through JSON (what jsonb storage does) must parse back to the same object.
    for (const p of [pubEn, pubAr, pubNone, pubNull]) {
      const parsed = parsePublicDoc(JSON.parse(JSON.stringify(p)));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.doc).toEqual(p);
    }
    // Snapshot published before captionLang existed: no key at all.
    const oldSnapshot: Record<string, unknown> = JSON.parse(JSON.stringify(pubEn));
    delete oldSnapshot.captionLang;
    const oldParsed = parsePublicDoc(oldSnapshot);
    expect(oldParsed.ok).toBe(true);

    const withExtraKey = { ...pubEn, meta: doc.meta };
    const withSource = JSON.parse(JSON.stringify(pubEn));
    withSource.pages[1].caption.source = "ai";
    const badLang = { ...pubEn, captionLang: "fr" };

    const out = {
      publicDoc: { en: pubEn, ar: pubAr, none: pubNone, null: pubNull },
      oldSnapshotParse: oldParsed,
      rejects: {
        extraTopLevelKey: parsePublicDoc(withExtraKey).ok,
        captionSource: parsePublicDoc(withSource).ok,
        badCaptionLang: parsePublicDoc(badLang).ok,
        notAnObject: parsePublicDoc("doc").ok,
        null: parsePublicDoc(null).ok,
      },
      // M10a: the adapter returns the in-memory v2 doc; its stored form is the frozen v1 JSON.
      renderDoc: serializeDoc(publicDocToRenderDoc(pubEn)),
      photoIds: publicPhotoIds(pubEn),
    };
    golden(file, goldenJson(out));
  });

  it("published doc renders exactly like the source doc (every page, view mode)", () => {
    const doc = representativeDoc();
    const renderDoc = publicDocToRenderDoc(toPublicDoc(doc, { captionLang: "ar" }));
    const photos = webPhotos();
    for (const page of ["cover" as const, ...doc.pages.map((_p, i) => i)]) {
      expect(markup(<BookPage doc={renderDoc} page={page} mode="view" photos={photos} captionLang="ar" />)).toBe(
        markup(<BookPage doc={doc} page={page} mode="view" photos={photos} captionLang="ar" />),
      );
    }
  });
});

describe("golden: representative doc rendered in full", () => {
  for (const mode of MODES) {
    const file = own(`representative/doc.${mode}.html`);
    it(`representative doc / ${mode}`, () => {
      const doc = representativeDoc();
      const photos = photosFor(mode);
      const parts = (["cover", ...doc.pages.map((_p, i) => i)] as const).map((page) => ({
        name: page === "cover" ? "cover" : `page-${page}`,
        body: markup(<BookPage doc={doc} page={page} mode={mode} photos={photos} captionLang="en" />),
      }));
      golden(file, sectioned(`<!-- golden: representative doc mode=${mode} -->`, parts));
    });
  }
});

// ---------------------------------------------------------------- viewer flip layout

describe("golden: viewer flip layout", () => {
  const file = own("flip-layout.json");
  it("flipLayout / flipPageKind / pageCounterLabel / startIndexFor for phone + spread", () => {
    const counts = [0, 1, 2, 3, 4, 5, 12, 19, 20, 21, 100];
    const rows = [];
    for (const d of counts) {
      for (const spread of [false, true]) {
        for (const endCard of [true, false]) {
          const layout = flipLayout(d, { endCard, spread });
          const indices = Array.from({ length: layout.count }, (_, i) => i);
          rows.push({
            docPages: d,
            device: spread ? "spread" : "phone",
            endCard,
            layout,
            // Long books: first 6 + last 4 indices only, to keep the file reviewable.
            pages: (layout.count > 12 ? [...indices.slice(0, 6), ...indices.slice(-4)] : indices).map((i) => ({
              i,
              kind: flipPageKind(layout, i),
              counter: pageCounterLabel(layout, i, spread),
              firstVisible: firstVisiblePageIdx(layout, i, spread),
            })),
            startIndexFor: [-1, 0, 1, d, d + 1, d + 5].map((i) => [i, startIndexFor(layout, i)]),
          });
        }
      }
    }
    rows.push({ odd: "non-integer / negative docPages", a: flipLayout(3.7, { endCard: true, spread: true }), b: flipLayout(-2, { endCard: true, spread: false }), c: flipLayout(Number.NaN, { endCard: true, spread: true }) });
    golden(file, goldenJson(rows));
  });
});

// ---------------------------------------------------------------- bleed + resolution maths

describe("golden: bleed + slot sizes for every layout slot", () => {
  const file = own("bleed-slots.json");
  it("bleedRect / printSlotSizeMm / slotSizeMm / layoutSlotMm", () => {
    const out = LAYOUTS.map((l) => ({
      layout: l.id,
      role: l.role,
      caption: l.caption,
      slots: l.slots.map((rect, i) => ({
        index: i,
        rect,
        bleed: bleedRect(rect),
        bleed0: bleedRect(rect, undefined, 0),
        printSlotSizeMm: printSlotSizeMm(l, i),
        printSlotSizeMmById: printSlotSizeMm(l.id, i),
        slotSizeMm: slotSizeMm(rect),
        layoutSlotMm: layoutSlotMm(l.id, i),
      })),
    }));
    golden(
      file,
      goldenJson({
        layouts: out,
        unknown: { printSlotSizeMm: printSlotSizeMm("nope", 0), outOfRange: printSlotSizeMm("full-page", 3), layoutSlotMm: layoutSlotMm("nope", 0) },
      }),
    );
  });
});

describe("golden: effective dpi samples", () => {
  const file = own("effective-dpi.json");
  it("effectiveDpi / isSlotLowRes", () => {
    const samples: [number | null, number | null, number, number, number | undefined][] = [
      [3000, 4000, 148, 210, undefined],
      [3000, 4000, 148, 210, 2],
      [3000, 4000, 148, 210, 4],
      [3000, 4000, 148, 210, 9],
      [3000, 4000, 148, 210, 0.5],
      [4000, 3000, 118.4, 151.2, 1],
      [400, 300, 118.4, 151.2, 1],
      [1600, 1067, 65.12, 81.9, 1],
      [6000, 1500, 133.2, 84, 1],
      [null, null, 148, 210, 1],
      [0, 100, 148, 210, 1],
      [100, 100, 0, 210, 1],
      [100, 100, 148, 210, Number.NaN],
    ];
    const out = {
      effectiveDpi: samples.map(([w, h, sw, sh, z]) => ({ args: [w, h, sw, sh, z ?? "default"].map(String), dpi: effectiveDpi(w, h, sw, sh, z) })),
      isSlotLowRes: LAYOUTS.flatMap((l) =>
        l.slots.flatMap((_r, i) =>
          PHOTO_DIMS.map((p) => ({ layout: l.id, slot: i, photo: p.id, zoom1: isSlotLowRes(p, l.id, i), zoom3: isSlotLowRes(p, l.id, i, 3) })),
        ),
      ),
      unknownLayout: isSlotLowRes({ width: 10, height: 10 }, "nope", 0),
    };
    golden(file, goldenJson(out));
  });
});

// ---------------------------------------------------------------- inputs + orphans

describe("golden: frozen inputs", () => {
  const file = own("inputs.json");
  it("inputs used by every case above", () => {
    golden(
      file,
      goldenJson({
        photoDims: PHOTO_DIMS,
        webPhotos: webPhotos(),
        printPhotos: printRenderPhotos(PHOTO_DIMS),
        representativeDoc: representativeDocV1(),
        // One compact line per case keeps this file small and still diffable.
        pageCases: Object.fromEntries(
          PAGE_LAYOUTS.map((l) => [l.id, Object.fromEntries(pageCases(l.id).map(({ name, ...c }) => [name, JSON.stringify(c)]))]),
        ),
        coverCases: Object.fromEntries(COVER_CASES.map(({ name, ...c }) => [name, JSON.stringify(c)])),
      }),
    );
  });
});

describe("golden: no orphaned golden files", () => {
  it("every file under fixtures/m9 is owned by a case", () => {
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

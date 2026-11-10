// Frozen inputs for the M9 golden tests (tests/golden/m9-render.test.tsx). Synthetic data only.
// Every input is ALSO written to fixtures/m9/inputs.json and compared, so an accidental change to
// these builders shows up as a reviewable diff instead of silently moving every golden.
// Docs are v1 (`version: 1`, A5_PORTRAIT) exactly as M9 stores them — M10 must render them the same.
// M10a A1: the *V1 builders return that stored JSON (inputs.json); baseDoc/representativeDoc
// return it upgraded to the in-memory v2 doc (upgradeDocV1, what parseBookDoc yields) for rendering.

import { upgradeDocV1 } from "@/lib/book/doc-version";
import type { RenderPhotos } from "@/lib/book/render";
import type { BookDoc, BookDocV1, BookPageV1 as DocPage, Caption, Crop } from "@/lib/book/types";
import type { PlanPhoto } from "@/lib/pdf/image-plan";

export const AR_CAPTION = "أجمل ليلة بدأت بضحكة، وانتهت بذكرى لا تُنسى";
export const EN_CAPTION = "First light over the water, and nobody wanted to leave.";
export const MIXED_CAPTION = "Eid في أبوظبي 2026";
export const AR_TITLE = "زفاف سارة وعمر";
export const AR_SUBTITLE = "أبوظبي · ٢٠٢٦";
export const EN_TITLE = "Sara & Omar";
export const EN_SUBTITLE = "Abu Dhabi · 2026";
export const LONG_TITLE =
  "A very long title for a family trip that went from Abu Dhabi to Al Ain and back again in one weekend of sun";

/** Stored pixel size per photo id (display-oriented). */
export const PHOTO_DIMS: readonly PlanPhoto[] = [
  { id: "p-portrait", width: 3000, height: 4000 },
  { id: "p-landscape", width: 4000, height: 3000 },
  { id: "p-square", width: 2000, height: 2000 },
  { id: "p-pano", width: 6000, height: 1500 },
  { id: "p-tiny", width: 400, height: 300 },
  { id: "p-nodims", width: null, height: null },
];

/** Cycle used to fill slots: mixes orientations so crop maths differs per slot. */
export const FILL_CYCLE = ["p-portrait", "p-landscape", "p-square", "p-pano"] as const;

/** In the doc but not in the photo map (deleted photo) → empty slot. */
export const MISSING_PHOTO_ID = "p-deleted";

export function webPhotos(): RenderPhotos {
  const out: Record<string, { url: string; width: number | null; height: number | null }> = {};
  for (const p of PHOTO_DIMS) out[p.id] = { url: `https://img.test/web/${p.id}.jpg`, width: p.width, height: p.height };
  return out;
}

export const CROP_DEFAULT: Crop = { x: 0.5, y: 0.5, zoom: 1 };

export const CROP_VARIANTS: Readonly<Record<string, Crop>> = {
  "zoom1-topleft": { x: 0, y: 0, zoom: 1 },
  "zoom1-bottomright": { x: 1, y: 1, zoom: 1 },
  "zoom2-center": { x: 0.5, y: 0.5, zoom: 2 },
  "zoom2.5-focal-0.2-0.8": { x: 0.2, y: 0.8, zoom: 2.5 },
  "zoom4-focal-0.9-0.1": { x: 0.9, y: 0.1, zoom: 4 },
};

export function caption(text: string, font: string, align: Caption["align"] = "center", source: Caption["source"] = "ai"): Caption {
  return { text, font, align, source };
}

type BaseDocOverrides = { background?: string; cover?: Partial<BookDoc["cover"]>; font?: string };

/** In-memory (v2) doc of baseDocV1 — what the renderer gets after parseBookDoc. */
export function baseDoc(pages: DocPage[], over: BaseDocOverrides = {}): BookDoc {
  return upgradeDocV1(baseDocV1(pages, over));
}

/** The stored M9 (v1) JSON. */
export function baseDocV1(pages: DocPage[], over: BaseDocOverrides = {}): BookDocV1 {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "wedding",
    cover: { layout: "cover", photoId: "p-portrait", title: EN_TITLE, subtitle: EN_SUBTITLE, ...over.cover },
    chapters: [
      { id: "ch-1", title: "Arrival", dateLabel: "12 Feb", place: "Abu Dhabi" },
      { id: "ch-2", title: "عشاء العائلة", dateLabel: "13 Feb", place: null },
    ],
    pages,
    style: { background: over.background ?? "#FFFFFF", font: over.font ?? "Playfair" },
    meta: { generator: "ai", generatorVersion: 1, runId: "00000000-0000-4000-8000-000000000001", userEdited: true },
  };
}

/**
 * Representative full doc: cover + every page layout, a reused photo (cover photo also on a
 * page), a deleted photo, an empty slot, a photo of unknown size, zoomed/offset crops, EN / AR /
 * mixed captions in every font, a non-white background.
 */
export function representativeDoc(): BookDoc {
  return upgradeDocV1(representativeDocV1());
}

export function representativeDocV1(): BookDocV1 {
  const pages: DocPage[] = [
    { id: "pg-1", chapterId: "ch-1", layout: "full-page", slots: [{ photoId: "p-portrait", crop: CROP_DEFAULT }], caption: null },
    {
      id: "pg-2",
      chapterId: "ch-1",
      layout: "one-portrait",
      slots: [{ photoId: "p-tiny", crop: { x: 0.3, y: 0.6, zoom: 1.5 } }],
      caption: caption(EN_CAPTION, "Playfair", "center", "ai"),
    },
    {
      id: "pg-3",
      chapterId: "ch-1",
      layout: "two-vertical",
      slots: [
        { photoId: "p-landscape", crop: { x: 0.1, y: 0.9, zoom: 2 } },
        { photoId: MISSING_PHOTO_ID, crop: CROP_DEFAULT },
      ],
      caption: caption(AR_CAPTION, "Cairo", "right", "user"),
    },
    {
      id: "pg-4",
      chapterId: "ch-2",
      layout: "two-horizontal",
      slots: [
        { photoId: "p-pano", crop: { x: 0.5, y: 0.5, zoom: 4 } },
        { photoId: null, crop: CROP_DEFAULT },
      ],
      caption: caption(MIXED_CAPTION, "Tajawal", "left", "auto"),
    },
    {
      id: "pg-5",
      chapterId: "ch-2",
      layout: "three-mixed",
      slots: [
        { photoId: "p-square", crop: CROP_DEFAULT },
        { photoId: "p-nodims", crop: { x: 0.7, y: 0.2, zoom: 1.2 } },
        { photoId: "p-portrait", crop: { x: 0, y: 1, zoom: 3 } },
      ],
      caption: caption("Inter caption, left aligned", "Inter", "left", "user"),
    },
    {
      id: "pg-6",
      chapterId: null,
      layout: "four-grid",
      slots: [
        { photoId: "p-landscape", crop: CROP_DEFAULT },
        { photoId: "p-square", crop: { x: 1, y: 0, zoom: 1 } },
        { photoId: "p-tiny", crop: CROP_DEFAULT },
        { photoId: "p-pano", crop: CROP_DEFAULT },
      ],
      caption: null,
    },
  ];
  return baseDocV1(pages, { background: "#F5EFE6" });
}

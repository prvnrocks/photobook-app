// Modern sample books (M10b A9) for the dev-only render checks (/dev-book-page?sample=…,
// /dev-print?sample=…) and the m10b goldens: every modern layout of a format once, spreads on even
// indices (left halves), English + Arabic captions and chapter titles, one right half with its own
// background. Placeholder photos from devPreviewPhotos(). No user data.
//
// M10c T8c: geometric-* and scrapbook-* samples use EVERY layout of their style + orientation
// (cover, pages, spreads on even indices) — English, or Arabic with an `-ar` suffix (chapter
// titles, date labels, captions, cover). doc.occasion picks the accent sticker; scrapbook-portrait
// is "family" (accent-house): seasonal (Eid / Ramadan) stickers are never chosen by occasion, only
// by a layout naming them. The modern samples are frozen (m10b goldens) — don't change them.

import { getLayout } from "@/lib/layouts";
import { styleTokens } from "@/lib/design/styles";
import { devPreviewPhotos } from "./dev-preview";
import type { RenderPhotos } from "./render";
import type { Background, BookDoc, BookFormat, BookPage, Caption, Chapter, DesignStyle, Occasion } from "./types";

type M10cSampleBase = "geometric-portrait" | "geometric-landscape" | "scrapbook-portrait" | "scrapbook-landscape";
export type M10cSample = M10cSampleBase | `${M10cSampleBase}-ar`;
export type DevSample = "modern-portrait" | "modern-landscape" | M10cSample;

export const M10C_SAMPLES: readonly M10cSample[] = [
  "geometric-portrait",
  "geometric-landscape",
  "scrapbook-portrait",
  "scrapbook-landscape",
  "geometric-portrait-ar",
  "geometric-landscape-ar",
  "scrapbook-portrait-ar",
  "scrapbook-landscape-ar",
];

export const DEV_SAMPLES: readonly DevSample[] = ["modern-portrait", "modern-landscape", ...M10C_SAMPLES];

export function parseDevSample(raw: unknown): DevSample | null {
  return typeof raw === "string" && (DEV_SAMPLES as readonly string[]).includes(raw) ? (raw as DevSample) : null;
}

export function isM10cSample(s: DevSample): s is M10cSample {
  return (M10C_SAMPLES as readonly string[]).includes(s);
}

const EN = "The longest table, the loudest laughs, and everyone we love in one room.";
const AR = "أجمل ليلة بدأت بضحكة، وانتهت بذكرى لا تُنسى";

const CHAPTERS = [
  { id: "c1", title: "The mehndi night", dateLabel: "12 Oct 2026", place: "Abu Dhabi" },
  { id: "c2", title: "ليلة العمر", dateLabel: "١٣ أكتوبر ٢٠٢٦", place: null },
  { id: "c3", title: "A day by the sea", dateLabel: "14 Oct 2026", place: "Saadiyat" },
];

/** [layout id, chapter, caption language] per stored page; a spread id appears ONCE (left half). */
const ORDER: Record<"modern-portrait" | "modern-landscape", Array<[string, string, "en" | "ar" | null]>> = {
  "modern-portrait": [
    ["m-p-one-band", "c1", "ar"],
    ["m-p-two-panel", "c1", "en"],
    ["m-p-spread-mosaic", "c2", "ar"],
    ["m-p-spread-panorama", "c3", null],
    ["m-p-spread-grid", "c3", null],
    ["m-p-three-panel", "c3", "en"],
    ["m-p-four-grid", "c3", "ar"],
    ["m-p-five-mosaic", "c3", null],
    ["m-p-six-grid", "c3", "en"],
    ["m-p-full", "c3", null],
    ["m-p-two-stack", "c3", null],
    ["m-p-three-mosaic", "c3", null],
  ],
  "modern-landscape": [
    ["m-l-one-text", "c1", "en"],
    ["m-l-two", "c1", "ar"],
    ["m-l-spread-mosaic", "c2", "ar"],
    ["m-l-spread-panorama", "c3", null],
    ["m-l-spread-grid", "c3", null],
    ["m-l-one", "c3", "en"],
    ["m-l-three", "c3", "ar"],
    ["m-l-three-b", "c3", "en"],
    ["m-l-three-row", "c3", null],
    ["m-l-four", "c3", "en"],
    ["m-l-five", "c3", null],
    ["m-l-six", "c3", "ar"],
    ["m-l-full-bleed", "c3", null],
  ],
};

const caption = (lang: "en" | "ar"): Caption =>
  lang === "ar"
    ? { text: AR, font: "Amiri", align: "center", source: "ai" }
    : { text: EN, font: "Cormorant", align: "center", source: "ai" };

/** Photos used by any sample: cover d0, pages sp0…sp{SAMPLE_PHOTO_COUNT-1} (aliases of d1…d15). */
export const SAMPLE_PHOTO_COUNT = 64;

export function devSamplePhotos(): RenderPhotos {
  const base = devPreviewPhotos();
  const out: Record<string, RenderPhotos[string]> = { d0: base.d0 };
  for (let i = 0; i < SAMPLE_PHOTO_COUNT; i++) out[`sp${i}`] = base[`d${(i % 15) + 1}`];
  return out;
}

/** A valid book of `sample` (passes validateBookDoc with the devSamplePhotos() ids). */
export function devSampleDoc(sample: DevSample): BookDoc {
  if (isM10cSample(sample)) return m10cSampleDoc(sample);
  const format: BookFormat = sample === "modern-landscape" ? "A5_LANDSCAPE" : "A5_PORTRAIT";
  let n = 0;
  const nextPhoto = () => `sp${n++}`;
  const pages: BookPage[] = [];
  for (const [id, chapterId, lang] of ORDER[sample]) {
    const l = getLayout(id);
    if (!l) throw new Error(`dev sample: unknown layout ${id}`);
    const left: BookPage = {
      id: `s${pages.length}`,
      chapterId,
      layout: id,
      slots: l.slots.map(() => ({ photoId: nextPhoto(), crop: { x: 0.5, y: 0.5, zoom: 1 } })),
      caption: l.caption && lang ? caption(lang) : null,
    };
    if (l.role !== "spread") {
      pages.push(left);
      continue;
    }
    pages.push({ ...left, side: "left" });
    pages.push({
      id: `s${pages.length}`,
      chapterId,
      layout: id,
      side: "right",
      slots: [],
      caption: null,
      // The mosaic's right half shows its own background (each half keeps its page background).
      ...(id.endsWith("spread-mosaic") ? { background: { kind: "texture", textureId: "paper-cream", source: "user" } as const } : {}),
    });
  }
  return {
    version: 2,
    format,
    occasion: "wedding",
    cover: {
      layout: format === "A5_LANDSCAPE" ? "m-l-cover-strip" : "m-p-cover-strips",
      photoId: "d0",
      title: "Sara & Omar",
      subtitle: "Abu Dhabi · 2026",
    },
    chapters: CHAPTERS.map((c) => ({ ...c })),
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
  };
}

// --- M10c samples (geometric / scrapbook) ---------------------------------------------------------

interface M10cSpec {
  style: DesignStyle;
  format: BookFormat;
  occasion: Occasion;
  cover: string;
  /** [layout id, chapter, caption]; a spread id appears ONCE (left half, even index). */
  order: Array<[string, string, boolean]>;
  background: Background;
  en: { title: string; subtitle: string; chapters: Chapter[]; caption: string };
  ar: { title: string; subtitle: string; chapters: Chapter[]; caption: string };
}

const GEO_EN = {
  title: "Lanes & Light",
  subtitle: "A week away · 2026",
  chapters: [
    { id: "c1", title: "Old town walks", dateLabel: "3 Nov 2026", place: null },
    { id: "c2", title: "The long drive", dateLabel: "5 Nov 2026", place: null },
    { id: "c3", title: "Last evening", dateLabel: "8 Nov 2026", place: null },
  ],
  caption: "Narrow lanes, warm stone walls, and the slow light of late afternoon.",
};
const GEO_AR = {
  title: "أزقة وضوء",
  subtitle: "أسبوع بعيدًا، ٢٠٢٦",
  chapters: [
    { id: "c1", title: "جولة في المدينة القديمة", dateLabel: "٣ نوفمبر ٢٠٢٦", place: null },
    { id: "c2", title: "الطريق الطويل", dateLabel: "٥ نوفمبر ٢٠٢٦", place: null },
    { id: "c3", title: "المساء الأخير", dateLabel: "٨ نوفمبر ٢٠٢٦", place: null },
  ],
  caption: "أزقة ضيقة وجدران دافئة وضوء العصر الهادئ",
};
const SCRAP_EN = {
  title: "Our Family Days",
  subtitle: "Home · 2026",
  chapters: [
    { id: "c1", title: "Saturday lunch", dateLabel: "4 Apr 2026", place: null },
    { id: "c2", title: "In the garden", dateLabel: "18 Apr 2026", place: null },
    { id: "c3", title: "Little moments", dateLabel: "2 May 2026", place: null },
  ],
  caption: "The good plates, the long table, and everyone talking at once.",
};
const SCRAP_AR = {
  title: "أيامنا العائلية",
  subtitle: "البيت، ٢٠٢٦",
  chapters: [
    { id: "c1", title: "غداء السبت", dateLabel: "٤ أبريل ٢٠٢٦", place: null },
    { id: "c2", title: "في الحديقة", dateLabel: "١٨ أبريل ٢٠٢٦", place: null },
    { id: "c3", title: "لحظات صغيرة", dateLabel: "٢ مايو ٢٠٢٦", place: null },
  ],
  caption: "الأطباق الجميلة والطاولة الطويلة والجميع يتحدثون معًا",
};

const color = (style: DesignStyle): Background => ({ kind: "color", hex: styleTokens(style).palette?.background ?? "#FFFFFF" });

const M10C_SPECS: Record<M10cSampleBase, M10cSpec> = {
  "geometric-portrait": {
    style: "geometric",
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: "g-p-cover",
    order: [
      ["g-p-one-band", "c1", true],
      ["g-p-two-diag", "c1", true],
      ["g-p-spread-band", "c2", true],
      ["g-p-two-circle", "c2", true],
      ["g-p-three-diamond", "c3", true],
      ["g-p-four-petals", "c3", false],
      ["g-p-five-hex", "c3", true],
      ["g-p-two-pair", "c3", true],
    ],
    background: color("geometric"),
    en: GEO_EN,
    ar: GEO_AR,
  },
  "geometric-landscape": {
    style: "geometric",
    format: "A5_LANDSCAPE",
    occasion: "graduation",
    cover: "g-l-cover",
    order: [
      ["g-l-one-band", "c1", true],
      ["g-l-two-diag", "c1", true],
      ["g-l-spread-band", "c2", true],
      ["g-l-two-circle", "c2", true],
      ["g-l-three-diamond", "c3", true],
      ["g-l-four-petals", "c3", false],
      ["g-l-five-hex", "c3", true],
      ["g-l-two-stack", "c3", true],
    ],
    background: color("geometric"),
    en: GEO_EN,
    ar: GEO_AR,
  },
  "scrapbook-portrait": {
    style: "scrapbook",
    // "family" → accent-house; seasonal (Eid) motifs must NOT appear (never occasion-chosen).
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: "s-p-cover-polaroid",
    order: [
      ["s-p-one-polaroid", "c1", true],
      ["s-p-two-overlap", "c1", true],
      ["s-p-spread-hero", "c2", true],
      ["s-p-two-land", "c2", true],
      ["s-p-three-pile", "c2", false],
      ["s-p-spread-wall", "c3", true],
      ["s-p-four-pinned", "c3", true],
      ["s-p-five-collage", "c3", true],
    ],
    background: color("scrapbook"),
    en: SCRAP_EN,
    ar: SCRAP_AR,
  },
  "scrapbook-landscape": {
    style: "scrapbook",
    format: "A5_LANDSCAPE",
    occasion: "baby",
    cover: "s-l-cover-polaroid",
    order: [
      ["s-l-one-polaroid", "c1", true],
      ["s-l-two-overlap", "c1", true],
      ["s-l-spread-hero", "c2", true],
      ["s-l-two-land", "c2", true],
      ["s-l-three-row", "c2", true],
      ["s-l-spread-wall", "c3", true],
      ["s-l-four-scatter", "c3", false],
      ["s-l-five-collage", "c3", true],
    ],
    background: { kind: "texture", textureId: "paper-cream" },
    en: SCRAP_EN,
    ar: SCRAP_AR,
  },
};

function m10cSampleDoc(sample: M10cSample): BookDoc {
  const ar = sample.endsWith("-ar");
  const spec = M10C_SPECS[(ar ? sample.slice(0, -3) : sample) as M10cSampleBase];
  const text = ar ? spec.ar : spec.en;
  const font = ar ? "Amiri" : "Cormorant";
  let n = 0;
  const pages: BookPage[] = [];
  for (const [id, chapterId, withCaption] of spec.order) {
    const l = getLayout(id);
    if (!l) throw new Error(`dev sample: unknown layout ${id}`);
    if (l.role === "spread" && pages.length % 2 !== 0) throw new Error(`dev sample: spread ${id} on an odd index`);
    const left: BookPage = {
      id: `s${pages.length}`,
      chapterId,
      layout: id,
      slots: l.slots.map(() => ({ photoId: `sp${n++}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
      caption: l.caption && withCaption ? { text: text.caption, font, align: "center", source: "ai" } : null,
    };
    if (l.role !== "spread") {
      pages.push(left);
      continue;
    }
    pages.push({ ...left, side: "left" });
    pages.push({ id: `s${pages.length}`, chapterId, layout: id, side: "right", slots: [], caption: null });
  }
  return {
    version: 2,
    format: spec.format,
    occasion: spec.occasion,
    cover: { layout: spec.cover, photoId: "d0", title: text.title, subtitle: text.subtitle },
    chapters: text.chapters.map((c) => ({ ...c })),
    pages,
    style: { background: spec.background, designStyle: spec.style, font },
  };
}

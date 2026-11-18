// Dev-only fixtures for the M30 contact sheets (/dev-book-page?sheet=…): one small fixture book per
// layout (mid-length cover title, four chapters with titles, a ≈45-word description on chapter 0,
// dates, subtitle; English or Arabic) and three TEMPORARY demo layouts that exercise every M30
// renderer primitive before the real catalogues exist. No user data. Server-side only in practice:
// the sheet is built on the server page and only <BookPage> markup reaches the client.
//
// The demo layouts are NOT in the catalogue (src/lib/layouts): they render through
// <BookPage extraLayouts>. Delete M30_DEMO_LAYOUTS (and `?sheet=demo`) once T4–T7 land.

import { colourwaysFor } from "@/lib/design/colourways";
import { styleCaptionFont } from "@/lib/design/styles";
import { layoutShowsDescription } from "@/lib/layouts/description";
import { autoCoversFor, layoutsFor } from "./spreads";
import type { BookDoc, BookFormat, BookPage, Chapter, DesignStyle, Layout } from "./types";

// --- Demo layouts (temporary) --------------------------------------------------------------------

/**
 * Magazine cover: full-bleed photo, white masthead across the top, accent date line, three cover
 * lines down the right edge (the middle one in the vivid accent) and a paper strip at the foot with
 * a fourth cover line. Primitives: masthead role, ink paper / accentOnDark / ink, coverLine + n,
 * `over` blocks (accent bar, paper strip) and a block with `when` (the strip goes with its line).
 */
export const demoMagazineCover: Layout = {
  id: "demo-m30-cover-masthead",
  name: "Demo: masthead cover with cover lines",
  role: "cover",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["portrait"],
  slots: [{ x: 0, y: 0, w: 100, h: 100 }],
  caption: { x: 6, y: 4, w: 88, h: 30 },
  blocks: [
    // Accent bar under the date line.
    { box: { x: 6, y: 8.2, w: 14, h: 0.5 }, fill: "accent", layer: "over" },
    // Foot strip: only when there is a fourth chapter to print on it.
    { box: { x: 0, y: 88, w: 100, h: 12 }, fill: "paper", layer: "over", when: "coverLine" },
  ],
  texts: [
    { bind: "coverSubtitle", box: { x: 6, y: 4, w: 88, h: 3.6 }, align: "start", font: "year", ink: "accentOnDark" },
    { bind: "coverTitle", box: { x: 6, y: 10, w: 88, h: 24 }, align: "start", font: "masthead", ink: "paper" },
    { bind: "coverLine", n: 1, box: { x: 52, y: 40, w: 42, h: 9 }, align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 2, box: { x: 52, y: 50, w: 42, h: 9 }, align: "end", font: "chapter", ink: "accentOnDark" },
    { bind: "coverLine", n: 3, box: { x: 52, y: 60, w: 42, h: 9 }, align: "end", font: "chapter", ink: "paper" },
    { bind: "coverLine", n: 0, box: { x: 6, y: 90, w: 88, h: 8 }, align: "start", font: "subtitle", ink: "ink" },
  ],
};

/**
 * Magazine page: a photo on the left, a dark panel column on the right with the chapter title in
 * the vivid accent, the date, the chapter description and a small second photo; the caption sits
 * under the left photo. Primitives: `under` panel block, accent rule with `when`, body role,
 * ink accentOnDark / paper / muted, a caption coloured through the pageCaption panel.
 */
export const demoMagazinePanel: Layout = {
  id: "demo-m30-panel-page",
  name: "Demo: dark panel with heading + description",
  role: "page",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 2,
  prefers: ["portrait", "landscape"],
  slots: [
    { x: 0, y: 0, w: 50, h: 66 },
    { x: 56, y: 68, w: 38, h: 24 },
  ],
  caption: { x: 6, y: 70, w: 38, h: 22 },
  blocks: [
    { box: { x: 50, y: 0, w: 50, h: 100 }, fill: "panel", layer: "under" },
    // The rule belongs to the description: no description → no rule.
    { box: { x: 56, y: 27.4, w: 10, h: 0.4 }, fill: "accent", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    { bind: "dateLabel", box: { x: 56, y: 6, w: 38, h: 3.4 }, align: "start", font: "year", ink: "paper" },
    { bind: "chapterTitle", box: { x: 56, y: 10, w: 38, h: 16 }, align: "start", font: "chapter", ink: "accentOnDark" },
    { bind: "chapterDescription", box: { x: 56, y: 29, w: 38, h: 37 }, align: "start", font: "body", ink: "paper" },
    { bind: "pageCaption", box: { x: 6, y: 70, w: 38, h: 22 }, align: "start", font: "caption", ink: "muted" },
  ],
};

/**
 * Editorial page: white page, a diagonal-cut photo rising from the foot, a hairline parallel to the
 * cut, a paper strip over the photo carrying the date turned a quarter, a heavy sans title and the
 * description. Primitives: polygon photo slot, polygon hairline block (ink), `over` paper block,
 * rotate ±90 text, masthead role in a sentence-case style, ink accent (deepened for white pages).
 */
export const demoEditorialDiagonal: Layout = {
  id: "demo-m30-diagonal",
  name: "Demo: diagonal photo, hairline, vertical date",
  role: "page",
  style: "editorial",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [
    {
      x: 0,
      y: 46,
      w: 100,
      h: 54,
      shape: { kind: "polygon", points: [[0, 46], [100, 0], [100, 100], [0, 100]] },
    },
  ],
  caption: null,
  blocks: [
    // Hairline 0.37 mm, parallel to the photo's cut, 9 mm above it. The box is ~1 % of the page
    // taller than the line at both ends: in print the ends run on into the bleed along the line's
    // own slope, and a block only paints inside its box.
    { box: { x: 0, y: 40.7, w: 100, h: 27.1 }, fill: "ink", layer: "under", points: [[0, 95.6], [100, 3.7], [100, 4.35], [0, 96.25]] },
    { box: { x: 80, y: 56, w: 11, h: 44 }, fill: "paper", layer: "over" },
    // "ink", not "accent": the vivid accent is made for dark surfaces (editorial "ink" colourway: near-white).
    { box: { x: 8, y: 22.6, w: 9, h: 0.6 }, fill: "ink", layer: "under", when: "chapterDescription" },
  ],
  texts: [
    { bind: "chapterTitle", box: { x: 8, y: 7, w: 62, h: 14 }, align: "start", font: "masthead", ink: "ink" },
    { bind: "chapterDescription", box: { x: 8, y: 25, w: 56, h: 22 }, align: "start", font: "body", ink: "muted" },
    { bind: "dateLabel", box: { x: 82, y: 60, w: 7, h: 34 }, align: "start", font: "year", ink: "accent", rotate: -90 },
    { bind: "dateLabel", box: { x: 86, y: 7, w: 6, h: 26 }, align: "start", font: "year", ink: "muted", rotate: 90 },
  ],
};

export const M30_DEMO_LAYOUTS: readonly Layout[] = [demoMagazineCover, demoMagazinePanel, demoEditorialDiagonal];

// --- Sheet fixtures ------------------------------------------------------------------------------

export type M30SheetStyle = "magazine" | "editorial";
export interface M30Sheet {
  /** null = the demo sheet (every demo layout, each in its own style + format). */
  style: M30SheetStyle | null;
  format: BookFormat;
}

/** `magazine-portrait` | `magazine-landscape` | `editorial-portrait` | `editorial-landscape` | `demo`. */
export function parseM30Sheet(raw: unknown): M30Sheet | null {
  if (raw === "demo") return { style: null, format: "A5_PORTRAIT" };
  const m = typeof raw === "string" ? /^(magazine|editorial)-(portrait|landscape)$/.exec(raw) : null;
  if (!m) return null;
  return { style: m[1] as M30SheetStyle, format: m[2] === "portrait" ? "A5_PORTRAIT" : "A5_LANDSCAPE" };
}

export interface M30SheetOptions {
  /** Arabic title, subtitle, chapter titles, dates, description and caption. */
  arabic?: boolean;
  /** false = no chapter has a description (panels and `when` blocks collapse). */
  descriptions?: boolean;
  /** Colourway id; ignored unless the layout's style has it. */
  colourway?: string | null;
}

// 45 words.
const DESCRIPTION_EN =
  "We left before sunrise and followed the old road into the hills. By noon the valley opened below us, " +
  "all terraces and stone houses, and we stopped for tea with a family who waved us in. Nobody checked the " +
  "time until the light turned gold.";
// 45 words.
const DESCRIPTION_AR =
  "غادرنا قبل شروق الشمس وسلكنا الطريق القديم نحو التلال. عند الظهيرة انفتح الوادي أمامنا بمدرجاته وبيوته " +
  "الحجرية، فتوقفنا لشرب الشاي مع عائلة لوّحت لنا بالدخول. لم ينظر أحد منا إلى الساعة حتى صار الضوء ذهبيًا " +
  "وامتدت الظلال الطويلة على الطريق أمامنا ونحن نعود إلى البيت.";

const EN = {
  title: "Ten days across the Hajar peaks", // 31 code points
  subtitle: "Oman · November 2026",
  caption: "The last bend before the village, with the whole valley in view.",
  chapters: [
    { id: "c1", title: "Into the hills", dateLabel: "3 Nov 2026", place: null },
    { id: "c2", title: "The valley road", dateLabel: "5 Nov 2026", place: null },
    { id: "c3", title: "Tea with strangers", dateLabel: "7 Nov 2026", place: null },
    { id: "c4", title: "Golden hour", dateLabel: "9 Nov 2026", place: null },
  ],
  description: DESCRIPTION_EN,
};
const AR = {
  title: "عشرة أيام بين قمم جبال الحجر", // 28 code points
  subtitle: "عُمان · نوفمبر ٢٠٢٦",
  caption: "المنعطف الأخير قبل القرية، والوادي كله أمامنا.",
  chapters: [
    { id: "c1", title: "نحو التلال", dateLabel: "٣ نوفمبر ٢٠٢٦", place: null },
    { id: "c2", title: "طريق الوادي", dateLabel: "٥ نوفمبر ٢٠٢٦", place: null },
    { id: "c3", title: "شاي مع الغرباء", dateLabel: "٧ نوفمبر ٢٠٢٦", place: null },
    { id: "c4", title: "الساعة الذهبية", dateLabel: "٩ نوفمبر ٢٠٢٦", place: null },
  ],
  description: DESCRIPTION_AR,
};

export interface M30SheetItem {
  layout: Pick<Layout, "id" | "name" | "role" | "style" | "format" | "photoCount">;
  doc: BookDoc;
  /** What to render: the cover, one page, or the two halves of a spread. */
  targets: ReadonlyArray<"cover" | number>;
}

/**
 * A fixture book showing exactly `layout`: as the cover, as page 0, or as the spread on pages 0–1.
 * Photos: cover `d0`, slots `sp0…` (devSamplePhotos). Every page belongs to chapter 0, the one
 * with the description.
 */
export function m30SheetItem(layout: Layout, opts: M30SheetOptions = {}): M30SheetItem {
  const t = opts.arabic ? AR : EN;
  const style: DesignStyle = layout.style;
  const chapters: Chapter[] = t.chapters.map((c, i) => ({
    ...c,
    ...(i === 0 && opts.descriptions !== false ? { description: { text: t.description, source: "ai" as const } } : {}),
  }));
  const font = styleCaptionFont(style, opts.arabic ? "ar" : "en");
  const cw = colourwaysFor(style).find((c) => c.id === opts.colourway);
  const pages: BookPage[] = [];
  if (layout.role !== "cover") {
    const left: BookPage = {
      id: "p0",
      chapterId: "c1",
      layout: layout.id,
      slots: layout.slots.map((_s, i) => ({ photoId: `sp${i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
      caption: layout.caption ? { text: t.caption, font, align: "center", source: "ai" } : null,
    };
    if (layout.role === "spread") {
      pages.push({ ...left, side: "left" }, { id: "p1", chapterId: "c1", layout: layout.id, side: "right", slots: [], caption: null });
    } else {
      pages.push(left);
    }
  }
  const doc: BookDoc = {
    version: 2,
    format: layout.format,
    occasion: "travel",
    cover: { layout: layout.role === "cover" ? layout.id : "cover", photoId: "d0", title: t.title, subtitle: t.subtitle },
    chapters,
    pages,
    style: {
      background: { kind: "color", hex: "#FFFFFF" },
      designStyle: style,
      font,
      ...(cw ? { colourway: { id: cw.id, source: "user" as const } } : {}),
    },
  };
  return {
    layout: { id: layout.id, name: layout.name, role: layout.role, style: layout.style, format: layout.format, photoCount: layout.photoCount },
    doc,
    targets: layout.role === "cover" ? ["cover"] : layout.role === "spread" ? [0, 1] : [0],
  };
}

// --- Editor fixture book (M30 T13) ---------------------------------------------------------------

export interface M30EditorBookOptions {
  /** Arabic title, chapter titles, descriptions and captions. */
  arabic?: boolean;
  /** false = no chapter has a description (a rule / AI-off album): every description area is empty. */
  descriptions?: boolean;
}

/**
 * A small magazine / editorial book for the dev editor (`/dev-editor?style=…`): the style's auto
 * cover, four chapters and nine pages picked from the real catalogue by what they show —
 *   0 description page (chapter 1, AI description) · 1 plain page
 *   2 description page (chapter 2, NO description → the editor's "add" hint) · 3 plain page
 *   4–5 a spread, one that shows the description when the catalogue has it (chapter 3, AI description)
 *   6–7 plain pages · 8 plain page (chapter 4)
 * Photos: cover `d0`, slots `sp0…` (devSamplePhotos). Colourway: the style's second one, source
 * "ai" (as a build would stamp it). Valid for validateBookDoc.
 */
export function m30EditorDoc(style: M30SheetStyle, format: BookFormat, opts: M30EditorBookOptions = {}): BookDoc {
  const t = opts.arabic ? AR : EN;
  const withText = opts.descriptions !== false;
  const all = layoutsFor(format, style, "page");
  const described = all.filter((l) => layoutShowsDescription(l));
  const plain = all.filter((l) => !layoutShowsDescription(l));
  const spreads = layoutsFor(format, style, "spread");
  const spread = spreads.find((l) => layoutShowsDescription(l)) ?? spreads[0];
  const pick = (list: readonly Layout[], i: number) => list[i % list.length];
  const order: Array<[Layout, string]> = [
    [pick(described, 0), "c1"],
    [pick(plain, 1), "c1"],
    [pick(described, 1), "c2"],
    [pick(plain, 2), "c2"],
    [spread, "c3"],
    [pick(plain, 3), "c3"],
    [pick(plain, 4), "c3"],
    [pick(plain, 5), "c4"],
  ];
  const font = styleCaptionFont(style, opts.arabic ? "ar" : "en");
  let n = 0;
  const pages: BookPage[] = [];
  for (const [layout, chapterId] of order) {
    const left: BookPage = {
      id: `mp${pages.length}`,
      chapterId,
      layout: layout.id,
      slots: layout.slots.map(() => ({ photoId: `sp${n++}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
      caption: layout.caption && pages.length % 3 !== 2 ? { text: t.caption, font, align: "center", source: "ai" } : null,
    };
    if (layout.role === "spread") {
      pages.push({ ...left, side: "left" }, { id: `mp${pages.length + 1}`, chapterId, layout: layout.id, side: "right", slots: [], caption: null });
    } else {
      pages.push(left);
    }
  }
  const chapters: Chapter[] = t.chapters.map((c, i) => ({
    ...c,
    ...(withText && (i === 0 || i === 2) ? { description: { text: t.description, source: "ai" as const } } : {}),
  }));
  const colourway = colourwaysFor(style)[1];
  return {
    version: 2,
    format,
    occasion: "travel",
    cover: { layout: autoCoversFor(format, style)[0].id, photoId: "d0", title: t.title, subtitle: t.subtitle },
    chapters,
    pages,
    style: {
      background: { kind: "color", hex: "#FFFFFF" },
      designStyle: style,
      font,
      ...(colourway ? { colourway: { id: colourway.id, source: "ai" as const } } : {}),
    },
  };
}

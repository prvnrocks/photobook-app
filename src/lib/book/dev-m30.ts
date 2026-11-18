// Dev-only fixtures for the M30 contact sheets (/dev-book-page?sheet=…): one small fixture book per
// layout (mid-length cover title, four chapters with titles, a ≈45-word description on chapter 0,
// dates, subtitle; English or Arabic), and the small magazine / editorial book of the dev editor
// (/dev-editor?style=…) and the dev print check (/dev-print?m30=…). No user data. Server-side only in
// practice: the fixtures are built on the server page and only <BookPage> markup reaches the client.
// (The three temporary demo layouts of T3 moved to tests/fixtures/test-m30-demo-layouts.ts at T14a.)

import { colourwaysFor } from "@/lib/design/colourways";
import { styleCaptionFont } from "@/lib/design/styles";
import { layoutShowsDescription } from "@/lib/layouts/description";
import { autoCoversFor, layoutsFor } from "./spreads";
import type { BookDoc, BookFormat, BookPage, Chapter, DesignStyle, Layout } from "./types";

// --- Sheet fixtures ------------------------------------------------------------------------------

export type M30SheetStyle = "magazine" | "editorial";
export interface M30Sheet {
  style: M30SheetStyle;
  format: BookFormat;
}

/** `magazine-portrait` | `magazine-landscape` | `editorial-portrait` | `editorial-landscape`. */
export function parseM30Sheet(raw: unknown): M30Sheet | null {
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

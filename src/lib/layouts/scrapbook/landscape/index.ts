// scrapbook/landscape layouts (M10c T6b). Pure data, original artwork. Append-only order (AI catalogue / prompt cache).
//
// Designed in mm on the A5 landscape trim (210 × 148) with ../geometry (spreads: x 0..420, fold at
// 210). Same scrapbook language as the portrait set (polaroids, bordered prints, gentle tilt,
// small overlaps with z, tape, stickers, the occasion accent, label plates on chapterTitle /
// dateLabel only) but composed for a wide page: photos on the left two-thirds with a text column
// on the right, rows of prints, or a caption band along the bottom. Rules: see
// tests/layouts-scrapbook.test.ts and the portrait module header.

import type { Layout, LayoutDecoration, LayoutSlotDef, LayoutText, Rect } from "@/lib/book/types";
import { BORDER, BORDER_S, type CardMm, POLAROID_L, POLAROID_M, POLAROID_S, scrapGeo } from "../geometry";

const g = scrapGeo("A5_LANDSCAPE");
const W = g.page.w; // 210
const BASE = { role: "page", style: "scrapbook", format: "A5_LANDSCAPE" } as const;

interface Half {
  slots: LayoutSlotDef[];
  decorations: LayoutDecoration[];
  texts: LayoutText[];
  caption: Rect | null;
}

const shift = (c: CardMm, ox: number): CardMm => ({ ...c, x: c.x + ox });
const captionText = (r: Rect, align: LayoutText["align"] = "center"): LayoutText => ({ bind: "pageCaption", box: r, align, font: "caption" });

// --- Page compositions (ox = x offset in mm: 0 for single pages, W for a spread's right page) ----

/** One landscape polaroid on the left, text column (label, date tag, caption) on the right. */
function onePolaroid(ox = 0): Half {
  const card = shift({ x: 12, y: 12, w: 124, h: 122, rotate: -2, frame: POLAROID_L, shadow: "soft" }, ox);
  const caption = g.rect(ox + 142, 60, 60, 58);
  return {
    slots: [g.slot(card)],
    decorations: [
      g.tape("tape-washi", card, -0.9, -0.94, 30, -36),
      g.tape("tape-washi", card, 0.42, -1, 30, 5),
      g.deco("sticker", "occasion-accent", ox + 190, 132, 18, { rotate: 8 }),
      g.deco("sticker", "sparkle", ox + 160, 132, 9),
    ],
    texts: [
      g.plate("chapterTitle", "plate-label", ox + 141, 16, 60, "chapter", 3),
      g.plate("dateLabel", "plate-tag", ox + 148, 37, 44, "year", -3),
      captionText(caption, "start"),
    ],
    caption,
  };
}

/** Two portrait polaroids overlapping, chapter title, date tag and caption in the right column. */
function twoOverlap(ox = 0): Half {
  const a = shift({ x: 12, y: 14, w: 72, h: 96, rotate: -4, frame: POLAROID_M }, ox);
  const b = shift({ x: 72, y: 32, w: 72, h: 96, rotate: 3, frame: POLAROID_M, shadow: "soft", z: 1 }, ox);
  const caption = g.rect(ox + 152, 66, 50, 58);
  return {
    slots: [g.slot(a), g.slot(b)],
    decorations: [
      g.tape("tape-kraft", a, 0, -1, 28, 3),
      g.tape("tape-striped", b, 0.3, -1, 24, -4),
      g.deco("sticker", "heart-kraft", ox + 34, 128, 16, { rotate: -10 }),
      g.deco("sticker", "flower", ox + 182, 134, 14, { rotate: 12 }),
    ],
    texts: [
      g.text("chapterTitle", ox + 152, 18, 50, 24, "chapter", "start"),
      g.plate("dateLabel", "plate-tag", ox + 154, 46, 44, "year", -3),
      captionText(caption, "start"),
    ],
    caption,
  };
}

/** Two landscape polaroids side by side, label + date tag above, caption band below. */
function twoLandscape(ox = 0): Half {
  const a = shift({ x: 12, y: 26, w: 96, h: 84, rotate: -3, frame: POLAROID_M }, ox);
  const b = shift({ x: 102, y: 34, w: 96, h: 84, rotate: 2.5, frame: POLAROID_M, shadow: "soft", z: 1 }, ox);
  const caption = g.rect(ox + 14, 124, 182, 18);
  return {
    slots: [g.slot(a), g.slot(b)],
    decorations: [
      g.tape("tape-washi", a, -0.9, 0.92, 26, 36),
      g.tape("tape-kraft", b, 0.9, -0.94, 22, 38),
      g.deco("sticker", "sparkle", ox + 160, 14, 10),
      g.deco("sticker", "heart-outline", ox + 176, 20, 9, { rotate: 12 }),
    ],
    texts: [
      g.plate("chapterTitle", "plate-label", ox + 14, 7, 64, "chapter", -2),
      g.plate("dateLabel", "plate-tag", ox + 86, 9, 40, "year", 3),
      captionText(caption),
    ],
    caption,
  };
}

/** Three portrait polaroids in a row (the middle one on top), tape on each, caption band below. */
function threeRow(ox = 0, withCaption = true): Half {
  const y = withCaption ? 12 : 22;
  const cards = ([
    { x: 12, y, w: 64, h: 96, rotate: -3, frame: POLAROID_S },
    { x: 73, y: y + 6, w: 64, h: 96, rotate: 2, frame: POLAROID_S, shadow: "soft", z: 1 },
    { x: 134, y: y + 2, w: 64, h: 96, rotate: -2, frame: POLAROID_S },
  ] as CardMm[]).map((c) => shift(c, ox));
  const caption = withCaption ? g.rect(ox + 14, 118, 182, 22) : null;
  const tapes = ["tape-washi", "tape-striped", "tape-kraft"] as const;
  return {
    slots: cards.map(g.slot),
    decorations: [
      ...cards.map((c, i) => g.tape(tapes[i], c, 0, -1, 24, i === 1 ? 3 : -3)),
      withCaption
        ? g.deco("sticker", "sparkle", ox + 202, 10, 8)
        : g.deco("sticker", "heart-outline", ox + 105, 136, 9, { rotate: -8 }),
    ],
    texts: caption ? [captionText(caption)] : [],
    caption,
  };
}

/** Four bordered prints in a loose 2×2 on the left, a heart in the middle, caption on the right. */
function fourScatter(ox = 0, withCaption = true): Half {
  // With the caption column: 60 mm squares on the left two-thirds. Without (a spread's right
  // page): wider prints spread over the whole page.
  const w = withCaption ? 60 : 80;
  const h = withCaption ? 60 : 64;
  const x1 = withCaption ? 12 : 18;
  const x2 = withCaption ? 78 : 112;
  const cards = ([
    { x: x1, y: 10, w, h, rotate: -3, frame: BORDER },
    { x: x2, y: 14, w, h, rotate: 2, frame: BORDER },
    { x: x1 + 2, y: 76, w, h, rotate: 2.5, frame: BORDER },
    { x: x2, y: 74 + (withCaption ? 0 : 2), w, h, rotate: -2, frame: BORDER },
  ] as CardMm[]).map((c) => shift(c, ox));
  const caption = withCaption ? g.rect(ox + 150, 44, 52, 60) : null;
  const tapes = ["tape-washi", "tape-kraft", "tape-kraft", "tape-washi"] as const;
  const mid = (x1 + w + x2) / 2;
  return {
    slots: cards.map(g.slot),
    decorations: [
      ...cards.map((c, i) => g.tape(tapes[i], c, 0, -1, 22, i % 2 ? 4 : -4)),
      g.deco("sticker", "heart-kraft", ox + mid, withCaption ? 74 : 72, 12, { rotate: -8 }),
      withCaption
        ? g.deco("sticker", "occasion-accent", ox + 176, 124, 18, { rotate: 8 })
        : g.deco("sticker", "sparkle", ox + 200, 16, 9),
    ],
    texts: caption ? [captionText(caption, "start")] : [],
    caption,
  };
}

/** Two wide prints on top, three smaller prints overlapping below. No caption. */
function fiveCollage(ox = 0): Half {
  const cards = ([
    { x: 12, y: 12, w: 100, h: 76, rotate: -2, frame: BORDER },
    { x: 118, y: 12, w: 80, h: 60, rotate: 3, frame: BORDER },
    { x: 12, y: 88, w: 60, h: 48, rotate: 3, frame: BORDER_S, z: 1 },
    { x: 76, y: 84, w: 60, h: 52, rotate: -2, frame: BORDER_S, shadow: "soft", z: 1 },
    { x: 140, y: 76, w: 58, h: 58, rotate: 4, frame: BORDER_S, z: 1 },
  ] as CardMm[]).map((c) => shift(c, ox));
  return {
    slots: cards.map(g.slot),
    decorations: [
      g.tape("tape-washi", cards[0], -0.92, -0.9, 24, -36),
      g.tape("tape-striped", cards[4], 0, -1, 22, -3),
      g.deco("sticker", "star", ox + 116, 80, 10, { rotate: -12 }),
      g.deco("sticker", "heart-outline", ox + 74, 140, 8, { rotate: 10 }),
    ],
    texts: [],
    caption: null,
  };
}

function page(id: string, name: string, h: Half, prefers: Layout["prefers"]): Layout {
  return {
    ...BASE,
    id,
    name,
    photoCount: h.slots.length,
    prefers,
    slots: h.slots,
    caption: h.caption,
    texts: h.texts,
    decorations: h.decorations,
  };
}

function spread(id: string, name: string, l: Half, r: Half, prefers: Layout["prefers"], twin: [string, string]): Layout {
  return {
    ...BASE,
    role: "spread",
    id,
    name,
    photoCount: l.slots.length + r.slots.length,
    prefers,
    slots: [...l.slots, ...r.slots],
    caption: l.caption,
    texts: [...l.texts, ...r.texts],
    decorations: [...l.decorations, ...r.decorations],
    twin,
  };
}

// --- Single pages --------------------------------------------------------------------------------

export const scrapbookLandscapeOnePolaroid = page("s-l-one-polaroid", "1 polaroid with label and text column", onePolaroid(), ["landscape"]);
export const scrapbookLandscapeTwoOverlap = page("s-l-two-overlap", "2 overlapping polaroids with text column", twoOverlap(), ["portrait", "portrait"]);
export const scrapbookLandscapeTwoLandscape = page("s-l-two-land", "2 wide polaroids with label", twoLandscape(), ["landscape", "landscape"]);
export const scrapbookLandscapeThreeRow = page("s-l-three-row", "3 taped polaroids in a row", threeRow(), ["portrait", "portrait", "portrait"]);
export const scrapbookLandscapeFourScatter = page("s-l-four-scatter", "4 taped prints with caption", fourScatter(), ["any", "any", "any", "any"]);
export const scrapbookLandscapeFiveCollage = page(
  "s-l-five-collage",
  "5 photo collage",
  fiveCollage(),
  ["landscape", "landscape", "any", "any", "any"],
);

// --- Spreads (x 0..200) --------------------------------------------------------------------------

/** Left: the hero polaroid with label, date and caption; right: three polaroids in a row. */
export const scrapbookLandscapeSpreadHero = spread(
  "s-l-spread-hero",
  "Hero polaroid + 3 polaroids across two pages",
  onePolaroid(),
  threeRow(W, false),
  ["landscape", "portrait", "portrait", "portrait"],
  ["s-l-one-polaroid", "s-l-three-row"],
);

/** Left: two overlapping polaroids with title, date and caption; right: four taped prints. */
export const scrapbookLandscapeSpreadWall = spread(
  "s-l-spread-wall",
  "6 taped photos across two pages",
  twoOverlap(),
  fourScatter(W, false),
  ["portrait", "portrait", "any", "any", "any", "any"],
  ["s-l-two-overlap", "s-l-four-scatter"],
);

// --- Cover ---------------------------------------------------------------------------------------

const coverCard: CardMm = { x: 16, y: 14, w: 108, h: 120, rotate: -3, frame: { kind: "polaroid", side: 5, bottom: 16 }, shadow: "soft" };
const coverTitle = g.text("coverTitle", 132, 50, 68, 34, "title", "center");
const coverYear = g.text("coverSubtitle", 136, 86, 60, 10, "year", "center");

/** A big tilted polaroid on the left, Bebas title + year on the right, accent and tape. */
export const scrapbookLandscapeCoverPolaroid: Layout = {
  ...BASE,
  role: "cover",
  id: "s-l-cover-polaroid",
  name: "Cover: taped polaroid + title",
  photoCount: 1,
  prefers: ["any"],
  slots: [g.slot(coverCard)],
  caption: g.rect(132, 50, 68, 46),
  texts: [coverTitle, coverYear],
  decorations: [
    g.tape("tape-washi", coverCard, 0, -1, 40, -5),
    g.deco("sticker", "occasion-accent", 166, 30, 26, { rotate: 8 }),
    g.deco("sticker", "heart-kraft", ...g.on(coverCard, 0.96, 0.8), 15, { rotate: 14 }),
    g.deco("sticker", "sparkle", 150, 116, 10),
    g.deco("sticker", "leaf-sprig", 186, 118, 13, { rotate: 24, layer: "under" }),
  ],
};

export const SCRAPBOOK_LANDSCAPE_LAYOUTS: readonly Layout[] = [
  scrapbookLandscapeCoverPolaroid,
  scrapbookLandscapeOnePolaroid,
  scrapbookLandscapeTwoOverlap,
  scrapbookLandscapeTwoLandscape,
  scrapbookLandscapeThreeRow,
  scrapbookLandscapeFourScatter,
  scrapbookLandscapeFiveCollage,
  scrapbookLandscapeSpreadHero,
  scrapbookLandscapeSpreadWall,
];

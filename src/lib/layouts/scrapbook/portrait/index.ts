// scrapbook/portrait layouts (M10c T6a). Pure data, original artwork. Append-only order (AI catalogue / prompt cache).
//
// Designed in mm on the A5 portrait trim (148 × 210) with ../geometry (spreads: x 0..296, fold at
// 148). The scrapbook look: photos as prints — polaroid cards and white-bordered prints with a
// gentle tilt (±2–4°), a few overlapping with paint order (z), tape on tops/corners, small
// stickers (hearts, sparkles, flower, leaf) and the occasion accent ("occasion-accent", picked
// from doc.occasion by the renderer). Rules (tests/layouts-scrapbook.test.ts):
// - photos stay inside the 4 mm safe zone (framed/tilted prints never bleed); overlaps are small;
// - label plates bind to chapterTitle / dateLabel only, never pageCaption;
// - the caption area and every unplated text are clear of photos and stickers;
// - text ≥ 8 mm from both side edges on single pages (a page may land left or right), ≥ 8 mm from
//   the fold on spreads; ≤ 6 decorations per page; shadows only on hero polaroids ("soft").
// Spreads: left page first, then right; each spread's left half has the caption; twins are single
// pages of this set holding at least each half's photos (D-064).

import type { Layout, LayoutDecoration, LayoutSlotDef, LayoutText, Rect } from "@/lib/book/types";
import { BORDER, BORDER_S, type CardMm, POLAROID_L, POLAROID_M, POLAROID_S, scrapGeo } from "../geometry";

const g = scrapGeo("A5_PORTRAIT");
const W = g.page.w; // 148
const BASE = { role: "page", style: "scrapbook", format: "A5_PORTRAIT" } as const;

interface Half {
  slots: LayoutSlotDef[];
  decorations: LayoutDecoration[];
  texts: LayoutText[];
  caption: Rect | null;
}

const shift = (c: CardMm, ox: number): CardMm => ({ ...c, x: c.x + ox });
const captionText = (r: Rect): LayoutText => ({ bind: "pageCaption", box: r, align: "center", font: "caption" });

// --- Page compositions (ox = x offset in mm: 0 for single pages, W for a spread's right page) ----

/** One portrait polaroid, chapter label + date tag above, caption below. */
function onePolaroid(ox = 0): Half {
  const card = shift({ x: 24, y: 40, w: 100, h: 124, rotate: 2.5, frame: POLAROID_L, shadow: "soft" }, ox);
  const caption = g.rect(ox + 14, 176, 120, 26);
  return {
    slots: [g.slot(card)],
    decorations: [
      g.tape("tape-washi", card, 0, -1, 34, -5),
      g.deco("sticker", "occasion-accent", ...pt(g.on(card, -0.86, 0.9), 2, -2), 20, { rotate: -10 }),
      g.deco("sticker", "heart-outline", ...pt(g.on(card, 0.94, -0.8), 1, 0), 12, { rotate: 14 }),
    ],
    texts: [
      g.plate("chapterTitle", "plate-label", ox + 14, 12, 72, "chapter", -2),
      g.plate("dateLabel", "plate-tag", ox + 92, 15, 42, "year", 3),
      captionText(caption),
    ],
    caption,
  };
}

/** Two portrait polaroids overlapping on the diagonal, label + tag above, caption below. */
function twoOverlap(ox = 0): Half {
  const a = shift({ x: 12, y: 32, w: 72, h: 88, rotate: -4, frame: POLAROID_M }, ox);
  const b = shift({ x: 64, y: 80, w: 72, h: 88, rotate: 3, frame: POLAROID_M, shadow: "soft", z: 1 }, ox);
  const caption = g.rect(ox + 14, 180, 120, 22);
  return {
    slots: [g.slot(a), g.slot(b)],
    decorations: [
      g.tape("tape-kraft", a, 0, -1, 28, 3),
      g.tape("tape-striped", b, 0.92, -0.96, 24, 40),
      g.deco("sticker", "flower", ox + 112, 56, 20, { rotate: 10 }),
      g.deco("sticker", "sparkle", ox + 128, 74, 9),
      g.deco("sticker", "heart-kraft", ox + 34, 148, 18, { rotate: -10 }),
    ],
    texts: [
      g.plate("chapterTitle", "plate-label", ox + 12, 10, 70, "chapter", -2),
      g.plate("dateLabel", "plate-tag", ox + 92, 13, 42, "year", 4),
      captionText(caption),
    ],
    caption,
  };
}

/** A wide polaroid on top, two portrait prints tucked over its lower edge, caption below. */
function threePile(ox = 0, withCaption = true): Half {
  const a = shift({ x: 14, y: 14, w: 120, h: 92, rotate: -2, frame: POLAROID_M }, ox);
  const b = shift({ x: 14, y: 98, w: 62, h: 74, rotate: 4, frame: POLAROID_S, z: 1 }, ox);
  const c = shift({ x: 72, y: 102, w: 62, h: 74, rotate: -3, frame: POLAROID_S, shadow: "soft", z: 2 }, ox);
  const caption = withCaption ? g.rect(ox + 14, 184, 120, 20) : null;
  const decorations = [
    g.tape("tape-washi", a, -0.94, -0.92, 26, -38),
    g.tape("tape-washi", a, 0.94, -0.92, 26, 38),
    g.deco("sticker", "sparkle", ox + 76, 98, 9, { layer: "under" }),
  ];
  if (!withCaption) decorations.push(g.deco("sticker", "flower", ox + 74, 192, 12, { rotate: 12 }));
  return {
    slots: [g.slot(a), g.slot(b), g.slot(c)],
    decorations,
    texts: caption ? [captionText(caption)] : [],
    caption,
  };
}

/** Four bordered prints pinned with tape, alternating tilt, a heart in the middle, caption below. */
function fourPinned(ox = 0, withCaption = true): Half {
  // Without a caption (a spread's right page) the prints grow to fill the page.
  const top = withCaption ? 16 : 20;
  const row2 = withCaption ? 92 : 106;
  const h = withCaption ? 62 : 76;
  const w = withCaption ? 58 : 60;
  const cards = ([
    { x: 12, y: top, w, h, rotate: -3, frame: BORDER },
    { x: 136 - w, y: top + 4, w, h, rotate: 2, frame: BORDER },
    { x: 14, y: row2, w, h, rotate: 2.5, frame: BORDER },
    { x: 136 - w, y: row2 + 2, w, h, rotate: -2, frame: BORDER },
  ] as CardMm[]).map((c) => shift(c, ox));
  const caption = withCaption ? g.rect(ox + 14, 172, 120, 26) : null;
  const tapes = ["tape-washi", "tape-kraft", "tape-kraft", "tape-washi"] as const;
  return {
    slots: cards.map(g.slot),
    decorations: [
      // Three prints taped, the bottom-left one held by a photo-corner set.
      ...cards.flatMap((c, i) => (i === 2 ? g.corners(c, 9) : [g.tape(tapes[i], c, 0, -1, 24, i % 2 ? 4 : -4)])),
      g.deco("sticker", "heart-kraft", ox + 74, (top + h + row2) / 2 + 1, 13, { rotate: -8 }),
    ],
    texts: caption ? [captionText(caption)] : [],
    caption,
  };
}

/** A portrait polaroid with four smaller prints around and over it, caption below. */
function fiveCollage(ox = 0): Half {
  const cards = ([
    { x: 12, y: 14, w: 76, h: 100, rotate: -3, frame: POLAROID_M },
    { x: 84, y: 18, w: 52, h: 46, rotate: 4, frame: BORDER_S, z: 1 },
    { x: 84, y: 70, w: 52, h: 46, rotate: -2, frame: BORDER_S, z: 1 },
    { x: 14, y: 120, w: 58, h: 50, rotate: 2, frame: BORDER_S, z: 1 },
    { x: 76, y: 122, w: 60, h: 50, rotate: -3, frame: BORDER_S, shadow: "soft", z: 2 },
  ] as CardMm[]).map((c) => shift(c, ox));
  const caption = g.rect(ox + 14, 182, 120, 20);
  return {
    slots: cards.map(g.slot),
    decorations: [
      g.tape("tape-striped", cards[1], 0.9, -0.94, 20, 38),
      g.tape("tape-washi", cards[4], 0, -1, 24, 3),
      ...g.corners(cards[3], 8),
      g.deco("sticker", "heart-outline", ox + 132, 120, 10, { rotate: 12 }),
    ],
    texts: [captionText(caption)],
    caption,
  };
}

/** Chapter label + date tag on top, two landscape prints staggered below, caption at the bottom. */
function twoLandscape(ox = 0): Half {
  const a = shift({ x: 12, y: 30, w: 104, h: 70, rotate: -2.5, frame: BORDER }, ox);
  const b = shift({ x: 32, y: 106, w: 104, h: 70, rotate: 2, frame: BORDER }, ox);
  const caption = g.rect(ox + 14, 184, 120, 20);
  return {
    slots: [g.slot(a), g.slot(b)],
    decorations: [
      g.tape("tape-washi", a, -0.92, 0.9, 24, 36),
      g.tape("tape-kraft", b, 0.92, 0.9, 24, -36),
      g.deco("sticker", "sparkle", ox + 132, 40, 10),
      g.deco("sticker", "heart-kraft", ox + 17, 144, 12, { rotate: -12 }),
    ],
    texts: [
      g.plate("chapterTitle", "plate-label", ox + 12, 10, 72, "chapter", -2),
      g.plate("dateLabel", "plate-tag", ox + 92, 13, 42, "year", 3),
      captionText(caption),
    ],
    caption,
  };
}

/** Offset a point by (dx, dy) mm (keeps stickers clear of text). */
function pt([x, y]: [number, number], dx: number, dy: number): [number, number] {
  return [x + dx, y + dy];
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

/** Spread from a left and right half (rects already in spread units). */
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

export const scrapbookOnePolaroid = page("s-p-one-polaroid", "1 polaroid with label and caption", onePolaroid(), ["portrait"]);
export const scrapbookTwoOverlap = page("s-p-two-overlap", "2 overlapping polaroids with label", twoOverlap(), ["portrait", "portrait"]);
export const scrapbookTwoLandscape = page("s-p-two-land", "2 wide prints with label", twoLandscape(), ["landscape", "landscape"]);
export const scrapbookThreePile = page("s-p-three-pile", "1 wide + 2 tall polaroids, taped", threePile(), ["landscape", "portrait", "portrait"]);
export const scrapbookFourPinned = page("s-p-four-pinned", "4 taped prints with caption", fourPinned(), ["any", "any", "any", "any"]);
export const scrapbookFiveCollage = page("s-p-five-collage", "5 photo collage with caption", fiveCollage(), ["portrait", "any", "any", "any", "any"]);

// --- Spreads (x 0..200) --------------------------------------------------------------------------

/** Left: the hero polaroid with label, date and caption; right: a wide polaroid + two tall prints. */
export const scrapbookSpreadHero = spread(
  "s-p-spread-hero",
  "Hero polaroid + 3 taped photos across two pages",
  onePolaroid(),
  threePile(W, false),
  ["portrait", "landscape", "portrait", "portrait"],
  ["s-p-one-polaroid", "s-p-three-pile"],
);

/** Left: two overlapping polaroids with label, date and caption; right: four taped prints. */
export const scrapbookSpreadWall = spread(
  "s-p-spread-wall",
  "6 taped photos across two pages",
  twoOverlap(),
  fourPinned(W, false),
  ["portrait", "portrait", "any", "any", "any", "any"],
  ["s-p-two-overlap", "s-p-four-pinned"],
);

// --- Cover ---------------------------------------------------------------------------------------

const coverCard: CardMm = { x: 22, y: 16, w: 104, h: 124, rotate: -3, frame: { kind: "polaroid", side: 5, bottom: 18 }, shadow: "soft" };
const coverTitle = g.text("coverTitle", 12, 152, 124, 26, "title", "center");
const coverYear = g.text("coverSubtitle", 16, 180, 116, 10, "year", "center");

/** A big tilted polaroid with tape and the occasion accent; Bebas title + year below. */
export const scrapbookCoverPolaroid: Layout = {
  ...BASE,
  role: "cover",
  id: "s-p-cover-polaroid",
  name: "Cover: taped polaroid",
  photoCount: 1,
  prefers: ["any"],
  slots: [g.slot(coverCard)],
  caption: g.rect(12, 152, 124, 38),
  texts: [coverTitle, coverYear],
  decorations: [
    g.tape("tape-washi", coverCard, 0, -1, 40, -5),
    g.deco("sticker", "occasion-accent", ...pt(g.on(coverCard, 0.86, 0.86), -2, -4), 26, { rotate: 8 }),
    g.deco("sticker", "heart-kraft", ...g.on(coverCard, -0.98, 0.55), 15, { rotate: -14 }),
    g.deco("sticker", "sparkle", 17, 22, 11, { layer: "under" }),
    g.deco("sticker", "leaf-sprig", 136, 40, 13, { rotate: 18, layer: "under" }),
  ],
};

export const SCRAPBOOK_PORTRAIT_LAYOUTS: readonly Layout[] = [
  scrapbookCoverPolaroid,
  scrapbookOnePolaroid,
  scrapbookTwoOverlap,
  scrapbookTwoLandscape,
  scrapbookThreePile,
  scrapbookFourPinned,
  scrapbookFiveCollage,
  scrapbookSpreadHero,
  scrapbookSpreadWall,
];

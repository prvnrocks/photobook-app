// mm → layout-unit helpers for the scrapbook layouts (M10c T6). Pure: they only turn a design drawn
// in millimetres into the catalogue's plain data (% rects, decorations, text panels).
//
// Units: everything is designed in mm on the format's trim page (portrait 148 × 210, landscape
// 210 × 148). Spreads use the same mm with x running across both pages (0 .. 2 × page width, fold
// at the page width), which maps to the layout unit x 0..200.
//
// A "card" is a photo slot drawn as a physical print: top-left + size in mm, optional tilt, frame,
// shadow and paint order. `on(card, u, v)` gives a point on the card AFTER its tilt (u, v in -1..1,
// −1 = left/top edge), so tape and stickers can be stuck on a tilted photo's corners and edges.

import { pageMm, type SizeMm } from "@/lib/book/format";
import type { BookFormat, LayoutDecoration, LayoutSlotDef, LayoutText, Rect, SlotFrame, SlotShadow } from "@/lib/book/types";
import { OCCASION_ACCENT, stickerAspect, type StickerId } from "@/lib/design/stickers";

/** Photo-print paper (= scrapbook palette.frame). */
export const FRAME_PAPER = "#FBF8F1";

/** Polaroid cards: large (hero photos), medium, small. */
export const POLAROID_L: SlotFrame = { kind: "polaroid", side: 5, bottom: 16 };
export const POLAROID_M: SlotFrame = { kind: "polaroid", side: 4, bottom: 12 };
export const POLAROID_S: SlotFrame = { kind: "polaroid", side: 3.5, bottom: 10 };
/** Thin white print border. */
export const BORDER: SlotFrame = { kind: "border", mm: 2.5, hex: FRAME_PAPER };
export const BORDER_S: SlotFrame = { kind: "border", mm: 2, hex: FRAME_PAPER };

export interface CardMm {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  frame?: SlotFrame;
  shadow?: SlotShadow;
  z?: number;
}

type DecoKind = LayoutDecoration["kind"];
type DecoId = StickerId | typeof OCCASION_ACCENT;

export interface DecoOpts {
  rotate?: number;
  layer?: "under" | "over";
  tint?: string;
  /** Height in mm; default = width / the sticker's natural aspect (the accent: square). */
  h?: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const rad = (deg: number) => (deg * Math.PI) / 180;
/** Degrees into (−180, 180] (schema bound for decoration rotate). */
function normDeg(deg: number): number {
  const d = ((deg % 360) + 360) % 360; // 0..360
  return round(d > 180 ? d - 360 : d);
}

export interface ScrapGeo {
  page: SizeMm;
  rect(x: number, y: number, w: number, h: number): Rect;
  slot(c: CardMm): LayoutSlotDef;
  on(c: CardMm, u: number, v: number): [number, number];
  deco(kind: DecoKind, id: DecoId, cx: number, cy: number, w: number, opts?: DecoOpts): LayoutDecoration;
  /** Tape centred on point [x, y] of a card (after tilt), laid along the card's tilt + `turn`. */
  tape(id: StickerId, c: CardMm, u: number, v: number, w: number, turn?: number, tint?: string): LayoutDecoration;
  text(bind: LayoutText["bind"], x: number, y: number, w: number, h: number, font: LayoutText["font"], align: LayoutText["align"], rotate?: number): LayoutText;
  /**
   * A photo-corner set: four "photo-corner" stickers (artwork = top-left corner) holding the
   * card's corners, turned 0 / 90 / 180 / −90° plus the card's tilt. Each `size` mm square box
   * sits inside the card with its right angle on the card corner.
   */
  corners(c: CardMm, size: number, tint?: string): LayoutDecoration[];
  /** Label plate (aspect kept: h = w / plate aspect) with its bound text. */
  plate(bind: "chapterTitle" | "dateLabel", id: "plate-label" | "plate-tag", x: number, y: number, w: number, font: LayoutText["font"], rotate?: number, tint?: string): LayoutText;
}

export function scrapGeo(format: BookFormat): ScrapGeo {
  const page = pageMm(format);
  const px = (mm: number) => round((mm / page.w) * 100);
  const py = (mm: number) => round((mm / page.h) * 100);
  const rect = (x: number, y: number, w: number, h: number): Rect => {
    const rx = px(x);
    const ry = py(y);
    return { x: rx, y: ry, w: round(px(x + w) - rx), h: round(py(y + h) - ry) };
  };
  const on = (c: CardMm, u: number, v: number): [number, number] => {
    const t = rad(c.rotate ?? 0);
    const dx = (u * c.w) / 2;
    const dy = (v * c.h) / 2;
    return [c.x + c.w / 2 + dx * Math.cos(t) - dy * Math.sin(t), c.y + c.h / 2 + dx * Math.sin(t) + dy * Math.cos(t)];
  };
  const deco = (kind: DecoKind, id: DecoId, cx: number, cy: number, w: number, o: DecoOpts = {}): LayoutDecoration => {
    const h = o.h ?? (id === OCCASION_ACCENT ? w : w / stickerAspect(id));
    return {
      kind,
      id,
      box: rect(cx - w / 2, cy - h / 2, w, h),
      ...(o.rotate ? { rotate: o.rotate } : {}),
      layer: o.layer ?? "over",
      ...(o.tint ? { tint: o.tint } : {}),
    };
  };
  return {
    page,
    rect,
    on,
    deco,
    slot: (c) => ({
      ...rect(c.x, c.y, c.w, c.h),
      ...(c.rotate ? { rotate: c.rotate } : {}),
      ...(c.frame ? { frame: c.frame } : {}),
      ...(c.shadow ? { shadow: c.shadow } : {}),
      ...(c.z ? { z: c.z } : {}),
    }),
    tape: (id, c, u, v, w, turn = 0, tint) => {
      const [x, y] = on(c, u, v);
      return deco("tape", id, x, y, w, { rotate: round((c.rotate ?? 0) + turn), ...(tint ? { tint } : {}) });
    },
    corners: (c, size, tint) => {
      const du = size / c.w;
      const dv = size / c.h;
      const turns: Array<[number, number, number]> = [
        [-1 + du, -1 + dv, 0],
        [1 - du, -1 + dv, 90],
        [1 - du, 1 - dv, 180],
        [-1 + du, 1 - dv, -90],
      ];
      return turns.map(([u, v, turn]) => {
        const [x, y] = on(c, u, v);
        return deco("sticker", "photo-corner", x, y, size, { rotate: normDeg(turn + (c.rotate ?? 0)), ...(tint ? { tint } : {}) });
      });
    },
    text: (bind, x, y, w, h, font, align, rotate) => ({ bind, box: rect(x, y, w, h), align, font, ...(rotate ? { rotate } : {}) }),
    plate: (bind, id, x, y, w, font, rotate, tint) => ({
      bind,
      box: rect(x, y, w, w / stickerAspect(id)),
      align: "center",
      font,
      plate: { id, ...(tint ? { tint } : {}) },
      ...(rotate ? { rotate } : {}),
    }),
  };
}

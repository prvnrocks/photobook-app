// Book format geometry (M10a A2). Pure data + maths, no imports at runtime — layouts/index.ts
// re-exports these helpers, and bleed/resolution/render/pdf derive every mm size from them.
//
// A5 portrait = 148×210 mm trim page; A5 landscape = the same page turned (210×148 mm). The print
// sheet adds BLEED_MM (3 mm, D-050) on every side. Layout slots are % of the trim page of the
// doc's format, so the same maths serves both orientations.
//
// Unknown / missing format values fall back to portrait (every M1–M9 doc is portrait).

import type { BookFormat } from "./types";

export type FormatOrientation = "portrait" | "landscape";

export interface SizeMm {
  readonly w: number;
  readonly h: number;
}

export interface FormatGeometry {
  /** Trim page in mm. */
  readonly pageMm: SizeMm;
  /** Print sheet in mm = trim page + 3 mm bleed on every side. */
  readonly sheetMm: SizeMm;
  readonly orientation: FormatOrientation;
}

export const DEFAULT_FORMAT: BookFormat = "A5_PORTRAIT";

export const FORMAT_GEOMETRY: Readonly<Record<BookFormat, FormatGeometry>> = {
  A5_PORTRAIT: { pageMm: { w: 148, h: 210 }, sheetMm: { w: 154, h: 216 }, orientation: "portrait" },
  A5_LANDSCAPE: { pageMm: { w: 210, h: 148 }, sheetMm: { w: 216, h: 154 }, orientation: "landscape" },
};

const MM_TO_PT = 72 / 25.4;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Geometry of `format`; undefined / unknown values → portrait. */
export function formatGeometry(format?: BookFormat | null): FormatGeometry {
  return (
    (typeof format === "string" && Object.prototype.hasOwnProperty.call(FORMAT_GEOMETRY, format)
      ? FORMAT_GEOMETRY[format]
      : undefined) ?? FORMAT_GEOMETRY[DEFAULT_FORMAT]
  );
}

/** Trim page size in mm (portrait 148×210, landscape 210×148). */
export function pageMm(format?: BookFormat | null): SizeMm {
  return formatGeometry(format).pageMm;
}

/** Print sheet size in mm incl. bleed (portrait 154×216, landscape 216×154). */
export function sheetMm(format?: BookFormat | null): SizeMm {
  return formatGeometry(format).sheetMm;
}

/** Trim page aspect ratio, width ÷ height (portrait ≈ 0.705, landscape ≈ 1.419). */
export function aspect(format?: BookFormat | null): number {
  const p = pageMm(format);
  return p.w / p.h;
}

export function orientationOf(format?: BookFormat | null): FormatOrientation {
  return formatGeometry(format).orientation;
}

/** Print sheet in PDF points (mm × 72 / 25.4, 3 decimals): portrait 436.535 × 612.283. */
export function sheetPt(format?: BookFormat | null): SizeMm {
  const s = sheetMm(format);
  return { w: round3(s.w * MM_TO_PT), h: round3(s.h * MM_TO_PT) };
}

/** Trim page in PDF points: portrait 419.528 × 595.276. */
export function trimPt(format?: BookFormat | null): SizeMm {
  const p = pageMm(format);
  return { w: round3(p.w * MM_TO_PT), h: round3(p.h * MM_TO_PT) };
}

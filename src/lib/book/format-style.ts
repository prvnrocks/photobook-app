// CSS helpers for format-aware page boxes (M10a A3). Pure: no React runtime, only the type.
//
// Components keep their Tailwind `aspect-[148/210]` class (portrait, every M1–M9 doc) and add
// an inline `aspect-ratio` ONLY for non-portrait formats, so portrait markup stays byte-identical
// to the M9 goldens while landscape pages get the format's real ratio.

import type { CSSProperties } from "react";
import { pageMm } from "./format";
import type { BookFormat } from "./types";

/** CSS aspect-ratio value of the trim page, e.g. "210 / 148" for landscape. */
export function pageAspectRatio(format?: BookFormat | null): string {
  const p = pageMm(format);
  return `${p.w} / ${p.h}`;
}

/** True when the format's page is the 148×210 box the `aspect-[148/210]` class already draws. */
export function isClassAspect(format?: BookFormat | null): boolean {
  const p = pageMm(format);
  return p.w === 148 && p.h === 210;
}

/**
 * Inline style overriding the `aspect-[148/210]` class: undefined for A5 portrait (no style
 * attribute, markup unchanged), `{ aspectRatio }` for any other page size.
 */
export function pageAspectStyle(format?: BookFormat | null): CSSProperties | undefined {
  return isClassAspect(format) ? undefined : { aspectRatio: pageAspectRatio(format) };
}

/** `base` plus the format's aspect-ratio override (base unchanged — same object — for portrait). */
export function withPageAspect(base: CSSProperties, format?: BookFormat | null): CSSProperties {
  const a = pageAspectStyle(format);
  return a ? { ...base, ...a } : base;
}

// Print specifications (Task 10). A PrintSpec describes what ONE output target expects: trim size,
// bleed, safe margin, image resolution, colour handling, page-count rules and the cover geometry.
// Pure data, isomorphic, no imports at runtime.
//
// Honesty rules (do not relax without a real provider document in hand):
// - There is NO universal "print-ready" standard. Each spec is either our own digital PDF target
//   (kind "digital", numbers = what the renderer really produces today) or one print provider's
//   published requirements (kind "print_provider").
// - `providerVerified` is true ONLY after the numbers were copied from the provider's current
//   written specification AND a test file was accepted by that provider. No spec in this repo is
//   verified. Placeholder providers keep every unknown number `null` — never a guess.
// - UI copy never says "print-ready" or "certified"; it names the spec it checked against
//   ("Checks passed for digital A5 PDF").

import type { BookFormat } from "@/lib/book/types";

export type PrintSpecKind = "digital" | "print_provider";

export type PrintSpecTrim = { wMm: number; hMm: number };

export type PrintSpec = {
  /** Stable id, e.g. "generic-a5-digital". */
  id: string;
  kind: PrintSpecKind;
  /** Short plain label used in UI copy ("digital A5 PDF"). */
  label: string;
  /** Who defines the numbers (our renderer, or the provider's document + version / date). */
  source: string;
  /** True only when checked against the provider's written spec AND a provider-accepted proof. */
  providerVerified: boolean;
  /** Market the provider serves (null for the digital spec). */
  region: "UAE" | "IN" | null;
  /** Trim size per book format; null = unknown (provider not specified yet) or format unsupported. */
  trim: Readonly<Record<BookFormat, PrintSpecTrim | null>>;
  /** Bleed on every side (mm); null = unknown. */
  bleedMm: number | null;
  /** Minimum distance of text from the trim edge (mm); null = unknown. */
  safeMarginMm: number | null;
  /** Effective resolution the renderer aims for (px per inch at print size); null = unknown. */
  targetDpi: number | null;
  /** Below this effective resolution a photo is flagged (warning — never silently upscaled); null = unknown. */
  minEffectiveDpi: number | null;
  /** Colour handling as produced / required, in words (no ICC claim we cannot back). */
  colour: string;
  /** Fonts must be embedded (no Type3, no references to system fonts). */
  fontsEmbedded: boolean;
  /** Page-count rules for INTERIOR pages (the cover is separate). null = unknown. */
  pages: { min: number | null; max: number | null; multipleOf: number | null };
  /**
   * Cover geometry. "front_only" = one front cover sheet at trim + bleed (what we render today).
   * "wrap" = back + spine + front in one sheet; needs a spine formula from the provider.
   */
  cover: {
    layout: "front_only" | "wrap" | null;
    /** Spine width in mm for an interior page count, or null when the provider gave no formula. */
    spineWidthMm: ((interiorPages: number) => number) | null;
  };
  /** What is still missing before this spec can be used (empty when complete). */
  todo: readonly string[];
};

/** True when every number the readiness check needs is known for `format`. */
export function isSpecComplete(spec: PrintSpec, format: BookFormat): boolean {
  return (
    spec.trim[format] !== null &&
    spec.bleedMm !== null &&
    spec.safeMarginMm !== null &&
    spec.minEffectiveDpi !== null &&
    spec.pages.min !== null &&
    spec.pages.max !== null &&
    spec.pages.multipleOf !== null &&
    spec.cover.layout !== null
  );
}

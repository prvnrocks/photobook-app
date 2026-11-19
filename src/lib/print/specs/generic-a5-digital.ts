// The digital A5 PDF we render today (M8 / M10a / M10b, D-049 / D-050). Every number below is read
// from the renderer's own constants, so this spec cannot drift from what the PDF really contains:
// trim + bleed from src/lib/book/format.ts / src/lib/layouts (BLEED_MM, SAFE_MM), resolution from
// the print image plan (300 dpi target) and the editor's low-resolution warning (150 dpi).
//
// It is a DIGITAL target: a high-quality PDF with trim/bleed boxes that a printer could read. It is
// NOT a print provider's specification, and passing it does not mean any printer will accept the
// file (colour profile, spine, cover wrap and page-count rules are provider-specific).

import { LIMITS } from "@/lib/ai/limits";
import { pageMm } from "@/lib/book/format";
import { LOW_RES_DPI } from "@/lib/book/resolution";
import { BLEED_MM, SAFE_MM } from "@/lib/layouts";
import type { PrintSpec } from "./types";

/** Print copies are planned at this resolution (src/lib/pdf/image-plan.ts default). */
export const RENDER_TARGET_DPI = 300;

const portrait = pageMm("A5_PORTRAIT");
const landscape = pageMm("A5_LANDSCAPE");

export const GENERIC_A5_DIGITAL: PrintSpec = {
  id: "generic-a5-digital",
  kind: "digital",
  label: "digital A5 PDF",
  source: "This app's PDF renderer (src/lib/pdf, D-049 / D-050)",
  providerVerified: false,
  region: null,
  trim: {
    A5_PORTRAIT: { wMm: portrait.w, hMm: portrait.h },
    A5_LANDSCAPE: { wMm: landscape.w, hMm: landscape.h },
  },
  bleedMm: BLEED_MM,
  safeMarginMm: SAFE_MM,
  targetDpi: RENDER_TARGET_DPI,
  minEffectiveDpi: LOW_RES_DPI,
  colour: "RGB PDF; photos as sRGB baseline JPEG (EXIF stripped). No CMYK conversion and no output intent / ICC profile.",
  fontsEmbedded: true,
  // Interior pages: at least 1, at most the paid page limit (the book's own max_pages is checked too).
  pages: { min: 1, max: LIMITS.paid.maxPages, multipleOf: 1 },
  cover: { layout: "front_only", spineWidthMm: null },
  todo: [],
};

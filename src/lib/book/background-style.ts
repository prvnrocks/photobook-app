// CSS for the background layers of a page (M10a A6). Pure: no React runtime, only types.
//
// Print rules (A7 spike, .agentos/runs/m10.md): a texture tile is a CSS background-repeat at
// TEXTURE_TILE_MM → one tiling Pattern with the JPEG embedded once (325 dpi); a wash is a single
// image covering the sheet (150 dpi, DCT passthrough); the photo veil is an rgba fill (constant
// alpha, no group). NEVER a CSS `filter` — Chromium rasterises the whole subtree in the PDF
// (guard test: tests/book-backgrounds-render.test.tsx). A texture tint is a solid colour layer
// with mix-blend-mode: multiply (a vector fill with /BM /Multiply in the PDF; verified A6).

import type { CSSProperties } from "react";
import { isHexColor, TEXTURE_TILE_MM, textureSrc, type Texture } from "@/lib/design/backgrounds";
import { orientationOf, pageMm, sheetMm } from "./format";
import type { BookFormat } from "./types";
import { BLEED_MM } from "@/lib/layouts";

export type BackgroundTarget = "screen" | "print";

/** Up to 4 decimals, no trailing zeros (stable markup). */
function num(n: number): string {
  return String(Math.round(n * 10_000) / 10_000);
}

/**
 * The texture layer's style. Screen: the layer is the trim page (the frame is the `cqw` container),
 * tiles are TEXTURE_TILE_MM of the page width, washes are scaled so the full-sheet image shows its
 * trim area exactly as print does. Print: the layer is the whole bleed sheet in CSS mm; the tile
 * origin is offset by the bleed so tiles line up with the trim edge like on screen.
 */
export function textureLayerStyle(texture: Texture, format: BookFormat | null | undefined, target: BackgroundTarget): CSSProperties {
  const src = textureSrc(texture, orientationOf(format), target);
  const page = pageMm(format);
  if (texture.kind === "tile") {
    const tileMm = texture.tileMm ?? TEXTURE_TILE_MM;
    return {
      backgroundImage: `url("${src}")`,
      backgroundRepeat: "repeat",
      backgroundSize: target === "print" ? `${num(tileMm)}mm ${num(tileMm)}mm` : `${num((tileMm / page.w) * 100)}cqw auto`,
      backgroundPosition: target === "print" ? `${BLEED_MM}mm ${BLEED_MM}mm` : "0 0",
    };
  }
  const sheet = sheetMm(format);
  return {
    backgroundImage: `url("${src}")`,
    backgroundRepeat: "no-repeat",
    backgroundSize: target === "print" ? "cover" : `${num((sheet.w / page.w) * 100)}% ${num((sheet.h / page.h) * 100)}%`,
    backgroundPosition: "center",
  };
}

/** `rgba(r, g, b, a)` of a #RRGGBB colour (invalid hex → white). */
export function rgbaOf(hex: string, alpha: number): string {
  const h = isHexColor(hex) ? hex : "#FFFFFF";
  const n = parseInt(h.slice(1), 16);
  const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${num(a)})`;
}

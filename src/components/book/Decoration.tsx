// M10c T8b: layout decorations (stickers / tape / label plates) and the inline sticker artwork
// shared with label-plate text panels. Markup only — positions, tint, accent and corner turns come
// from the render model (src/lib/book/render.ts). Same markup in editor, flipbook and print.
//
// Print rules (A7): plain inline <svg> paths with flat / rgba paints (vector in the PDF); no CSS or
// SVG filter, no <image>, no <text>. Decorations never take pointer events (editor taps reach the
// photo underneath).

import type { CSSProperties } from "react";
import { rectStyle, type RenderDecoration, type RenderStickerArt } from "@/lib/book/render";

/** The artwork filling its (positioned) parent box. */
export function StickerArt({ art }: { art: RenderStickerArt }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute inset-0 block h-full w-full"
      viewBox={art.viewBox}
      preserveAspectRatio={art.preserveAspectRatio}
      data-sticker={art.stickerId}
    >
      {art.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill}
          fillRule={p.fillRule}
          stroke={p.stroke}
          strokeWidth={p.strokeWidth}
          strokeDasharray={p.strokeDasharray}
          strokeLinecap={p.strokeLinecap}
          strokeLinejoin={p.strokeLinejoin}
        />
      ))}
    </svg>
  );
}

/** CSS rotate about the box centre (transform-origin defaults to the centre). */
export function rotateStyle(deg: number | undefined): CSSProperties {
  return deg ? { transform: `rotate(${deg}deg)` } : {};
}

export function Decoration({ decoration: d }: { decoration: RenderDecoration }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{ ...rectStyle(d.rect), ...rotateStyle(d.rotate) }}
      data-decoration={d.kind}
      data-decoration-layer={d.layer}
    >
      <StickerArt art={d.art} />
    </div>
  );
}

/** Decorations of one layer, in layout order. */
export function Decorations({ items, layer }: { items: readonly RenderDecoration[] | undefined; layer: "under" | "over" }) {
  if (!items) return null;
  return (
    <>
      {items
        .filter((d) => d.layer === layer)
        .map((d, i) => (
          <Decoration key={`${layer}-${i}`} decoration={d} />
        ))}
    </>
  );
}

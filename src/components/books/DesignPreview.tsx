// Small schematic thumbnails for the New book form's Shape and Style choices (M10b A12).
// Deliberately NOT <BookPage>: these are simple original diagrams (decorative, aria-hidden), not a
// rendering of real layouts — the label next to each one carries the meaning.

import type { BookFormat } from "@/lib/book/types";
import type { FormDesignStyle } from "@/lib/design/defaults";
import { cn } from "@/lib/utils";

// Page boxes in a 64 × 64 viewBox, centred; ratio ≈ A5 (1 : 1.414).
const PAGE: Record<BookFormat, { x: number; y: number; w: number; h: number }> = {
  A5_PORTRAIT: { x: 16.5, y: 9.5, w: 31, h: 45 },
  A5_LANDSCAPE: { x: 9.5, y: 16.5, w: 45, h: 31 },
};

const photo = "fill-muted-foreground/35";
const page = "fill-background stroke-border";
const ink = "stroke-muted-foreground";

function Frame({ format, className, children }: { format: BookFormat; className?: string; children: React.ReactNode }) {
  const p = PAGE[format];
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={cn("size-16 shrink-0", className)}>
      <rect x={p.x + 1.2} y={p.y + 1.2} width={p.w} height={p.h} rx="1.5" className="fill-foreground/10" />
      <rect x={p.x} y={p.y} width={p.w} height={p.h} rx="1.5" strokeWidth="1" className={page} />
      {children}
    </svg>
  );
}

/** Shape choice: an empty page of that shape with one photo block. */
export function ShapePreview({ format }: { format: BookFormat }) {
  const p = PAGE[format];
  const m = 4;
  return (
    <Frame format={format}>
      <rect x={p.x + m} y={p.y + m} width={p.w - 2 * m} height={p.h * 0.62 - m} rx="0.8" className={photo} />
      <line x1={p.x + m} x2={p.x + p.w * 0.6} y1={p.y + p.h * 0.78} y2={p.y + p.h * 0.78} strokeWidth="1.4" strokeLinecap="round" className={ink} />
    </Frame>
  );
}

/**
 * Style choice in the currently chosen shape.
 * modern  = edge-to-edge grid with thin gutters + a script title flourish.
 * classic = one framed photo (mat + hairline) + a centred caption line.
 */
export function StylePreview({ style, format }: { style: FormDesignStyle; format: BookFormat }) {
  const p = PAGE[format];
  if (style === "modern") {
    const g = 1; // thin gutter
    const top = p.h * 0.7;
    const half = (p.w - g) / 2;
    const titleY = p.y + top + (p.h - top) / 2;
    return (
      <Frame format={format}>
        <rect x={p.x} y={p.y} width={half} height={top} className={photo} />
        <rect x={p.x + half + g} y={p.y} width={half} height={(top - g) / 2} className={photo} />
        <rect x={p.x + half + g} y={p.y + (top + g) / 2} width={half} height={(top - g) / 2} className={photo} />
        {/* script title: a looping flourish */}
        <path
          d={`M ${p.x + p.w * 0.22} ${titleY + 1.5} c 2 -5 4 -5 3 0 s 2 4 4 -1 s 3 -3 4 1 s 3 2 5 -2`}
          fill="none"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={ink}
        />
      </Frame>
    );
  }
  const mat = Math.min(p.w, p.h) * 0.16;
  const fw = p.w - 2 * mat;
  const fh = p.h * 0.62 - mat;
  const capY = p.y + mat + fh + (p.h - mat - fh) / 2;
  return (
    <Frame format={format}>
      <rect x={p.x + mat - 1.5} y={p.y + mat - 1.5} width={fw + 3} height={fh + 3} fill="none" strokeWidth="0.6" className={ink} />
      <rect x={p.x + mat} y={p.y + mat} width={fw} height={fh} className={photo} />
      <line x1={p.x + p.w * 0.3} x2={p.x + p.w * 0.7} y1={capY} y2={capY} strokeWidth="1.2" strokeLinecap="round" className={ink} />
    </Frame>
  );
}

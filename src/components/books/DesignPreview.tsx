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
 * modern    = edge-to-edge grid with thin gutters + a script title flourish.
 * classic   = one framed photo (mat + hairline) + a centred caption line.
 * geometric = a full-bleed band with a diagonal edge, a circle cut into it, a hexagon (g-*-two-circle,
 *             g-*-five-hex).
 * scrapbook = a tilted polaroid with a strip of tape and a small heart (s-*-one-polaroid).
 */
export function StylePreview({ style, format }: { style: FormDesignStyle; format: BookFormat }) {
  if (style === "modern") return <ModernPreview format={format} />;
  if (style === "geometric") return <GeometricPreview format={format} />;
  if (style === "scrapbook") return <ScrapbookPreview format={format} />;
  return <ClassicPreview format={format} />;
}

function ModernPreview({ format }: { format: BookFormat }) {
  const p = PAGE[format];
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

function ClassicPreview({ format }: { format: BookFormat }) {
  const p = PAGE[format];
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

const r1 = (n: number) => Math.round(n * 10) / 10;

function hexagon(cx: number, cy: number, r: number): string {
  // Flat-top hexagon, as in the five-hex layouts.
  return [0, 60, 120, 180, 240, 300]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `${r1(cx + r * Math.cos(a))},${r1(cy + r * Math.sin(a))}`;
    })
    .join(" ");
}

function GeometricPreview({ format }: { format: BookFormat }) {
  const p = PAGE[format];
  const m = Math.min(p.w, p.h);
  // Band: full bleed at the top, bottom edge slopes down to the left.
  const yL = p.y + p.h * 0.6;
  const yR = p.y + p.h * 0.44;
  const band = [
    `${p.x},${p.y}`,
    `${p.x + p.w},${p.y}`,
    `${p.x + p.w},${r1(yR)}`,
    `${p.x},${r1(yL)}`,
  ].join(" ");
  const cr = m * 0.2;
  const cx = p.x + p.w * 0.7;
  const cy = p.y + p.h * 0.56;
  const hr = m * 0.12;
  const hx = p.x + hr + m * 0.12;
  const hy = p.y + p.h - hr - m * 0.14;
  const capY = hy; // landscape: the line stops before the circle
  return (
    <Frame format={format}>
      <polygon points={band} className={photo} />
      <circle cx={r1(cx)} cy={r1(cy)} r={r1(cr)} strokeWidth="1.2" className={cn(photo, "stroke-background")} />
      <polygon points={hexagon(hx, hy, hr)} className={photo} />
      <line
        x1={r1(hx + hr + m * 0.12)}
        x2={r1(Math.min(p.x + p.w - m * 0.14, hx + hr + m * 0.12 + p.w * 0.32, format === "A5_LANDSCAPE" ? cx - cr - 1.5 : Infinity))}
        y1={r1(capY)}
        y2={r1(capY)}
        strokeWidth="1.2"
        strokeLinecap="round"
        className={ink}
      />
    </Frame>
  );
}

function ScrapbookPreview({ format }: { format: BookFormat }) {
  const p = PAGE[format];
  const landscape = format === "A5_LANDSCAPE";
  // Polaroid card: portrait-ish, white border, wider bottom lip; tilted like s-*-one-polaroid.
  const cw = Math.min(p.w, p.h) * (landscape ? 0.56 : 0.64);
  const ch = cw * 1.18;
  const cx = landscape ? p.x + p.w * 0.36 : p.x + p.w / 2;
  const cy = landscape ? p.y + p.h / 2 : p.y + p.h * 0.4;
  const x = cx - cw / 2;
  const y = cy - ch / 2;
  const inset = cw * 0.09;
  const tapeW = cw * 0.5;
  const tapeH = 2.4;
  const capX1 = landscape ? p.x + p.w * 0.66 : p.x + p.w * 0.3;
  const capX2 = landscape ? p.x + p.w * 0.88 : p.x + p.w * 0.7;
  const capY = landscape ? p.y + p.h * 0.7 : p.y + p.h * 0.84;
  // Heart sticker, top-right of the card (as on s-p-one-polaroid).
  const hx = landscape ? p.x + p.w * 0.77 : x + cw + 0.6;
  const hy = landscape ? p.y + p.h * 0.36 : y + 2.4;
  return (
    <Frame format={format}>
      <g transform={`rotate(-5 ${r1(cx)} ${r1(cy)})`}>
        {/* crisp drawn shadow (no blur), like the real render */}
        <rect x={r1(x + 0.9)} y={r1(y + 1.1)} width={r1(cw)} height={r1(ch)} className="fill-foreground/15" />
        <rect x={r1(x)} y={r1(y)} width={r1(cw)} height={r1(ch)} strokeWidth="0.5" className="fill-background stroke-border" />
        <rect x={r1(x + inset)} y={r1(y + inset)} width={r1(cw - 2 * inset)} height={r1(ch - inset - cw * 0.26)} className={photo} />
      </g>
      <rect
        x={r1(cx - tapeW / 2)}
        y={r1(y - tapeH / 2)}
        width={r1(tapeW)}
        height={tapeH}
        transform={`rotate(3 ${r1(cx)} ${r1(y)})`}
        className="fill-warning-border/80"
      />
      <path
        d={`M ${r1(hx)} ${r1(hy + 2.2)} c -2.6 -1.6 -3 -3.6 -1.6 -4.3 c 0.8 -0.4 1.4 0 1.6 0.6 c 0.2 -0.6 0.8 -1 1.6 -0.6 c 1.4 0.7 1 2.7 -1.6 4.3 z`}
        className="fill-accent-strong/80"
      />
      <line x1={r1(capX1)} x2={r1(capX2)} y1={r1(capY)} y2={r1(capY)} strokeWidth="1.2" strokeLinecap="round" className={ink} />
    </Frame>
  );
}

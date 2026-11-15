// Live book preview for the creation wizard, steps 1–4 (M20 T4, D-072). A decorative CSS + SVG book
// driven by the draft: the title appears on the emerald leather cover as it is typed (dir="auto",
// Arabic script → the Arabic font), the occasion's small gold emblem pops in when it changes, the
// book morphs between portrait and landscape when the shape changes, and on step 4 the cover swings
// open (a real 3D page turn) to a spread drawn in the chosen style; the style also tints the stage.
// Idle: a slow float. All motion lives in steps-motion.css under prefers-reduced-motion:
// no-preference — reduced motion shows the same final states, static.
// Sizes are in em: the stage's font-size sets the scale ("full" fits its column via container query
// units; "md"/"sm" are the phone mini previews). The stage reserves its height for every state, so
// nothing below shifts when the book opens or turns.
// Client-safe, one hook (useId for SVG gradient ids — two instances share a page), no cn/next/link.
// Deliberately NOT <BookPage>: an illustration of the choices, not a rendering of the album.

import { useId } from "react";
import { StylePreview } from "@/components/books/DesignPreview";
import { OCCASION_LABELS, type Occasion } from "@/lib/book/options";
import type { WizardFormat } from "@/lib/books/wizard-steps";
import { DESIGN_STYLE_LABELS, FORMAT_SHORT_LABELS, type FormDesignStyle } from "@/lib/design/defaults";
import "./steps-motion.css";

/** Arabic, Arabic Supplement / Extended, presentation forms. */
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function isArabicTitle(title: string): boolean {
  return ARABIC_SCRIPT.test(title);
}

export const PREVIEW_TITLE_PLACEHOLDER = "Your book";

export type WizardBookPreviewSize = "full" | "md" | "sm";

export type WizardBookPreviewProps = {
  title: string;
  occasion: Occasion | null;
  /** null (shape not chosen yet) draws a portrait book. */
  format: WizardFormat | null;
  /** Tints the stage and draws the open spread. null = no style picked yet (no tint). */
  designStyle: FormDesignStyle | null;
  /** Open to a spread (step 4). Needs a designStyle to draw; closed without one. */
  open?: boolean;
  /** Blinking caret after the cover title (step 1, while typing). */
  typing?: boolean;
  size?: WizardBookPreviewSize;
  className?: string;
};

export function WizardBookPreview({
  title,
  occasion,
  format,
  designStyle,
  open = false,
  typing = false,
  size = "full",
  className,
}: WizardBookPreviewProps) {
  const fmt: WizardFormat = format ?? "A5_PORTRAIT";
  const isOpen = open && designStyle !== null;
  const shown = title.trim();
  const arabic = isArabicTitle(shown);
  return (
    <div
      aria-hidden="true"
      className={["wbp-frame", className].filter(Boolean).join(" ")}
      data-testid="wizard-preview"
      data-size={size}
      data-format={fmt}
      data-occasion={occasion ?? ""}
      data-style={designStyle ?? ""}
      data-open={isOpen ? "true" : "false"}
    >
      <div className="wbp" data-size={size} data-format={fmt} data-style={designStyle ?? ""} data-open={isOpen ? "true" : undefined}>
        <span className="wbp-glow" />
        <span className="wbp-shadow" />
        <div className="wbp-float">
          <div className="wbp-morph">
            <div className="wbp-tilt">
              <div className="wbp-book">
                <div className="wbp-page wbp-page-right">
                  {designStyle ? <SpreadPage style={designStyle} format={fmt} mirrored /> : null}
                </div>
                <div className="wbp-cover">
                  <div className="wbp-face wbp-front">
                    <CoverFront title={shown} arabic={arabic} occasion={occasion} typing={typing} titleTestId="wizard-preview-title" />
                  </div>
                  <div className="wbp-face wbp-back wbp-page">
                    {designStyle ? <SpreadPage style={designStyle} format={fmt} /> : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpreadPage({ style, format, mirrored = false }: { style: FormDesignStyle; format: WizardFormat; mirrored?: boolean }) {
  return (
    <span className={mirrored ? "wbp-art wbp-art-mirror" : "wbp-art"}>
      <StylePreview style={style} format={format} variant="card" className="h-full w-full" />
    </span>
  );
}

/** The emerald leather cover: gold foil frame, title, a photo window and the occasion medallion. */
export function CoverFront({
  title,
  arabic,
  occasion,
  typing = false,
  titleTestId,
}: {
  title: string;
  arabic: boolean;
  occasion: Occasion | null;
  typing?: boolean;
  /** Only the live preview tags its title (the step-3 shape books reuse this cover). */
  titleTestId?: string;
}) {
  return (
    <span className="wbp-cover-inner home-leather">
      <span className="wbp-spine" />
      <span className="wbp-foil-frame" />
      <span
        className={`wbp-title ${arabic ? "font-arabic" : "font-display"}`}
        data-testid={titleTestId}
        data-placeholder={title ? undefined : ""}
      >
        <span dir="auto">{title || PREVIEW_TITLE_PLACEHOLDER}</span>
        {typing ? <span className="wbp-caret" /> : null}
      </span>
      <SeaWindow />
      <span className="wbp-medallion">
        {occasion ? (
          // Keyed: a new occasion remounts the emblem, which replays its pop-in.
          <span key={occasion} className="wbp-emblem" data-testid={titleTestId ? "wizard-preview-emblem" : undefined} data-emblem={occasion}>
            <OccasionEmblem occasion={occasion} />
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** Small original gold line emblems, one per occasion (24 × 24, stroke = currentColor). */
const EMBLEMS: Record<Occasion, React.ReactNode> = {
  // two interlocking rings with a small stone
  wedding: (
    <>
      <circle cx="9.3" cy="14.2" r="5.3" />
      <circle cx="14.7" cy="14.2" r="5.3" />
      <path d="M7.4 6.6 9.3 4.4l1.9 2.2-1.9 2.1Z" />
    </>
  ),
  // paper plane
  travel: (
    <>
      <path d="M3 12.6 20.8 5.4l-5.6 14.2-3.6-5.4Z" />
      <path d="m11.6 14.2 9.2-8.8" />
    </>
  ),
  // rattle
  baby: (
    <>
      <circle cx="9.2" cy="9.2" r="5.2" />
      <path d="M8 7.5h.01M10.6 9.4h.01M8.4 11h.01" />
      <path d="m12.9 12.9 5.2 5.2" />
      <circle cx="19.3" cy="19.3" r="1.7" />
    </>
  ),
  // mortarboard with tassel
  graduation: (
    <>
      <path d="M2.5 9.6 12 5.3l9.5 4.3-9.5 4.3Z" />
      <path d="M6.3 11.4v4.3c0 1.4 2.6 2.9 5.7 2.9s5.7-1.5 5.7-2.9v-4.3" />
      <path d="M20.2 10.4v5.1" />
    </>
  ),
  // house with a door
  family: (
    <>
      <path d="M3.8 11.2 12 4.6l8.2 6.6" />
      <path d="M6 9.8v9.7h12V9.8" />
      <path d="M10.4 19.5v-4.6h3.2v4.6" />
    </>
  ),
  // four-point sparkle + a small one
  other: (
    <>
      <path d="M11 3.5c.7 4.6 3 6.9 7.6 7.6-4.6.7-6.9 3-7.6 7.6-.7-4.6-3-6.9-7.6-7.6 4.6-.7 6.9-3 7.6-7.6Z" />
      <path d="M19 16.2c.3 1.6 1 2.3 2.6 2.6-1.6.3-2.3 1-2.6 2.6-.3-1.6-1-2.3-2.6-2.6 1.6-.3 2.3-1 2.6-2.6Z" />
    </>
  ),
};

export function OccasionEmblem({ occasion }: { occasion: Occasion }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden="true"
      className="h-full w-full"
    >
      {EMBLEMS[occasion]}
    </svg>
  );
}

/** Original seaside scene (sky, sun, hills, sea, a white house with a dome); fills its box (slice). */
export function SeaWindow() {
  const id = useId().replace(/:/g, "");
  const sky = `wbp-sky-${id}`;
  const sea = `wbp-sea-${id}`;
  return (
    <svg viewBox="0 0 120 84" preserveAspectRatio="xMidYMid slice" className="wbp-window" focusable="false" aria-hidden="true">
      <defs>
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6e7c8" />
          <stop offset="1" stopColor="#cfe3e6" />
        </linearGradient>
        <linearGradient id={sea} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f7f8f" />
          <stop offset="1" stopColor="#1f5f6b" />
        </linearGradient>
      </defs>
      <rect width="120" height="84" fill={`url(#${sky})`} />
      <circle cx="92" cy="22" r="8" fill="#e8c46a" opacity="0.9" />
      <path d="M0 50 C18 38 34 40 52 46 C70 52 88 36 120 42 V60 H0 Z" fill="#9db58d" />
      <rect y="56" width="120" height="28" fill={`url(#${sea})`} />
      <path d="M8 66 h14 M40 72 h18 M78 64 h12 M96 74 h14" stroke="#cfe8ea" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
      <rect x="22" y="40" width="20" height="16" fill="#fffdf8" />
      <path d="M26 40 a6 6 0 0 1 12 0 Z" fill="#2c6fa3" />
      <rect x="29" y="47" width="5" height="9" fill="#2c6fa3" opacity="0.8" />
      <rect x="44" y="45" width="12" height="11" fill="#fffdf8" />
      <rect x="47" y="48" width="3" height="3" fill="#2c6fa3" opacity="0.7" />
      <circle cx="18" cy="52" r="4" fill="#c2457a" />
      <circle cx="14" cy="49" r="3" fill="#d4588c" />
      <circle cx="20" cy="47" r="2.5" fill="#b83a6e" />
    </svg>
  );
}

export type WizardPreviewAsideProps = Omit<WizardBookPreviewProps, "size" | "className">;

/**
 * The ≥ lg aside: the full-size preview on an ivory "product photo" stage, and a "So far" list of the
 * answers (title / purpose / shape / style) that fills in as the user goes.
 */
export function WizardPreviewAside(props: WizardPreviewAsideProps) {
  const { title, occasion, format, designStyle } = props;
  const t = title.trim();
  const rows: { key: string; label: string; value: string | null; dirAuto?: boolean }[] = [
    { key: "title", label: "Title", value: t || null, dirAuto: true },
    { key: "occasion", label: "Purpose", value: occasion ? OCCASION_LABELS[occasion] : null },
    { key: "format", label: "Shape", value: format ? FORMAT_SHORT_LABELS[format] : null },
    { key: "style", label: "Style", value: designStyle ? DESIGN_STYLE_LABELS[designStyle] : null },
  ];
  return (
    <div className="flex flex-col gap-5" data-testid="wizard-preview-aside">
      <div className="wbp-panel relative overflow-hidden rounded-[1.75rem] border border-border/70 bg-[radial-gradient(120%_85%_at_50%_22%,#fdfaf3_0%,#f3ecdd_58%,#e9dfca_100%)] px-4 pt-5 pb-3 shadow-card">
        <p className="relative z-10 flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.24em] text-accent-text uppercase">
          <span className="wbp-live-dot inline-block size-2 rounded-full bg-success" aria-hidden="true" />
          Live preview
        </p>
        <WizardBookPreview {...props} size="full" />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-1" data-testid="wizard-preview-summary">
        {rows.map((r) => (
          <div key={r.key} className="min-w-0" data-filled={r.value ? "" : undefined}>
            <dt className="text-xs font-medium text-muted-foreground">{r.label}</dt>
            <dd className={`truncate text-sm font-medium ${r.value ? "text-foreground" : "text-muted-foreground"}`}>
              {r.value ? r.dirAuto ? <span dir="auto">{r.value}</span> : r.value : "—"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

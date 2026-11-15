// Last flipbook page (back cover). No hooks: rendered inside page-flip's static page nodes.
// Links/buttons must contain text only — page-flip's clickEventForward only lets taps through when
// the event target itself is an <a>/<button>. Sizes in cqw of the outer box so it scales with the
// page; buttons also keep a 44 px minimum tap height.
// Paid (D-054): "The end", the snapshot title (dir="auto"), Replay + Share, small "Made with" link,
// on the book's page background. Free: the "Make your own photobook" CTA.
// M23 (D-075): the free end is a cream card in the emerald style — antique-gold "Made with" eyebrow
// (#7a5f0e on ivory 5.57:1), emerald serif heading, ink-soft body, the screen's one gold action
// (foil fill, ink text) — sized in cqw. Paid keeps the book background; on a light background its
// Share button is emerald (white on #0e3b2e 12.47:1). Only opacity animates (vw-card-in): nothing
// in a page-flip page may translate or scale.

import { pageAspectStyle } from "@/lib/book/format-style";
import type { BookFormat } from "@/lib/book/types";
import { APP_NAME, MADE_WITH } from "@/lib/brand";
import { END_CARD_HEADING, type EndCardModel } from "@/lib/viewer/end-card";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";

export type EndCardProps = {
  isPaid: boolean;
  /** Paid card content (endCardModel). Without it the paid card falls back to a plain white page. */
  model?: EndCardModel;
  /** Flip back to the cover. */
  onReplay?: () => void;
  /** Open the share sheet. */
  onShare?: () => void;
  /** doc.format: the card takes the book's page shape (missing → A5 portrait). */
  format?: BookFormat | null;
};

const BTN =
  "inline-flex min-h-11 min-w-[28cqw] items-center justify-center rounded-full px-[6cqw] py-[2.6cqw] text-[4.2cqw] font-medium transition-opacity hover:opacity-85";

export function EndCard({ isPaid, model, onReplay, onShare, format }: EndCardProps) {
  return (
    <div
      className="relative aspect-[148/210] w-full overflow-hidden [container-type:inline-size]"
      style={pageAspectStyle(format)}
      data-testid="end-card"
      data-paid={String(isPaid)}
    >
      {isPaid ? <PaidEnd model={model} onReplay={onReplay} onShare={onShare} /> : <FreeEnd landscape={format === "A5_LANDSCAPE"} />}
    </div>
  );
}

function PaidEnd({ model, onReplay, onShare }: Omit<EndCardProps, "isPaid" | "format">) {
  const dark = model?.dark ?? false;
  const ink = dark ? "text-white" : "text-neutral-900";
  const muted = dark ? "text-white/70" : "text-neutral-500";
  const rule = dark ? "bg-white/40" : "bg-neutral-900/25";
  const outline = dark ? "border border-white/60 text-white" : "border border-neutral-900/30 text-neutral-900";
  const solid = dark ? "bg-white text-neutral-900" : "bg-[#0e3b2e] text-white hover:bg-[#145240]";
  return (
    <div
      className={`absolute inset-0 flex flex-col items-center px-[10cqw] pt-[10cqw] pb-[6cqw] text-center ${ink}`}
      style={{ background: model?.background ?? "#FFFFFF" }}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-[5cqw]">
        <span aria-hidden className={`block h-px w-[14cqw] ${rule}`} />
        <h2
          className="text-[11cqw] leading-none font-semibold"
          style={model ? { fontFamily: model.headingFontFamily } : undefined}
          data-testid="end-card-heading"
        >
          {END_CARD_HEADING}
        </h2>
        {model?.title ? (
          <p
            dir="auto"
            lang={model.titleLang}
            className={`line-clamp-3 w-full text-[5.2cqw] leading-snug break-words ${muted}`}
            style={{ fontFamily: model.titleFontFamily }}
            data-testid="end-card-title"
          >
            {model.title}
          </p>
        ) : null}
        <span aria-hidden className={`block h-px w-[14cqw] ${rule}`} />
        <div className="mt-[3cqw] flex flex-wrap items-center justify-center gap-[3.5cqw]">
          {onReplay ? (
            <button type="button" onClick={onReplay} className={`${BTN} ${outline}`} data-testid="end-card-replay">
              Replay
            </button>
          ) : null}
          {onShare ? (
            <button type="button" onClick={onShare} className={`${BTN} ${solid}`} data-testid="end-card-share">
              Share
            </button>
          ) : null}
        </div>
      </div>
      <a
        href={CREATE_YOURS_HREF}
        className={`inline-flex min-h-11 items-center text-[3.4cqw] underline-offset-2 hover:underline ${muted}`}
        data-testid="end-card-made-with"
      >
        {MADE_WITH}
      </a>
    </div>
  );
}

// Free end card recipes (cqw versions of VW_MESSAGE_EYEBROW / _HEADING / _BODY / VW_CTA_GOLD). The
// landscape page is only 148/210 as tall, so it gets a complete compact set (full alternatives: cx
// doesn't merge conflicting utilities) — the portrait sizes would overflow it.
const FREE = {
  portrait: {
    frame: "absolute inset-0 flex items-center justify-center bg-[#ede4d2] p-[7cqw]",
    card: "vw-card-in flex w-full flex-col items-center gap-[4.5cqw] rounded-[5cqw] bg-[#faf5ec] px-[8cqw] py-[10cqw] text-center ring-1 ring-[#e3c766]/45",
    eyebrow: "text-[3.2cqw] font-semibold tracking-[0.24em] text-[#7a5f0e] uppercase",
    heading: "font-display text-[8cqw] leading-tight font-semibold text-[#0e3b2e]",
    body: "text-[4.2cqw] leading-relaxed text-[#4a4740]",
    cta: "mt-[2cqw] px-[7cqw] py-[3cqw] text-[4.4cqw]",
  },
  landscape: {
    frame: "absolute inset-0 flex items-center justify-center bg-[#ede4d2] p-[4cqw]",
    card: "vw-card-in flex w-full flex-col items-center gap-[2.5cqw] rounded-[3.5cqw] bg-[#faf5ec] px-[7cqw] py-[5cqw] text-center ring-1 ring-[#e3c766]/45",
    eyebrow: "text-[2.4cqw] font-semibold tracking-[0.24em] text-[#7a5f0e] uppercase",
    heading: "font-display text-[5.6cqw] leading-tight font-semibold text-[#0e3b2e]",
    body: "max-w-[60cqw] text-[3cqw] leading-snug text-[#4a4740]",
    cta: "mt-[1cqw] px-[6cqw] py-[2cqw] text-[3.2cqw]",
  },
} as const;
/** The gold action's look (VW_CTA_GOLD); size classes come from FREE[shape].cta. Text only inside. */
const FREE_CTA =
  "home-foil-fill inline-flex min-h-11 items-center justify-center rounded-full font-brand font-semibold text-[#1b1b1d] shadow-[0_10px_22px_-14px_rgb(0_0_0/0.7),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#faf5ec] active:brightness-95 motion-reduce:transition-none";

function FreeEnd({ landscape }: { landscape: boolean }) {
  const r = landscape ? FREE.landscape : FREE.portrait;
  return (
    <div className={r.frame}>
      <div className={r.card}>
        <span aria-hidden className="home-foil-h block h-px w-[14cqw]" />
        <p className={r.eyebrow}>{MADE_WITH}</p>
        <h2 className={r.heading}>Make your own photobook</h2>
        <p className={r.body}>Upload your photos and {APP_NAME} lays them out for you in minutes.</p>
        <a href={CREATE_YOURS_HREF} data-testid="end-card-cta" className={`${FREE_CTA} ${r.cta}`}>
          Create yours
        </a>
      </div>
    </div>
  );
}

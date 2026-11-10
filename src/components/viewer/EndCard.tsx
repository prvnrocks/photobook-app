// Last flipbook page (back cover). No hooks: rendered inside page-flip's static page nodes.
// Links/buttons must contain text only — page-flip's clickEventForward only lets taps through when
// the event target itself is an <a>/<button>. Sizes in cqw of the outer box so it scales with the
// page; buttons also keep a 44 px minimum tap height.
// Paid (D-054): "The end", the snapshot title (dir="auto"), Replay + Share, small "Made with" link,
// on the book's page background. Free: the "Make your own photobook" CTA.

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
      {isPaid ? <PaidEnd model={model} onReplay={onReplay} onShare={onShare} /> : <FreeEnd />}
    </div>
  );
}

function PaidEnd({ model, onReplay, onShare }: Omit<EndCardProps, "isPaid" | "format">) {
  const dark = model?.dark ?? false;
  const ink = dark ? "text-white" : "text-neutral-900";
  const muted = dark ? "text-white/70" : "text-neutral-500";
  const rule = dark ? "bg-white/40" : "bg-neutral-900/25";
  const outline = dark ? "border border-white/60 text-white" : "border border-neutral-900/30 text-neutral-900";
  const solid = dark ? "bg-white text-neutral-900" : "bg-neutral-900 text-white";
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

function FreeEnd() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[5cqw] bg-neutral-50 p-[10cqw] text-center">
      <p className="text-[3.6cqw] font-medium tracking-wide text-neutral-500 uppercase">{MADE_WITH}</p>
      <h2 className="text-[8cqw] leading-tight font-semibold text-neutral-900">Make your own photobook</h2>
      <p className="text-[4.2cqw] text-neutral-600">
        Upload your photos and {APP_NAME} lays them out for you in minutes.
      </p>
      <a
        href={CREATE_YOURS_HREF}
        data-testid="end-card-cta"
        className="mt-[2cqw] inline-block rounded-full bg-neutral-900 px-[7cqw] py-[3cqw] text-[4.4cqw] font-medium text-white"
      >
        Create yours
      </a>
    </div>
  );
}

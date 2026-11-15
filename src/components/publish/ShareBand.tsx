// Share page band (M21 T2): the wizard / My books emerald leather (WizardBand, LibraryHeader) —
// "Back to editor" (a link the page passes in; testid publish-back), gold small-caps eyebrow "SHARE"
// over a foil hairline, the book title in the cream serif (user text → <span dir="auto">, testid
// publish-title, nothing else inside so toHaveText stays exact), the status chip, and the 3-step mini
// progress Photos ✓ · Your book ✓ · Share (FLOW_STEPS), drawn like the wizard stepper.
// Hook-free, no cn/buttonVariants/next/link (links arrive as props): usable from the server page and
// inside first-load client islands. Foil rules at the sides and foot, as on the books screen.
// Contrast on the leather's lightest point #1f5443: cream 7.19, cream-muted #d7cdb9 5.53, pale gold
// #e3c766 5.25; chip tones in share-page-classes.ts (all ≥ 7.4 on their chip, ≥ 5.5 on the leather).

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cx } from "@/lib/cx";
import { FLOW_STEPS } from "@/lib/app/flow-steps";
import { LIBRARY_CONTAINER } from "@/components/dashboard/library-classes";
import { SHARE_CHIP_BASE, SHARE_CHIP_DOT, SHARE_CHIP_TONE, type ShareChipKind } from "./share-page-classes";

export const SHARE_TITLE_FALLBACK = "Your book";

export type ShareChip = {
  /** Visible chip text, e.g. "Draft", "Live · 21 days left", "Expired", "Paid · Permanent". */
  text: string;
  kind: ShareChipKind;
};

export type ShareBandProps = {
  /** The book title (user text). Blank → "Your book". */
  title: string | null | undefined;
  /** Status chip; omitted → no chip. */
  chip?: ShareChip | null;
  /**
   * The "Back to editor" link, rendered by the page (next/link) with data-testid="publish-back" and
   * className SHARE_BACK_LINK from share-page-classes.ts.
   */
  back?: ReactNode;
  /** Small caps line above the title. */
  eyebrow?: string;
  /** The title element: h1 when the band is the page heading (default), p otherwise. */
  titleAs?: "h1" | "p";
  className?: string;
};

export function ShareBand({ title, chip, back, eyebrow = "Share", titleAs = "h1", className }: ShareBandProps) {
  const t = (title ?? "").trim();
  const Title = titleAs;
  return (
    <section
      aria-label="Share your book"
      className={cx("home-leather relative isolate overflow-hidden text-[#f2e8d8]", className)}
      data-testid="share-band"
    >
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 start-2 -z-10 w-px opacity-70 sm:start-4 lg:start-6" />
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 end-2 -z-10 w-px opacity-70 sm:end-4 lg:end-6" />
      <div className={cx(LIBRARY_CONTAINER, "pt-2 pb-4 sm:pt-4 sm:pb-7 lg:pb-8")}>
        {back ? <div className="flex min-h-11 items-center">{back}</div> : <div className="h-3 sm:h-4" />}
        <p className="mt-1 flex items-center gap-3 text-[0.7rem] font-semibold tracking-[0.28em] text-[#e3c766] uppercase sm:mt-2 sm:text-xs">
          <span>{eyebrow}</span>
          <span aria-hidden="true" className="home-foil-h block h-px w-10 sm:w-14" />
        </p>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:mt-2 sm:gap-x-4">
          <Title
            className={cx(
              "max-w-full min-w-0 truncate font-display text-[1.6rem] leading-[1.2] font-semibold tracking-[-0.01em] sm:text-[2.2rem] lg:text-[2.6rem]",
              t ? "text-[#f2e8d8]" : "text-[#d7cdb9]",
            )}
          >
            <span dir="auto" data-testid="publish-title">
              {t || SHARE_TITLE_FALLBACK}
            </span>
          </Title>
          {chip ? <ShareStatusChip text={chip.text} kind={chip.kind} /> : null}
        </div>
        <ShareProgress className="mt-3 sm:mt-5" />
      </div>
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
    </section>
  );
}

/** The status chip on the leather. Text is app copy (no dir needed), one line. */
export function ShareStatusChip({ text, kind, className }: ShareChip & { className?: string }) {
  return (
    <span
      className={cx(SHARE_CHIP_BASE, SHARE_CHIP_TONE[kind], "shrink-0", className)}
      data-testid="publish-status-chip"
      data-kind={kind}
    >
      <span aria-hidden="true" className={cx("block size-2 shrink-0 rounded-full", SHARE_CHIP_DOT[kind])} />
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * Photos ✓ · Your book ✓ · Share (current). Compact everywhere (the share page has one job): small
 * foil check circles and names in a row, joined by foil hairlines; slightly larger from sm.
 * Not interactive — the back link is the way back.
 */
export function ShareProgress({ className }: { className?: string }) {
  const current = FLOW_STEPS.length - 1;
  return (
    <nav aria-label="Book steps" className={cx("min-w-0", className)} data-testid="share-progress">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 sm:gap-x-2.5">
        {FLOW_STEPS.map((s, i) => {
          const state = i < current ? "done" : i === current ? "current" : "upcoming";
          return (
            <li
              key={s.id}
              className="flex min-w-0 items-center gap-1.5 sm:gap-2.5"
              aria-current={state === "current" ? "step" : undefined}
              data-state={state}
              data-testid={`share-progress-${s.id}`}
            >
              {i > 0 ? <span aria-hidden="true" className="home-foil-h block h-px w-4 shrink-0 opacity-80 sm:w-8" /> : null}
              <span
                aria-hidden="true"
                className={cx(
                  "flex size-6 shrink-0 items-center justify-center rounded-full sm:size-7",
                  state === "done" && "home-foil-fill text-[#1b1b1d] shadow-[0_2px_6px_-2px_rgb(0_0_0/0.45)]",
                  state === "current" && "bg-[#f2e8d8] ring-2 ring-[#f2e8d8]/40 ring-offset-2 ring-offset-[#0e3b2e]",
                  state === "upcoming" && "border-[1.5px] border-[#9fb3a6]",
                )}
              >
                {state === "done" ? (
                  <Check strokeWidth={3} className="size-3.5 sm:size-4" />
                ) : state === "current" ? (
                  <span className="block size-2 rounded-full bg-[#0e3b2e]" />
                ) : null}
              </span>
              <span
                className={cx(
                  "text-xs whitespace-nowrap sm:text-sm",
                  state === "done" && "text-[#e3c766]",
                  state === "current" && "font-semibold text-[#f2e8d8]",
                  state === "upcoming" && "text-[#b9c2b6]",
                )}
              >
                {s.label}
                <span className="sr-only">
                  {", "}step {i + 1} of {FLOW_STEPS.length}, {state === "done" ? "completed" : state === "current" ? "current step" : "not started"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

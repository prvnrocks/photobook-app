// Back + Continue row for the book creation wizard (M19 T2 D-071; M20 T2 D-072). No hooks and no
// cn/next/link, so it is cheap inside first-load client islands. Back is one of: a server-rendered
// slot (e.g. a <Link> passed in), a plain href, or an onClick (pushState step changes); omitted on
// step 1. Back is an emerald outlined pill (deep emerald text 11.6:1 on cream); Continue is the
// screen's one gold pill (gold fill, ink text 7.1:1), a submit button by default; disabled it turns
// into a muted outlined pill (not a faded gold one).
// Phones: a sticky action bar at the screen bottom (cream, hairline, safe-area padding) that stays in
// reach while the step scrolls; ≥ sm: an inline row. `sticky={false}` keeps it inline everywhere.
// The bar is the last thing in its step, so at the end of the scroll nothing is under it; while it
// floats, a soft top shadow says "more below" and wizard-motion.css sets scroll-padding-bottom so
// focus / scrollIntoView never park a card under it.

import type { ReactNode } from "react";
import { cx as join } from "@/lib/cx";

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Outlined emerald Back: 48 px tall pill. Exported so a server page can style its own <Link>. */
export const WIZARD_BACK_CLASS = join(
  "inline-flex min-h-12 min-w-20 shrink-0 items-center justify-center gap-1.5 rounded-full border border-success/45 bg-card/60 px-5 text-base font-medium text-primary transition-colors hover:border-success hover:bg-success-soft motion-reduce:transition-none",
  "disabled:cursor-not-allowed disabled:opacity-60",
  FOCUS,
);

/** The phone sticky bar (≥ sm: static, no chrome). The gutter bleed matches LIBRARY_CONTAINER's px-gutter. */
const STICKY_BAR = join(
  "sticky bottom-0 z-20 -mx-gutter border-t border-border/80 bg-background/95 px-gutter pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-12px_20px_-18px_rgb(14_59_46/0.45)] backdrop-blur supports-[backdrop-filter]:bg-background/85",
  "sm:static sm:mx-0 sm:border-t-0 sm:bg-transparent sm:px-0 sm:pt-0 sm:pb-0 sm:shadow-none sm:backdrop-blur-none sm:supports-[backdrop-filter]:bg-transparent",
);

/** Gold pill Continue (same fill as the M18 gold "New book"). */
export const WIZARD_CONTINUE_CLASS = join(
  "inline-flex min-h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-full border border-transparent bg-accent-strong px-6 text-base font-semibold text-accent-strong-foreground shadow-card transition-colors hover:bg-accent-strong/90 motion-reduce:transition-none",
  // Disabled (nothing chosen yet): a deliberate muted pill — full-opacity border, muted surface and
  // label (5.4:1), no shadow — instead of a faded gold. Busy (pending) keeps the gold fill.
  "disabled:cursor-not-allowed disabled:not-aria-busy:border-input disabled:not-aria-busy:bg-muted disabled:not-aria-busy:text-muted-foreground disabled:not-aria-busy:shadow-none",
  "aria-busy:cursor-progress aria-busy:opacity-90",
  FOCUS,
);

export type WizardNavProps = {
  /** Server-rendered Back element (wins over backHref/onBack). Style it with WIZARD_BACK_CLASS. */
  back?: ReactNode;
  /** Plain-anchor Back (full navigation). */
  backHref?: string;
  /** Button Back (client step changes). */
  onBack?: () => void;
  backLabel?: string;
  continueLabel?: string;
  /** Shown instead of continueLabel while pending (e.g. "Creating…"). */
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  /** "submit" (default) submits the enclosing form; "button" relies on onContinue. */
  continueType?: "submit" | "button";
  onContinue?: () => void;
  /** Associates a submit button with a form elsewhere on the page. */
  form?: string;
  backTestId?: string;
  continueTestId?: string;
  /** Classes for the Back / Continue row (e.g. a max width). */
  className?: string;
  /** Sticky bottom bar on phones (default true). */
  sticky?: boolean;
};

export function WizardNav({
  back,
  backHref,
  onBack,
  backLabel = "Back",
  continueLabel = "Continue",
  pendingLabel,
  pending = false,
  disabled = false,
  continueType = "submit",
  onContinue,
  form,
  backTestId = "wizard-back",
  continueTestId = "wizard-continue",
  className,
  sticky = true,
}: WizardNavProps) {
  let backEl: ReactNode = null;
  if (back) backEl = back;
  else if (backHref)
    backEl = (
      <a href={backHref} className={WIZARD_BACK_CLASS} data-testid={backTestId}>
        {backLabel}
      </a>
    );
  else if (onBack)
    backEl = (
      <button
        type="button"
        onClick={onBack}
        disabled={pending}
        className={WIZARD_BACK_CLASS}
        data-testid={backTestId}
      >
        {backLabel}
      </button>
    );

  return (
    <div
      className={sticky ? STICKY_BAR : undefined}
      data-testid="wizard-nav"
      data-sticky={sticky ? "" : undefined}
    >
      <div className={join("flex w-full items-center gap-3", className)}>
        {backEl}
        <button
          type={continueType}
          form={form}
          onClick={onContinue}
          disabled={disabled || pending}
          aria-busy={pending || undefined}
          className={WIZARD_CONTINUE_CLASS}
          data-testid={continueTestId}
        >
          {pending ? (
            <span
              aria-hidden="true"
              className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
            />
          ) : null}
          {pending && pendingLabel ? pendingLabel : continueLabel}
        </button>
      </div>
    </div>
  );
}

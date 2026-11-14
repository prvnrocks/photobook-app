// Back + Continue row for the book creation wizard (M19 T2, D-071). No hooks and no cn/next/link,
// so it is cheap inside first-load client islands. Back is one of: a server-rendered slot (e.g. a
// <Link> passed in), a plain href, or an onClick (pushState step changes); omitted on step 1.
// Continue is the screen's one gold pill (gold fill, ink text 7.1:1), a submit button by default;
// disabled it turns into a muted outlined pill (not a faded gold one).

import type { ReactNode } from "react";

const join = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Text-style Back: 44 px tall, emerald text. Exported so a server page can style its own <Link>. */
export const WIZARD_BACK_CLASS = join(
  "inline-flex min-h-11 min-w-16 shrink-0 items-center justify-center rounded-full px-4 text-base font-medium text-primary hover:bg-secondary",
  FOCUS,
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
  className?: string;
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
      <button type="button" onClick={onBack} disabled={pending} className={WIZARD_BACK_CLASS} data-testid={backTestId}>
        {backLabel}
      </button>
    );

  return (
    <div className={join("flex w-full items-center gap-3", className)} data-testid="wizard-nav">
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
  );
}

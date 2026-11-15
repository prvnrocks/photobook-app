// The wizard's emerald leather band (M20 T2, D-072), in the My books style (LibraryHeader): gold
// small-caps eyebrow "NEW BOOK" over a foil hairline, the live book title in the cream serif (or the
// muted placeholder "Your new book" while it's blank), and the 7-step <WizardStepper>. Foil rules at
// the sides and foot, as on the books screen.
// Client-safe and hook-free (no cn/next/link): the /books/new client wizard renders it so the title
// and stepper update without a server render; WizardShell renders it for server-drawn steps.
// Fixed height whatever the title (one line, ellipsis) so nothing below shifts between steps.
// Contrast on the leather's lightest point: cream 7.19, cream-muted #d7cdb9 5.53, pale gold 5.25.

import { cx } from "@/lib/cx";
import type { WizardStep } from "@/lib/books/wizard-steps";
import { LIBRARY_CONTAINER } from "@/components/dashboard/library-classes";
import { WizardStepper } from "./WizardStepper";

export const WIZARD_TITLE_PLACEHOLDER = "Your new book";

export type WizardBandProps = {
  step: WizardStep;
  /** The book title as typed / saved; blank → the placeholder. Rendered in a dir="auto" span. */
  title?: string | null;
  /** Small caps line above the title. */
  eyebrow?: string;
  /** Passed to the stepper: done steps the flow allows become buttons. */
  onStepClick?: (step: WizardStep) => void;
  canGoTo?: (step: WizardStep) => boolean;
  className?: string;
};

export function WizardBand({ step, title, eyebrow = "New book", onStepClick, canGoTo, className }: WizardBandProps) {
  const t = (title ?? "").trim();
  return (
    <section
      aria-label="New book setup"
      className={cx("home-leather relative isolate overflow-hidden text-[#f2e8d8]", className)}
      data-testid="wizard-band"
    >
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 start-2 -z-10 w-px opacity-70 sm:start-4 lg:start-6" />
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 end-2 -z-10 w-px opacity-70 sm:end-4 lg:end-6" />
      <div className={cx(LIBRARY_CONTAINER, "pt-5 pb-4 sm:pt-8 sm:pb-7 lg:pt-9 lg:pb-8")}>
        <p className="flex items-center gap-3 text-[0.7rem] font-semibold tracking-[0.28em] text-[#e3c766] uppercase sm:text-xs">
          <span>{eyebrow}</span>
          <span aria-hidden="true" className="home-foil-h block h-px w-10 sm:w-14" />
        </p>
        <p
          className={cx(
            "mt-1.5 truncate font-display text-[1.6rem] leading-[1.2] font-semibold tracking-[-0.01em] sm:mt-2 sm:text-[2.2rem] lg:text-[2.6rem]",
            t ? "text-[#f2e8d8]" : "text-[#d7cdb9]",
          )}
          data-testid="wizard-band-title"
          data-placeholder={t ? undefined : ""}
        >
          <span dir="auto">{t || WIZARD_TITLE_PLACEHOLDER}</span>
        </p>
        <WizardStepper step={step} onStepClick={onStepClick} canGoTo={canGoTo} className="mt-3 sm:mt-5 lg:mt-6" />
      </div>
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
    </section>
  );
}

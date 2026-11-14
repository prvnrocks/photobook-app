// Full-page chrome for the book creation wizard (M19 T2, D-071; layout after the user's wizard.png,
// colours/type from the M17 emerald & gold tokens). Server component:
//   header  — the app wordmark (→ /dashboard) + the account menu, without the sticky bar
//   step    — "Step N of 6" + <WizardProgress>
//   content — children in a centred narrow column (28rem forms, `wide` 40rem card grids)
//   footer  — Photobook · Help · Privacy · Terms
// Step screens render their own headline (wizardHeadline) and <WizardNav> inside children.

import Link from "next/link";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { APP_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import type { WizardStep } from "@/lib/books/wizard-steps";
import { WizardStepHeader } from "./WizardProgress";

export type WizardShellProps = {
  step: WizardStep;
  /** name ?? email of the signed-in user, for the account button's initial. */
  displayName?: string | null;
  /** 40rem column for card grids (shape, style); default 28rem for forms. */
  wide?: boolean;
  /**
   * "client": the children render the step label + progress themselves (<WizardStepHeader>), for
   * screens that change step without a server render (/books/new uses pushState). The shell then
   * shows no step header and no data-step of its own (it would go stale).
   */
  stepHeader?: "shell" | "client";
  children: ReactNode;
};

const FOOTER_LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-muted-foreground underline-offset-4 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring";

export function WizardShell({ step, displayName, wide = false, stepHeader = "shell", children }: WizardShellProps) {
  const shellHeader = stepHeader === "shell";
  return (
    <div
      className="flex min-h-dvh flex-col bg-background bg-[radial-gradient(ellipse_80%_45%_at_50%_0%,rgb(31_111_84/0.07),transparent_70%)]"
      data-testid="wizard-shell"
      data-step={shellHeader ? step : undefined}
    >
      <AppHeader displayName={displayName} variant="plain" />
      <main className="flex w-full flex-1 flex-col items-center px-gutter pt-2 pb-10 sm:pt-4">
        {shellHeader ? <WizardStepHeader step={step} /> : null}
        <div
          className={`flex w-full min-w-0 flex-col ${shellHeader ? "mt-8 sm:mt-10" : ""} ${wide ? "max-w-[40rem]" : "max-w-[28rem]"}`}
          data-testid="wizard-content"
        >
          {children}
        </div>
      </main>
      <footer className="border-t border-border/80">
        <nav
          aria-label="Footer"
          className="mx-auto flex max-w-wide flex-wrap items-center justify-center gap-x-1 px-gutter py-2 text-xs"
          data-testid="wizard-footer"
        >
          <Link href="/" className={FOOTER_LINK} data-testid="wizard-footer-home">
            {APP_NAME}
          </Link>
          <Sep />
          <a href={`mailto:${SUPPORT_EMAIL}`} className={FOOTER_LINK} data-testid="wizard-footer-help">
            Help
          </a>
          <Sep />
          <Link href="/privacy" className={FOOTER_LINK} data-testid="wizard-footer-privacy">
            Privacy
          </Link>
          <Sep />
          <Link href="/terms" className={FOOTER_LINK} data-testid="wizard-footer-terms">
            Terms
          </Link>
        </nav>
      </footer>
    </div>
  );
}

function Sep() {
  return <span aria-hidden="true" className="h-3 w-px bg-border" />;
}

// The headline lives in its own hook-free module so client islands can use it without this file
// (next/link + the account menu). Re-exported for existing importers.
export { WizardHeadline } from "./WizardHeadline";

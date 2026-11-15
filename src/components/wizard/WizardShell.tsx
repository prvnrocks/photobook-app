// Full-page chrome for the book creation wizard (M19 T2 D-071; M20 T2 D-072: the My books style).
// Server component:
//   header  — the app wordmark (→ /dashboard) + the account menu (plain, library width)
//   main    — the children: the client wizard (NewBookWizard) draws the band (<WizardBand>: emerald
//             leather, "NEW BOOK", the book title, the 7-step stepper) and the body (<WizardBody>)
//             itself — it changes step with pushState, so a server-drawn title / stepper would go
//             stale. Both are hook-free and client-safe.
//   footer  — Photobook · Help · Privacy · Terms
// Step screens render their own headline (wizardHeadline) and <WizardNav> inside the main column.

import Link from "next/link";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { APP_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import "./wizard-motion.css";

export type WizardShellProps = {
  /** name ?? email of the signed-in user, for the account button's initial. */
  displayName?: string | null;
  /** The wizard: draws its own band + body (<WizardBand>, <WizardBody>). */
  children: ReactNode;
};

const FOOTER_LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-muted-foreground underline-offset-4 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring";

export function WizardShell({ displayName, children }: WizardShellProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-background" data-testid="wizard-shell">
      <AppHeader displayName={displayName} variant="plain" width="library" />
      <main className="flex w-full flex-1 flex-col" data-testid="wizard-main">
        {children}
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
export { WizardBand } from "./WizardBand";
export { WizardBody } from "./WizardBody";

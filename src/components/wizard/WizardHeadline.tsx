// The wizard step headline: serif display, deep emerald, centred (as wizard.png). No hooks and no
// client deps, usable from the server shell and from client islands. tabIndex -1 lets a client step
// change move focus to the new headline.

import type { ReactNode } from "react";

export function WizardHeadline({ children, id, focusable }: { children: ReactNode; id?: string; focusable?: boolean }) {
  return (
    <h1
      id={id}
      dir="auto"
      tabIndex={focusable ? -1 : undefined}
      className="type-display text-center text-balance text-heading outline-none"
      data-testid="wizard-headline"
    >
      {children}
    </h1>
  );
}

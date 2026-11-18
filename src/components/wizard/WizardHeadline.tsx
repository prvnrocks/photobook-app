// The wizard step headline: serif display, deep emerald, centred (as wizard.png). No hooks and no
// client deps, usable from the server shell and from client islands. tabIndex -1 lets a client step
// change move focus to the new headline. align="start-lg" (Photos, Create, Preview — M20 polish): start-aligned on
// ≥ lg so the headline keeps its place when step 7 drops the preview aside and the column widens.

import type { ReactNode } from "react";

export type WizardHeadlineAlign = "center" | "start-lg";

export function WizardHeadline({
  children,
  id,
  focusable,
  align = "center",
}: {
  children: ReactNode;
  id?: string;
  focusable?: boolean;
  align?: WizardHeadlineAlign;
}) {
  return (
    <h1
      id={id}
      dir="auto"
      tabIndex={focusable ? -1 : undefined}
      className={
        align === "start-lg"
          ? "type-display text-center text-balance text-heading outline-none lg:text-start"
          : "type-display text-center text-balance text-heading outline-none"
      }
      data-testid="wizard-headline"
      data-align={align}
    >
      {children}
    </h1>
  );
}

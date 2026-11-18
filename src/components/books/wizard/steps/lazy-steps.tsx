"use client";
// Steps 3–7 of the /books/new wizard, code-split (M20 T6, G5; Task 5 order): WizardDataSteps (data
// loading + Photos / Story / Design / Create / Preview, incl. the story questions) is one chunk
// outside the route's first load. React.lazy + Suspense rather
// than next/dynamic (its loadable runtime alone costs ~2 kB gzip on this first-load route); a hard
// load of step 3–7 still server-renders the step and the client hydrates it once the chunk is in.
// NewBookWizard calls prefetchWizardSteps() on idle from step 2, so the chunk is usually warm by the
// time step 2's Continue creates the book.

import { lazy, Suspense } from "react";
import type { WizardDataStepsProps } from "./WizardDataSteps";

const load = () => import("./WizardDataSteps");
const Steps = lazy(() => load().then((m) => ({ default: m.WizardDataSteps })));

export function LazyWizardDataSteps(props: WizardDataStepsProps) {
  return (
    <Suspense
      fallback={
        <p className="mt-10 text-center text-sm text-muted-foreground" role="status" data-testid="wizard-step-loading">
          Loading…
        </p>
      }
    >
      <Steps {...props} />
    </Suspense>
  );
}

/** Warm the steps 3–7 chunk (idempotent: the bundler caches the import). */
export function prefetchWizardSteps(): void {
  void load().catch(() => {});
}

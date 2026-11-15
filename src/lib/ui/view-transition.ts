// Step-change transitions for the book wizard (M20 T2, D-072 / G4). CSS only, no animation library:
//   - Browsers with document.startViewTransition: the DOM update runs inside the transition, wrapped in
//     React's flushSync so the new step is committed before the "after" snapshot is taken.
//   - Everything else (and prefers-reduced-motion: reduce): the update just runs. The step container's
//     own CSS enter animation (data-step-anim / data-step-dir in wizard-motion.css) gives the
//     cross-fade fallback; reduced motion gets no animation at all.
// Client-safe and tiny: imports only react-dom's flushSync.

import { flushSync } from "react-dom";

/** Direction of a step change, written to `data-step-dir` so CSS can slide the right way. */
export type StepDirection = "forward" | "back";

type ViewTransitionLike = { finished: Promise<unknown>; skipTransition?: () => void };
type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

/** True when the user asked for reduced motion (false outside the browser). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** True when the View Transitions API can be used right now (browser, supported, motion allowed). */
export function canUseViewTransition(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as DocumentWithViewTransition;
  return typeof doc.startViewTransition === "function" && !prefersReducedMotion();
}

/**
 * Runs a state update (e.g. setStep) as a view transition when possible; otherwise runs it directly.
 * Never throws because of the transition itself, and the update always runs exactly once.
 */
export function runViewTransition(update: () => void): void {
  if (!canUseViewTransition()) {
    update();
    return;
  }
  const doc = document as DocumentWithViewTransition;
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    flushSync(update);
  };
  try {
    const t = doc.startViewTransition!(run);
    // An aborted transition (another one started, hidden tab…) rejects `finished`; the update ran or
    // runs regardless — swallow so it never surfaces as an unhandled rejection.
    t.finished.catch(() => {});
  } catch {
    run();
  }
}

// The wizard's 7-step stepper (M20 T2, D-072), drawn on the emerald leather band (WizardBand).
//   ≥ sm  "big" stepper: 7 icon circles with names on a track; the track's fill (gold → emerald-light
//         gradient, shimmering) grows from step 1 to the current step. done = gold foil circle + ink
//         check, current = cream circle + emerald icon, scaled up with a pulsing halo, upcoming = sage
//         outline on the leather.
//   < sm  compact: the same list as a dots row (done gold dot, current cream pill, upcoming sage ring)
//         + "Step N of 7 · Name" under it.
// One <ol> serves both sizes (responsive classes), inside <nav aria-label>; the current item carries
// aria-current="step". Done steps become 44 px buttons only when onStepClick is given AND
// canGoTo(step) allows them (the flow decides — e.g. steps 1–4 lock once photos are picked).
// M20 polish: a clickable done step looks interactive (tooltip "Go back to Title", hover ring + name
// underline on hover devices, focus ring); a locked done step (canGoTo says no) is a plain item with
// "locked" for screen readers, a "… is locked now" tooltip and, on hover devices, a small lock badge —
// no hover lift. wizard-motion.css: .wz-node-button / .wz-node-locked.
// Contrast on the leather's lightest point (#1f5443): cream #f2e8d8 7.19, pale gold #e3c766 5.25,
// sage label #b9c2b6 4.76 (text ≥ 4.5); sage ring #9fb3a6 3.93, foil gold #c9a227 3.61 (graphics ≥ 3);
// ink check on gold 6.44; emerald icon on cream 10.28.
// Hook-free, no cn/next/link: usable from the server shell and inside first-load client islands.

import { BookOpenCheck, Check, Heart, Images, Lock, Palette, PenLine, Ratio, Sparkles, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";
import {
  WIZARD_STEP_COUNT,
  WIZARD_STEP_NUMBERS,
  wizardStepIcon,
  wizardStepLabel,
  wizardStepName,
  type WizardStep,
  type WizardStepIcon,
} from "@/lib/books/wizard-steps";
import "./wizard-motion.css";

const ICONS: Record<WizardStepIcon, LucideIcon> = {
  "pen-line": PenLine,
  heart: Heart,
  ratio: Ratio,
  palette: Palette,
  images: Images,
  sparkles: Sparkles,
  "book-open-check": BookOpenCheck,
};

export type WizardStepState = "done" | "current" | "upcoming";

export function stepStateOf(n: WizardStep, current: WizardStep): WizardStepState {
  return n < current ? "done" : n === current ? "current" : "upcoming";
}

/** Track fill 0..1: none on step 1, full on the last step. */
export function stepperProgress(current: WizardStep): number {
  return (current - 1) / (WIZARD_STEP_COUNT - 1);
}

export type WizardStepperProps = {
  step: WizardStep;
  /** Called with a done step the user tapped (only rendered as a button when canGoTo allows it). */
  onStepClick?: (step: WizardStep) => void;
  /** Whether a done step may be revisited right now. Without it no node is clickable. */
  canGoTo?: (step: WizardStep) => boolean;
  className?: string;
};

const CIRCLE: Record<WizardStepState, string> = {
  // Phone: dot / pill; ≥ sm: 44 px circle with icon.
  done: "size-2.5 bg-[#c9a227] sm:size-11 sm:home-foil-fill sm:text-[#1b1b1d] sm:shadow-[0_2px_8px_-2px_rgb(0_0_0/0.45)]",
  current:
    "h-2.5 w-6 bg-[#f2e8d8] sm:size-11 sm:text-[#0e3b2e] sm:ring-2 sm:ring-white sm:ring-offset-2 sm:ring-offset-[#0e3b2e] sm:shadow-[0_4px_14px_-4px_rgb(0_0_0/0.55)]",
  upcoming: "size-2.5 border-[1.5px] border-[#9fb3a6] bg-transparent sm:size-11 sm:bg-white/5 sm:text-[#9fb3a6]",
};

const NAME: Record<WizardStepState, string> = {
  done: "text-[#e3c766]",
  current: "font-semibold text-[#f2e8d8]",
  upcoming: "text-[#b9c2b6]",
};

const STATE_SR: Record<WizardStepState, string> = {
  done: "completed",
  current: "current step",
  upcoming: "not started",
};

export function WizardStepper({ step, onStepClick, canGoTo, className }: WizardStepperProps) {
  const progress = stepperProgress(step);
  return (
    <nav
      aria-label="Book setup steps"
      className={cx("flex w-full min-w-0 flex-col", className)}
      data-testid="wizard-stepper"
      data-step={step}
    >
      <p
        className="order-2 mt-1 text-center text-sm font-medium text-[#d7cdb9] sm:order-none sm:mt-0 sm:mb-3 sm:text-end sm:text-xs sm:font-semibold sm:tracking-[0.18em] sm:text-[#e3c766] sm:uppercase"
      >
        <span data-testid="wizard-step-label">{wizardStepLabel(step)}</span>
        <span className="sm:hidden" data-testid="wizard-step-name">
          <span aria-hidden="true"> · </span>
          {wizardStepName(step)}
        </span>
      </p>
      <div className="relative w-full min-w-0">
        {/* Track from the first node's centre to the last's (each item is 1/7 wide). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute start-[7.142857%] end-[7.142857%] top-[21px] h-0.5 overflow-hidden rounded-full bg-[#f2e8d8]/20 sm:top-5 sm:h-1"
        >
          <span
            className="wz-connector-fill block h-full w-full rounded-full"
            style={{ transform: `scaleX(${progress})` }}
            data-testid="wizard-stepper-fill"
            data-progress={progress.toFixed(3)}
          />
        </div>
        <ol className="relative flex w-full min-w-0 items-start" data-testid="wizard-stepper-list">
          {WIZARD_STEP_NUMBERS.map((n) => {
            const state = stepStateOf(n, step);
            const navigable = state === "done" && !!onStepClick && !!canGoTo;
            const clickable = navigable && canGoTo(n);
            return (
              <StepItem
                key={n}
                n={n}
                state={state}
                locked={navigable && !clickable}
                onClick={clickable ? () => onStepClick!(n) : undefined}
              />
            );
          })}
        </ol>
      </div>
    </nav>
  );
}

function StepItem({
  n,
  state,
  locked,
  onClick,
}: {
  n: WizardStep;
  state: WizardStepState;
  locked: boolean;
  onClick?: () => void;
}) {
  const Icon = ICONS[wizardStepIcon(n)];
  const name = wizardStepName(n);
  const inner = (
    <>
      <span className="flex h-11 items-center justify-center">
        <span
          className={cx("wz-node flex shrink-0 items-center justify-center rounded-full", CIRCLE[state])}
          data-state={state}
          data-testid="wizard-step-node"
        >
          {state === "done" ? (
            <Check aria-hidden="true" strokeWidth={3} className="wz-node-check hidden size-5 sm:block" />
          ) : (
            <Icon aria-hidden="true" strokeWidth={2} className="hidden size-5 sm:block" />
          )}
          {locked ? (
            <span aria-hidden="true" className="wz-lock-badge" data-testid="wizard-step-lock">
              <Lock strokeWidth={2.5} />
            </span>
          ) : null}
        </span>
      </span>
      <span className={cx("wz-node-name sr-only text-sm leading-tight sm:not-sr-only sm:mt-2 sm:block sm:text-center", NAME[state])}>
        {name}
        <span className="sr-only">
          {", "}step {n}, {STATE_SR[state]}
          {locked ? ", locked" : ""}
        </span>
      </span>
    </>
  );
  return (
    <li
      className="relative flex min-w-0 flex-1 justify-center"
      aria-current={state === "current" ? "step" : undefined}
      data-state={state}
      data-testid={`wizard-step-${n}`}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          title={`Go back to ${name}`}
          className="wz-node-button flex min-h-11 min-w-11 cursor-pointer flex-col items-center rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[#f2e8d8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e]"
          data-testid={`wizard-step-${n}-button`}
        >
          {inner}
        </button>
      ) : (
        <span
          className={cx("flex min-h-11 min-w-11 flex-col items-center", locked && "wz-node-locked cursor-default")}
          title={locked ? `${name} is locked now` : undefined}
          data-locked={locked ? "" : undefined}
        >
          {inner}
        </span>
      )}
    </li>
  );
}

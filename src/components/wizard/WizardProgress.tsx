// Six-segment progress bar for the book creation wizard (M19 T2, D-071). No hooks, no client deps:
// usable from the server shell and from client islands. Done and current steps are filled deep
// emerald; later steps are a stone track (the "Step N of 6" text above carries the meaning too).

import { WIZARD_STEP_COUNT, wizardStepLabel, type WizardStep } from "@/lib/books/wizard-steps";

export function WizardProgress({ step, className }: { step: WizardStep; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={WIZARD_STEP_COUNT}
      aria-valuenow={step}
      aria-valuetext={wizardStepLabel(step)}
      aria-label="Book setup progress"
      data-testid="wizard-progress"
      className={["flex w-full max-w-64 gap-1.5", className].filter(Boolean).join(" ")}
    >
      {Array.from({ length: WIZARD_STEP_COUNT }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          data-filled={i < step ? "" : undefined}
          data-testid="wizard-progress-segment"
          className="h-1.5 flex-1 rounded-full bg-input/30 data-filled:bg-primary"
        />
      ))}
    </div>
  );
}

/** "Step N of 6" + the bar, centred (the shell's step header; client islands render it themselves). */
export function WizardStepHeader({ step }: { step: WizardStep }) {
  return (
    <div className="flex w-full flex-col items-center gap-2.5">
      <p className="type-small font-medium text-muted-foreground" data-testid="wizard-step-label">
        {wizardStepLabel(step)}
      </p>
      <WizardProgress step={step} />
    </div>
  );
}

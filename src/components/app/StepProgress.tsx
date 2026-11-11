// Where the user is in the book flow (M11, D-067): "Step 3 of 6: AI build" plus six segments.
// At 375 px only the label line + bars show; step names appear under the bars from sm up.
// Not interactive (no links): it orients, the page's own buttons move the user on.

import { FLOW_STEPS, flowStepIndex, flowStepLabel, type FlowStepId } from "@/lib/app/flow-steps";
import { cn } from "@/lib/utils";

export function StepProgress({ current, className }: { current: FlowStepId; className?: string }) {
  const at = flowStepIndex(current);
  return (
    <nav aria-label="Book steps" className={cn("w-full", className)} data-testid="step-progress" data-step={current}>
      <p className="type-small text-muted-foreground">
        <span className="font-medium text-foreground">{flowStepLabel(current)}</span>
      </p>
      <ol className="mt-2 grid grid-cols-6 gap-1">
        {FLOW_STEPS.map((s, i) => {
          const state = i < at ? "done" : i === at ? "current" : "todo";
          return (
            <li key={s.id} aria-current={state === "current" ? "step" : undefined} data-state={state} className="min-w-0">
              <span
                aria-hidden="true"
                className={cn(
                  "block h-1.5 rounded-full",
                  state === "done" && "bg-primary",
                  state === "current" && "bg-accent-strong",
                  state === "todo" && "bg-border",
                )}
              />
              {/* Phones: step names are screen-reader only; from sm up they show under the bars. */}
              <span
                className={cn(
                  "sr-only sm:not-sr-only sm:mt-1.5 sm:block sm:truncate sm:text-xs",
                  state === "current" ? "sm:font-medium sm:text-foreground" : "sm:text-muted-foreground",
                )}
              >
                {s.label}
                <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current step)" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

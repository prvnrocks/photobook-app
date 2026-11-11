// Inline "working on it" state (M11, D-067): spinner + label, announced politely. Use for waits
// inside a screen (e.g. preparing a PDF); whole-route loading uses <PageSkeleton>.

import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function LoadingState({
  label = "Loading…",
  description,
  className,
  "data-testid": testId,
}: {
  label?: ReactNode;
  description?: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div role="status" aria-live="polite" data-testid={testId} className={cn("flex items-start gap-3 py-2", className)}>
      <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-accent-strong motion-reduce:animate-none" aria-hidden="true" />
      <div className="type-small min-w-0">
        <p className="font-medium text-foreground">{label}</p>
        {description ? <p className="mt-0.5 text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  );
}

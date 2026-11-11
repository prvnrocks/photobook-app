// Shared app page header (M11, D-067): optional back link, step progress, eyebrow, serif title,
// description and actions. Titles are often user text (book titles, Arabic too) → dir="auto".

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { FlowStepId } from "@/lib/app/flow-steps";
import { cn } from "@/lib/utils";
import { StepProgress } from "./StepProgress";

export type PageHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  back?: { href: string; label: string; testId?: string };
  step?: FlowStepId;
  /** Rendered at the end of the title row (stacks under it below sm). */
  actions?: ReactNode;
  /** "display" for landing-like screens (login, empty dashboard); default "h1". */
  size?: "h1" | "display";
  className?: string;
  /** data-testid for the h1 / eyebrow (specs assert these on several pages). */
  titleTestId?: string;
  eyebrowTestId?: string;
};

export function PageHeader({
  title,
  eyebrow,
  description,
  back,
  step,
  actions,
  size = "h1",
  className,
  titleTestId,
  eyebrowTestId,
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4", className)} data-testid="page-header">
      {back ? (
        <Link
          href={back.href}
          data-testid={back.testId}
          className="-ms-3 inline-flex h-11 w-fit items-center gap-1 rounded-lg ps-2 pe-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
          {back.label}
        </Link>
      ) : null}
      {step ? <StepProgress current={step} /> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? <p className="type-eyebrow mb-2" data-testid={eyebrowTestId}>{eyebrow}</p> : null}
          <h1 dir="auto" data-testid={titleTestId} className={cn("break-words text-foreground", size === "display" ? "type-display" : "type-h1")}>
            {title}
          </h1>
          {description ? (
            <p dir="auto" className="type-body mt-2 max-w-prose text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

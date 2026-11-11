// Shared app page header (M11, D-067): optional back link, step progress, eyebrow, serif title,
// description and actions. Titles are often user text (book titles, Arabic too) → dir="auto".

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { FlowStepId } from "@/lib/app/flow-steps";
import { cn } from "@/lib/utils";
import { StepProgress } from "./StepProgress";

/** The quiet "‹ Back" link style. Exported for the few back links that sit outside a PageHeader. */
export const BACK_LINK_CLASS =
  "-ms-3 inline-flex h-11 w-fit items-center gap-1 rounded-lg ps-2 pe-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export type PageHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  back?: { href: string; label: string; testId?: string };
  step?: FlowStepId;
  /** Rendered at the end of the title row (stacks under it below sm unless actionsInline). */
  actions?: ReactNode;
  /** Keep actions beside the title on phones too (a single short button, e.g. dashboard "New book"). */
  actionsInline?: boolean;
  /**
   * "label" (default): small uppercase tracked label — fixed app words only.
   * "text": quiet one-line text with dir="auto" — for user text such as a book title (letter-spacing
   * would break Arabic joining).
   */
  eyebrowVariant?: "label" | "text";
  /** "display" for landing-like screens (login, empty dashboard); default "h1". */
  size?: "h1" | "display";
  className?: string;
  /** data-testid for the h1 / eyebrow (specs assert these on several pages). */
  titleTestId?: string;
  eyebrowTestId?: string;
  descriptionTestId?: string;
};

export function PageHeader({
  title,
  eyebrow,
  description,
  back,
  step,
  actions,
  actionsInline = false,
  eyebrowVariant = "label",
  size = "h1",
  className,
  titleTestId,
  eyebrowTestId,
  descriptionTestId,
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4", className)} data-testid="page-header">
      {back ? (
        <Link
          href={back.href}
          data-testid={back.testId}
          className={BACK_LINK_CLASS}
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
          {back.label}
        </Link>
      ) : null}
      {step ? <StepProgress current={step} /> : null}
      <div
        className={cn(
          "flex gap-3",
          actionsInline ? "flex-row items-end justify-between" : "flex-col sm:flex-row sm:items-end sm:justify-between",
        )}
      >
        <div className="min-w-0">
          {eyebrow ? (
            eyebrowVariant === "text" ? (
              <p dir="auto" className="type-small mb-1 truncate font-medium text-muted-foreground" data-testid={eyebrowTestId}>
                {eyebrow}
              </p>
            ) : (
              <p className="type-eyebrow mb-2" data-testid={eyebrowTestId}>
                {eyebrow}
              </p>
            )
          ) : null}
          <h1 dir="auto" data-testid={titleTestId} className={cn("break-words text-foreground", size === "display" ? "type-display" : "type-h1")}>
            {title}
          </h1>
          {description ? (
            <p dir="auto" className="type-body mt-2 max-w-prose text-muted-foreground" data-testid={descriptionTestId}>
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

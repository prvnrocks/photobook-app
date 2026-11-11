// Primary actions of a screen (M11, D-067). On phones it sticks to the bottom edge (above the home
// indicator) so the next step is always one thumb away; from sm up it sits inline under the content.
// Put the call to action first in the DOM (Button size="cta"), secondary actions after it.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ActionBar({
  children,
  label = "Actions",
  sticky = true,
  className,
  "data-testid": testId,
}: {
  children: ReactNode;
  label?: string;
  sticky?: boolean;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className={cn(
        "flex flex-col gap-2",
        sticky &&
          "sticky bottom-0 z-30 -mx-gutter border-t border-border bg-background/95 px-gutter pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:backdrop-blur-none",
        // Full-width cta buttons share the row from sm up.
        "sm:flex-row-reverse sm:items-center sm:justify-start sm:*:w-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

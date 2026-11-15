// The wizard's cream content area under the band (M20 T2, D-072): the books screen's desktop width
// (LIBRARY_CONTAINER, max-w-library) with a two-column grid on ≥ lg — `main` (the step's choices) and
// an optional `aside` (the live book preview, another task) — single column below lg. Without an
// aside the step column is centred (40rem card grids with `wide`, 28rem forms otherwise).
// A minimum height keeps the footer from jumping between short and tall steps; overflow-x is clipped
// so the step slide-in never adds horizontal scroll at 375 px.
// Client-safe and hook-free: used by WizardShell and by client wizards that draw their own band.

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { LIBRARY_CONTAINER } from "@/components/dashboard/library-classes";

export type WizardBodyProps = {
  children: ReactNode;
  /** Right column on ≥ lg (stacks under the step below lg). */
  aside?: ReactNode;
  /** Without an aside: 52rem column for card grids; default 28rem for forms. */
  wide?: boolean;
  className?: string;
};

export function WizardBody({ children, aside, wide = false, className }: WizardBodyProps) {
  return (
    <div className={cx("w-full flex-1 overflow-x-clip", className)} data-testid="wizard-body">
      <div
        className={cx(
          LIBRARY_CONTAINER,
          "min-h-[30rem] pt-6 pb-8 sm:min-h-[34rem] sm:pt-10 sm:pb-12",
          aside ? "grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:gap-12 xl:grid-cols-[minmax(0,1fr)_26rem] xl:gap-16" : "flex flex-col items-center",
        )}
      >
        <div
          className={cx("flex w-full min-w-0 flex-col", aside ? "" : wide ? "max-w-[52rem]" : "max-w-[28rem]")}
          data-testid="wizard-content"
        >
          {children}
        </div>
        {aside ? (
          <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start" aria-label="Book preview" data-testid="wizard-aside">
            {aside}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

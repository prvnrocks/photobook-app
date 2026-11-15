// The wizard's cream content area under the band (M20 T2, D-072): the books screen's desktop width
// (LIBRARY_CONTAINER, max-w-library) with a two-column grid on ≥ lg — `main` (the step's choices) and
// an optional `aside` (the live book preview) — single column below lg (or aside hidden, asideBelowLg). Without an
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
  /**
   * Below lg: "stack" (default) puts the aside under the step; "hide" drops it (the step draws its
   * own compact version, e.g. the /books/new mini book preview — M20 T4).
   */
  asideBelowLg?: "stack" | "hide";
  className?: string;
};

export function WizardBody({ children, aside, wide = false, asideBelowLg = "stack", className }: WizardBodyProps) {
  return (
    <div className={cx("w-full flex-1 overflow-x-clip", className)} data-testid="wizard-body">
      <div
        className={cx(
          LIBRARY_CONTAINER,
          "min-h-[30rem] pt-6 pb-8 sm:min-h-[34rem] sm:pt-10 sm:pb-12",
          // With an aside the two columns fill the library width (M20 T4: no empty margins at
          // 1280 / 1600): the step column takes the rest, the preview column grows with the screen.
          aside
            ? "grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:gap-10 xl:grid-cols-[minmax(0,1fr)_30rem] xl:gap-14 2xl:grid-cols-[minmax(0,1fr)_34rem] 2xl:gap-16"
            : "flex flex-col items-center",
        )}
      >
        <div
          className={cx("flex w-full min-w-0 flex-col", aside ? "" : wide ? "max-w-[52rem]" : "max-w-[28rem]")}
          data-testid="wizard-content"
        >
          {children}
        </div>
        {aside ? (
          <aside
            className={cx("min-w-0 lg:sticky lg:top-6 lg:self-start", asideBelowLg === "hide" && "hidden lg:block")}
            aria-label="Book preview"
            data-testid="wizard-aside"
          >
            {aside}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

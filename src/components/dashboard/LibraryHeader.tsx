// "My books" header band (M18): the home hero's deep emerald leather, compact — gold small-caps
// eyebrow over a foil hairline, the serif title in cream, the count summary, and the screen's one gold
// call to action (the "New book" photo picker, passed in by the page). A foil rule closes the band.
// Contrast on the leather's lightest point (globals.css): cream 7.19, cream-muted #d7cdb9 5.53,
// pale gold #e3c766 5.25. Server component.

import type { ReactNode } from "react";
import { LIBRARY_CONTAINER } from "@/components/dashboard/library-classes";

export function LibraryHeader({ summary, action }: { summary?: string; action?: ReactNode }) {
  return (
    <section
      aria-labelledby="dashboard-heading"
      className="home-leather relative isolate overflow-hidden text-[#f2e8d8]"
      data-testid="library-header"
    >
      {/* Foil corner rules, echoing the home cover's frame. */}
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 start-2 -z-10 w-px opacity-70 sm:start-4 lg:start-6" />
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 end-2 -z-10 w-px opacity-70 sm:end-4 lg:end-6" />
      <div className={`${LIBRARY_CONTAINER} flex flex-row flex-wrap items-end justify-between gap-x-4 gap-y-5 py-7 sm:py-9 lg:py-11`}>
        <div className="min-w-0">
          <p className="flex items-center gap-3 text-[0.7rem] font-semibold tracking-[0.28em] text-[#e3c766] uppercase sm:text-xs">
            <span>Your library</span>
            <span aria-hidden="true" className="home-foil-h block h-px w-10 sm:w-14" />
          </p>
          <h1
            id="dashboard-heading"
            dir="auto"
            className="mt-2 font-display text-[2rem] leading-[1.1] font-semibold tracking-[-0.015em] text-[#f2e8d8] sm:mt-3 sm:text-[2.6rem] lg:text-[3rem]"
            data-testid="dashboard-heading"
          >
            My books
          </h1>
          {summary ? (
            <p className="type-small mt-2 text-[#d7cdb9] sm:text-base" data-testid="dashboard-summary">
              {summary}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
    </section>
  );
}

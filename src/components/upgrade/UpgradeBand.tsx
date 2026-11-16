// Upgrade return page band (M26, D-078): a compact version of the share / settings emerald leather —
// back link to the editor (passed in by the page, next/link stays on the server), gold small-caps
// eyebrow "Upgrade" over a foil hairline, and the book title in the cream serif (user text →
// <span dir="auto"> with testid upgrade-title, nothing else inside). The title is a <p>: each status
// card below carries the page's h1. Server component, hook-free. Contrast: upgrade-page-classes.ts.

import type { ReactNode } from "react";
import { UPGRADE_CONTAINER } from "@/components/upgrade/upgrade-page-classes";

export const UPGRADE_TITLE_FALLBACK = "Your book";

export function UpgradeBand({ title, back }: { title: string | null | undefined; back?: ReactNode }) {
  const t = (title ?? "").trim();
  return (
    <section aria-label="Upgrade" className="home-leather relative isolate overflow-hidden text-[#f2e8d8]" data-testid="upgrade-band">
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 start-2 -z-10 w-px opacity-70 sm:start-4 lg:start-6" />
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 end-2 -z-10 w-px opacity-70 sm:end-4 lg:end-6" />
      <div className={`${UPGRADE_CONTAINER} pt-2 pb-5 sm:pt-4 sm:pb-7`}>
        {back ? <div className="flex min-h-11 items-center">{back}</div> : <div className="h-3 sm:h-4" />}
        <p className="mt-1 flex items-center gap-3 text-[0.7rem] font-semibold tracking-[0.28em] text-[#e3c766] uppercase sm:mt-2 sm:text-xs">
          <span>Upgrade</span>
          <span aria-hidden="true" className="home-foil-h block h-px w-10 sm:w-14" />
        </p>
        <p
          className={`mt-1.5 max-w-full min-w-0 truncate font-display text-[1.5rem] leading-[1.25] font-semibold tracking-[-0.01em] sm:mt-2 sm:text-[2rem] ${
            t ? "text-[#f2e8d8]" : "text-[#d7cdb9]"
          }`}
        >
          <span dir="auto" data-testid="upgrade-title">
            {t || UPGRADE_TITLE_FALLBACK}
          </span>
        </p>
      </div>
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
    </section>
  );
}

// Settings header band (M24, D-076): the My books emerald leather — back link to My books (passed in
// by the page, next/link stays on the server), gold small-caps eyebrow "Account" over a foil hairline,
// the cream serif "Settings" h1 (testid settings-heading) and the signed-in email chip (user text →
// <span dir="auto"> with testid settings-email, nothing else inside). Foil rules at the sides and foot.
// Server component, hook-free. Contrast: see settings-page-classes.ts.

import type { ReactNode } from "react";
import { SETTINGS_CONTAINER, SETTINGS_EMAIL_CHIP } from "@/components/settings/settings-page-classes";
import { SETTINGS_COPY } from "@/lib/settings/ui";

export function SettingsBand({ back, email }: { back?: ReactNode; email: string | null }) {
  return (
    <section
      aria-labelledby="settings-heading"
      className="home-leather relative isolate overflow-hidden text-[#f2e8d8]"
      data-testid="settings-band"
    >
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 start-2 -z-10 w-px opacity-70 sm:start-4 lg:start-6" />
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 end-2 -z-10 w-px opacity-70 sm:end-4 lg:end-6" />
      <div className={`${SETTINGS_CONTAINER} pt-2 pb-6 sm:pt-4 sm:pb-8 lg:pb-10`}>
        {back ? <div className="flex min-h-11 items-center">{back}</div> : <div className="h-3 sm:h-4" />}
        <p className="mt-1 flex items-center gap-3 text-[0.7rem] font-semibold tracking-[0.28em] text-[#e3c766] uppercase sm:mt-2 sm:text-xs">
          <span>Account</span>
          <span aria-hidden="true" className="home-foil-h block h-px w-10 sm:w-14" />
        </p>
        <h1
          id="settings-heading"
          className="mt-2 font-display text-[2rem] leading-[1.1] font-semibold tracking-[-0.015em] text-[#f2e8d8] sm:mt-3 sm:text-[2.6rem] lg:text-[3rem]"
          data-testid="settings-heading"
        >
          {SETTINGS_COPY.heading}
        </h1>
        {email ? (
          <p className={`${SETTINGS_EMAIL_CHIP} mt-3 sm:mt-4`}>
            <span>Signed in as</span>
            <span dir="auto" className="min-w-0 font-medium break-all text-[#f2e8d8]" data-testid="settings-email">
              {email}
            </span>
          </p>
        ) : null}
      </div>
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
    </section>
  );
}

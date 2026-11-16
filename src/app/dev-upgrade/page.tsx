// Dev-only: the upgrade return page body with fixture phases, for 375 px checks without auth or
// Stripe. `?state=polling|processing|paid|paid-live|failed|support|timeout|signed-out|not-found` renders
// one phase; `?flow=paid|failed|support|timeout` runs the real poller against a stubbed status check
// (pending → paid / failed / needs_review after ~5 s; timeout = pending for the full 60 s).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).
// M26: the same shell as the real page (app header, emerald band, cream body, motion CSS), built here
// on the server — the client only mounts the poller module it already used.

import { ChevronLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { UpgradeBand } from "@/components/upgrade/UpgradeBand";
import { UPGRADE_BAND_BACK, UPGRADE_BODY, UPGRADE_COLUMN, UPGRADE_CONTAINER } from "@/components/upgrade/upgrade-page-classes";
import "@/components/upgrade/upgrade-motion.css";
import { DevUpgradeClient } from "./DevUpgradeClient";
import { DEV_UPGRADE_FLOWS, DEV_UPGRADE_STATES, type DevUpgradeFlow, type DevUpgradeState } from "./fixture";

export const dynamic = "force-dynamic";

export default async function DevUpgradePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const flow = (DEV_UPGRADE_FLOWS as readonly string[]).includes(String(params.flow)) ? (String(params.flow) as DevUpgradeFlow) : null;
  const state = (DEV_UPGRADE_STATES as readonly string[]).includes(String(params.state))
    ? (String(params.state) as DevUpgradeState)
    : "polling";
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader displayName="Sara Ahmed" variant="plain" width="library" />
      <main className="flex w-full flex-1 flex-col">
        <UpgradeBand
          title="رحلتنا إلى العين"
          back={
            <a href="#" className={UPGRADE_BAND_BACK} data-testid="upgrade-back">
              <ChevronLeft className="size-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
              Back to editor
            </a>
          }
        />
        <div className={`${UPGRADE_CONTAINER} ${UPGRADE_BODY}`}>
          <div className={UPGRADE_COLUMN}>
            <DevUpgradeClient state={state} flow={flow} />
          </div>
        </div>
      </main>
    </div>
  );
}

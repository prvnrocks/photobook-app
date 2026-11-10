// Dev-only: the upgrade return page body with fixture phases, for 375 px checks without auth or
// Stripe. `?state=polling|paid|paid-live|failed|timeout|signed-out|not-found` renders one phase;
// `?flow=paid|failed|timeout` runs the real poller against a stubbed status check (paid / failed
// after ~5 s; timeout = pending for the full 60 s).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import { notFound } from "next/navigation";
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
  return <DevUpgradeClient state={state} flow={flow} />;
}

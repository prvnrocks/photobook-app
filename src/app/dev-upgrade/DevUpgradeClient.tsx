"use client";

// Mounts the real upgrade return page body (dev-only route): one fixed phase, or the real poller
// against a stubbed status check.

import { useMemo, useRef } from "react";
import { UpgradeStatusFlow, UpgradeStatusView } from "@/components/upgrade/UpgradeStatusPoller";
import type { UpgradePollPhase } from "@/lib/upgrade/poller";
import type { UpgradeStatusResult } from "@/lib/upgrade/types";
import type { DevUpgradeFlow, DevUpgradeState } from "./fixture";


const BOOK_ID = "00000000-0000-4000-8000-000000000000";
const SLUG = "sara-and-omar-wedding-7Hq2xYp9Kd";

const PHASE: Record<DevUpgradeState, UpgradePollPhase> = {
  polling: "polling",
  paid: "paid",
  "paid-live": "paid",
  failed: "failed",
  timeout: "timeout",
  "signed-out": "unauthenticated",
  "not-found": "not_found",
};

export function DevUpgradeClient({ state, flow }: { state: DevUpgradeState; flow: DevUpgradeFlow | null }) {
  const calls = useRef(0);
  const check = useMemo(
    () => async (): Promise<UpgradeStatusResult> => {
      await new Promise((r) => setTimeout(r, 300));
      calls.current += 1;
      if (flow === "paid" && calls.current >= 3) return { isPaid: true, orderStatus: "paid" };
      if (flow === "failed" && calls.current >= 3) return { isPaid: false, orderStatus: "failed" };
      return { isPaid: false, orderStatus: "pending" };
    },
    [flow],
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 pb-10 pt-3">
      {flow ? (
        <UpgradeStatusFlow bookId={BOOK_ID} initialPaid={false} liveSlug={SLUG} check={check} refresh={() => {}} />
      ) : (
        <UpgradeStatusView bookId={BOOK_ID} phase={PHASE[state]} liveSlug={state === "paid-live" ? SLUG : null} onRetry={() => {}} />
      )}
    </main>
  );
}

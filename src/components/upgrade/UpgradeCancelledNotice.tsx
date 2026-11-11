"use client";

// "Payment cancelled" notice (M7 T6): Stripe Checkout's cancel URL returns to the page the user
// started from with ?upgrade=cancelled. Shows a small dismissible banner and removes the param
// from the URL right away, so a reload or a shared link doesn't show it again. The param is
// removed with window.history.replaceState (Next syncs it with useSearchParams) rather than
// router.replace: no server round trip, so the editor page's loader doesn't run again and its
// client state is untouched. Render inside <Suspense> (useSearchParams).

import { TriangleAlert, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  stripUpgradeCancelled,
  UPGRADE_CANCELLED_COPY,
  UPGRADE_CANCELLED_PARAM,
  UPGRADE_CANCELLED_VALUE,
} from "@/lib/upgrade/ui";

export function UpgradeCancelledNotice({ floating = false }: { floating?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const cancelled = searchParams.get(UPGRADE_CANCELLED_PARAM) === UPGRADE_CANCELLED_VALUE;
  // Latched from the first render (Stripe returns with a full page load): stays visible after the
  // param is removed, until dismissed.
  const [show, setShow] = useState(cancelled);

  useEffect(() => {
    if (!cancelled) return;
    window.history.replaceState(null, "", stripUpgradeCancelled(pathname, searchParams.toString()) + window.location.hash);
  }, [cancelled, pathname, searchParams]);

  if (!show) return null;

  const box = (
    <div
      role="status"
      className="type-small flex w-full min-w-0 items-center gap-3 rounded-xl border border-warning-border bg-warning-soft py-1 ps-4 pe-1 text-foreground shadow-card"
      data-testid="upgrade-cancelled"
    >
      <TriangleAlert className="size-5 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 py-2">{UPGRADE_CANCELLED_COPY}</p>
      <button
        type="button"
        onClick={() => setShow(false)}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 outline-none hover:bg-warning-border/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Dismiss"
        data-testid="upgrade-cancelled-dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );

  if (!floating) return box;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-50 flex justify-center px-gutter">
      <div className="pointer-events-auto w-full max-w-md">{box}</div>
    </div>
  );
}

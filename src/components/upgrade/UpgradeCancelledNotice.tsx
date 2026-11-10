"use client";

// "Payment cancelled" notice (M7 T6): Stripe Checkout's cancel URL returns to the page the user
// started from with ?upgrade=cancelled. Shows a small dismissible banner and removes the param
// from the URL right away, so a reload or a shared link doesn't show it again. The param is
// removed with window.history.replaceState (Next syncs it with useSearchParams) rather than
// router.replace: no server round trip, so the editor page's loader doesn't run again and its
// client state is untouched. Render inside <Suspense> (useSearchParams).

import { X } from "lucide-react";
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
      className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 py-1 pl-4 pr-1 text-sm text-amber-900 shadow-sm"
      data-testid="upgrade-cancelled"
    >
      <p className="min-w-0 flex-1 py-2">{UPGRADE_CANCELLED_COPY}</p>
      <button
        type="button"
        onClick={() => setShow(false)}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-amber-100"
        aria-label="Dismiss"
        data-testid="upgrade-cancelled-dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );

  if (!floating) return box;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-50 flex justify-center px-3">
      <div className="pointer-events-auto w-full max-w-md">{box}</div>
    </div>
  );
}

"use client";

// Mounted once in the root layout (M9 T14, D-058). Without NEXT_PUBLIC_POSTHOG_KEY it renders
// nothing and does nothing. With a key it:
//   - loads PostHog after hydration (idle time), cookieless — see src/lib/analytics/client.ts
//   - sends a sanitized $pageview on every route change (pathname only; no search params)
//   - sends a server-decided one-shot event from `?_ev=` (sign-in, book created) and removes the
//     param from the address bar
// Skipped on routes that must stay network-quiet: the headless-Chromium
// print route (its own network idle gates the PDF render).

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { initAnalytics, isAnalyticsActive, trackEvent, trackPageview } from "@/lib/analytics/client";
import { flashEvent, stripFlash } from "@/lib/analytics/flash";

const SKIPPED_PREFIXES = ["/print/"];

export function isTrackedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return !SKIPPED_PREFIXES.some((p) => pathname.startsWith(p));
}

export function Analytics() {
  const pathname = usePathname();

  useEffect(() => {
    if (!isAnalyticsActive() || !isTrackedPath(pathname)) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(() => void initAnalytics());
    else setTimeout(() => void initAnalytics(), 1);
  }, [pathname]);

  useEffect(() => {
    if (!isAnalyticsActive() || !isTrackedPath(pathname)) return;
    const flash = flashEvent(window.location.search);
    if (flash) {
      trackEvent(flash);
      const clean = `${window.location.pathname}${stripFlash(window.location.search)}${window.location.hash}`;
      window.history.replaceState(null, "", clean);
    }
    trackPageview();
  }, [pathname]);

  return null;
}

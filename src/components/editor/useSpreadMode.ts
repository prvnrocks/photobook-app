"use client";

// Facing-pages editing (M10a A9) from the md breakpoint (768 px) up; phones edit one page at a
// time. The server can't know the width, so server render + hydration report `null` ("not known
// yet"); EditorShell then renders the single-page carousel for phones and a spread-shaped
// placeholder for md+ with CSS (`md:hidden` / `hidden md:flex`), so neither size flashes the
// wrong layout (N7). Client-side navigations read the media query straight away.

import { useSyncExternalStore } from "react";

export const SPREAD_MEDIA_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(SPREAD_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(SPREAD_MEDIA_QUERY).matches;
}

function getServerSnapshot(): null {
  return null;
}

/**
 * true = two facing pages, false = one page, null = not known yet (server render / hydration).
 * `force` overrides the media query (tests/dev) and is never null.
 */
export function useSpreadMode(force?: "single" | "spread"): boolean | null {
  const matches = useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot);
  if (force === "single") return false;
  if (force === "spread") return true;
  return matches;
}

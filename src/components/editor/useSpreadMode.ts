"use client";

// Facing-pages editing (M10a A9) from the md breakpoint (768 px) up; phones edit one page at a
// time. Server render + first client render are single-page (mobile-first), then the media query
// takes over.

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

function getServerSnapshot(): boolean {
  return false;
}

/** True when the editor shows two facing pages; `force` overrides the media query (tests/dev). */
export function useSpreadMode(force?: "single" | "spread"): boolean {
  const matches = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (force === "single") return false;
  if (force === "spread") return true;
  return matches;
}

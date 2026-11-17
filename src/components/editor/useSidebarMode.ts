"use client";

// Desktop tool sidebar from the lg breakpoint (1024 px) up: the tools sit in a rail on the right
// (EditorToolRail) instead of the bottom pill bar, a tapped photo opens the photo picker beside it,
// and that panel stays open until the user closes it. Like useSpreadMode, server render +
// hydration report `null` ("not known yet"); EditorShell then hides the bottom bar ≥ lg with CSS
// and reserves the rail's width, so nothing jumps.

import { useSyncExternalStore } from "react";

export const SIDEBAR_MEDIA_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(SIDEBAR_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(SIDEBAR_MEDIA_QUERY).matches;
}

function getServerSnapshot(): null {
  return null;
}

/** true = tool sidebar (≥ lg), false = bottom toolbar, null = not known yet (server render / hydration). */
export function useSidebarMode(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot);
}

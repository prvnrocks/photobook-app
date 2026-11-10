// One-shot analytics "flash" for events decided on the server (M9 T14). Pure + isomorphic.
//
// Sign-in and book creation finish with a server redirect, but PostHog runs in the browser. The
// server appends `?_ev=<code>` to the redirect target (only when analytics is configured); the
// client <Analytics> reads it once, sends the matching allow-listed event and removes the param
// from the address bar. Codes are a fixed list — nothing user-specific travels in the URL.

import type { AnalyticsEvent } from "./events";

export const FLASH_PARAM = "_ev";

const FLASH_EVENTS = {
  "signed_up.email": { name: "signed_up", props: { method: "email" } },
  "signed_up.google": { name: "signed_up", props: { method: "google" } },
  "logged_in.email": { name: "logged_in", props: { method: "email" } },
  "logged_in.google": { name: "logged_in", props: { method: "google" } },
  book_created: { name: "book_created", props: {} },
} as const satisfies Record<string, AnalyticsEvent>;

export type AnalyticsFlash = keyof typeof FLASH_EVENTS;

/** NEXT_PUBLIC_POSTHOG_KEY set (inlined at build time on the client, read at runtime on the server). */
export function analyticsEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim());
}

/**
 * Append the flash code to a same-site path (e.g. a safeNextPath result). Unchanged when
 * analytics is off, so redirects look exactly as before without a key.
 */
export function withAnalyticsFlash(path: string, flash: AnalyticsFlash, enabled = analyticsEnabled()): string {
  if (!enabled) return path;
  const hashAt = path.indexOf("#");
  const base = hashAt === -1 ? path : path.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : path.slice(hashAt);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${FLASH_PARAM}=${encodeURIComponent(flash)}${hash}`;
}

/** The event for a `?_ev=` value, or null for anything not on the list. */
export function flashEvent(search: string): AnalyticsEvent | null {
  let code: string | null;
  try {
    code = new URLSearchParams(search).get(FLASH_PARAM);
  } catch {
    return null;
  }
  if (code === null || !Object.prototype.hasOwnProperty.call(FLASH_EVENTS, code)) return null;
  return FLASH_EVENTS[code as AnalyticsFlash];
}

/** `search` without the flash param ("" when nothing is left), for history.replaceState. */
export function stripFlash(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(FLASH_PARAM);
  const q = params.toString();
  return q ? `?${q}` : "";
}

/** Window in which a just-confirmed account counts as new. */
export const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

type AuthUserTimes = {
  created_at?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
};

/**
 * signed_up vs logged_in after a successful sign-in. Email OTP users are created when the code is
 * requested and confirmed at their first verification; Google users are created and confirmed at
 * the first callback. So "confirmed within the last few minutes" = first sign-in.
 */
export function authFlash(
  user: AuthUserTimes | null | undefined,
  method: "email" | "google",
  nowMs: number = Date.now(),
): AnalyticsFlash {
  const confirmed = user?.email_confirmed_at ?? user?.confirmed_at ?? user?.created_at ?? null;
  const t = confirmed ? Date.parse(confirmed) : NaN;
  const isNew = Number.isFinite(t) && nowMs - t >= -60_000 && nowMs - t <= NEW_USER_WINDOW_MS;
  return isNew ? `signed_up.${method}` : `logged_in.${method}`;
}

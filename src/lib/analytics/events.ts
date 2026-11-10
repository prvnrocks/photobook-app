// Product analytics event allow-list (M9 T14, D-058). Pure + isomorphic.
//
// Photo content, captions, titles, slugs, ids and emails are user data — they never reach
// analytics. Every event is declared here with a property schema that only admits:
//   - "count": a finite, non-negative integer (capped at MAX_COUNT)
//   - "bool":  true / false
//   - an enum: a fixed list of strings; any other string is dropped
// The runtime guard (sanitizeEventProperties) enforces the schema at the last moment before
// sending, so even an untyped call (or a future refactor) can't leak free text.

/** Counts above this are clamped (no event property should ever be this large). */
export const MAX_COUNT = 100_000;

export const AUTH_METHODS = ["email", "google"] as const;
export const AI_BUILD_MODES = ["ai", "rules"] as const;
export const AI_BUILD_OUTCOMES = ["ok", "failed"] as const;
/** Coarse duration buckets (msBucket). Exact timings could fingerprint a session. */
export const MS_BUCKETS = ["<30s", "30-60s", "1-2m", "2-5m", "5-10m", "10m+"] as const;

type Kind = "count" | "bool" | readonly string[];

/** Property schema per allow-listed event. Add new events HERE only. */
export const EVENT_SCHEMAS = {
  /** First sign-in of a new account (server decides "new" from the auth user's timestamps). */
  signed_up: { method: AUTH_METHODS },
  /** Sign-in of an existing account. */
  logged_in: { method: AUTH_METHODS },
  book_created: {},
  /** One upload run finished (not cancelled / not refused). */
  upload_done: { photos: "count", failed: "count", skipped: "count" },
  /** The build screen handed over to review. `failed` = AI stopped, the rule album is shown. */
  ai_build_done: { mode: AI_BUILD_MODES, outcome: AI_BUILD_OUTCOMES, ms_bucket: MS_BUCKETS },
  published: { is_paid: "bool", has_password: "bool", pages: "count", first: "bool" },
  /** Stripe Checkout URL received; the browser is navigating to it. */
  checkout_started: {},
  /** `reused` = the server handed back an existing export without rendering. */
  pdf_downloaded: { pages: "count", reused: "bool" },
  viewer_opened: { is_paid: "bool", pages: "count", is_owner: "bool" },
} as const satisfies Record<string, Record<string, Kind>>;

export type AnalyticsEventName = keyof typeof EVENT_SCHEMAS;

type PropType<K> = K extends "count" ? number : K extends "bool" ? boolean : K extends readonly (infer S)[] ? S : never;

/** Typed properties of one event. */
export type AnalyticsProps<E extends AnalyticsEventName> = {
  [P in keyof (typeof EVENT_SCHEMAS)[E]]: PropType<(typeof EVENT_SCHEMAS)[E][P]>;
};

/** Discriminated union of every allow-listed event with its properties. */
export type AnalyticsEvent = {
  [E in AnalyticsEventName]: { name: E; props: AnalyticsProps<E> };
}[AnalyticsEventName];

/** Events PostHog may receive: ours plus the SDK's own $pageview (which we send ourselves). */
export const PAGEVIEW_EVENT = "$pageview";

export function isAnalyticsEventName(name: unknown): name is AnalyticsEventName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, name);
}

function cleanValue(kind: Kind, value: unknown): number | boolean | string | undefined {
  if (kind === "count") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.min(Math.floor(value), MAX_COUNT);
  }
  if (kind === "bool") return typeof value === "boolean" ? value : undefined;
  return typeof value === "string" && kind.includes(value) ? value : undefined;
}

/**
 * Runtime guard: returns only the schema's keys with valid values (counts, booleans, enum
 * members); everything else — unknown keys, free strings, objects, NaN — is dropped.
 * Unknown event → null (the event must not be sent).
 */
export function sanitizeEventProperties(
  name: unknown,
  props: unknown,
): Record<string, number | boolean | string> | null {
  if (!isAnalyticsEventName(name)) return null;
  const schema = EVENT_SCHEMAS[name] as Record<string, Kind>;
  const out: Record<string, number | boolean | string> = {};
  if (props === null || typeof props !== "object") return out;
  for (const [key, kind] of Object.entries(schema)) {
    const v = cleanValue(kind, (props as Record<string, unknown>)[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Duration → coarse bucket label. */
export function msBucket(ms: number): (typeof MS_BUCKETS)[number] {
  const s = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  if (s < 30) return "<30s";
  if (s < 60) return "30-60s";
  if (s < 120) return "1-2m";
  if (s < 300) return "2-5m";
  if (s < 600) return "5-10m";
  return "10m+";
}

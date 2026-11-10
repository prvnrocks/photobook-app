// PostHog in the browser, privacy-first (M9 T14, D-058). Browser-only at runtime; importing it
// on the server is harmless (every function bails out without `window`).
//
// - No NEXT_PUBLIC_POSTHOG_KEY → every call is a no-op and posthog-js is never downloaded.
// - posthog-js is the "slim, no-external" build (core only: no autocapture, replay, surveys,
//   toolbar or remote scripts in the bundle at all), loaded with a dynamic import after hydration.
// - Cookieless: persistence "memory" + disable_persistence — no cookies, no localStorage. Each
//   full page load is a new anonymous visitor; SPA navigations share one in-memory id.
// - No person profiles, no identify(), no feature-flag / remote-config calls.
// - Events: only the allow-list in ./events (counts / booleans / enums) plus our own $pageview.
// - before_send is the last gate: unknown events are dropped, SDK properties are reduced to an
//   allow-list of device/session facts, and every URL/path is rewritten by ./sanitize-path
//   (/b/:slug, :id, no query strings). Document titles (book titles!) never leave the browser.
// - IP addresses are attached by PostHog's ingestion, not the SDK: enable "Discard client IP
//   data" in the PostHog project settings (see .env.example).

import type { CaptureResult, PostHog, PostHogConfig } from "posthog-js/dist/module.slim.no-external";
import {
  type AnalyticsEvent,
  type AnalyticsEventName,
  type AnalyticsProps,
  isAnalyticsEventName,
  PAGEVIEW_EVENT,
  sanitizeEventProperties,
} from "./events";
import { sanitizePath, sanitizeUrl } from "./sanitize-path";

export const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

/** SDK properties that describe the device/session only (no content, no identifiers of people). */
const SDK_PROPS_ALLOWED = new Set([
  "token",
  "distinct_id",
  "$lib",
  "$lib_version",
  "$lib_custom_api_host",
  "$browser",
  "$browser_version",
  "$browser_language",
  "$browser_language_prefix",
  "$os",
  "$os_version",
  "$device",
  "$device_type",
  "$device_id",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$timezone",
  "$timezone_offset",
  "$host",
  "$referring_domain",
  "$session_id",
  "$window_id",
  "$pageview_id",
  "$insert_id",
  "$time",
  "$process_person_profile",
  "$is_identified",
  "$configured_session_timeout_ms",
  "$sdk_debug_retry_queue_size",
  "$lib_rate_limit_remaining_tokens",
]);
/** Full URLs on our own origin: origin + sanitized path. */
const OWN_URL_PROPS = new Set(["$current_url", "$initial_current_url"]);
/** URLs that may point at other sites: other origins are cut to the origin. */
const FOREIGN_URL_PROPS = new Set(["$referrer", "$initial_referrer"]);
/** Bare paths. */
const PATH_PROPS = new Set(["$pathname", "$initial_pathname", "$prev_pageview_pathname"]);

/**
 * Last gate before the network (before_send). Returns a new capture result or null (drop).
 * Pure; exported for tests.
 */
export function sanitizeCapture(cr: CaptureResult | null, ownOrigin: string): CaptureResult | null {
  if (!cr) return null;
  const isPageview = cr.event === PAGEVIEW_EVENT;
  if (!isPageview && !isAnalyticsEventName(cr.event)) return null;

  const props = (cr.properties ?? {}) as Record<string, unknown>;
  const own = isPageview ? {} : sanitizeEventProperties(cr.event, props);
  if (own === null) return null;

  const out: Record<string, unknown> = { ...own };
  for (const [key, value] of Object.entries(props)) {
    if (Object.prototype.hasOwnProperty.call(own, key)) continue;
    if (OWN_URL_PROPS.has(key)) {
      const v = sanitizeUrl(value, ownOrigin);
      if (v) out[key] = v;
    } else if (FOREIGN_URL_PROPS.has(key)) {
      const v = value === "$direct" ? "$direct" : sanitizeUrl(value, ownOrigin);
      if (v) out[key] = v;
    } else if (PATH_PROPS.has(key)) {
      if (typeof value === "string") out[key] = sanitizePath(value);
    } else if (SDK_PROPS_ALLOWED.has(key)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        out[key] = typeof value === "string" ? value.slice(0, 200) : value;
      }
    }
  }
  // Person properties are never set (no profiles).
  return { uuid: cr.uuid, event: cr.event, properties: out, ...(cr.timestamp ? { timestamp: cr.timestamp } : {}) };
}

/** Init options (exported for tests). */
export function posthogConfig(apiHost: string, ownOrigin: string): Partial<PostHogConfig> {
  return {
    api_host: apiHost,
    persistence: "memory",
    disable_persistence: true,
    person_profiles: "never",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    save_referrer: false,
    save_campaign_params: false,
    respect_dnt: true,
    // Belt and braces next to before_send's allow-list.
    property_denylist: ["$ip", "$raw_user_agent", "title", "$title", "$set", "$set_once"],
    // `defaults` ≥ 2026-01-30 would flag localhost as a test user and turn on person processing.
    internal_or_test_user_hostname: null,
    before_send: (cr) => sanitizeCapture(cr, ownOrigin),
  };
}

type Pending = { event: string; props: Record<string, unknown>; beacon: boolean };

const MAX_PENDING = 50;
let instance: PostHog | null = null;
let loading: Promise<PostHog | null> | null = null;
let pending: Pending[] = [];

function configuredKey(): string | null {
  // Literal process.env access: Next inlines NEXT_PUBLIC_* at build time.
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  return key ? key : null;
}

function configuredHost(): string {
  return process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
}

/** True when a key is configured and we're in a browser. */
export function isAnalyticsActive(): boolean {
  return typeof window !== "undefined" && configuredKey() !== null;
}

function send(ph: PostHog, p: Pending): void {
  try {
    ph.capture(p.event, p.props, p.beacon ? { send_instantly: true, transport: "sendBeacon" } : undefined);
  } catch {
    // Analytics must never break the app.
  }
}

/**
 * Load + init PostHog once. No key / no window → resolves null and nothing is downloaded.
 * `load` is injectable for tests.
 */
export function initAnalytics(
  load: () => Promise<{ default: PostHog }> = () => import("posthog-js/dist/module.slim.no-external"),
): Promise<PostHog | null> {
  const key = configuredKey();
  if (typeof window === "undefined" || !key) return Promise.resolve(null);
  if (instance) return Promise.resolve(instance);
  loading ??= load()
    .then(({ default: ph }) => {
      ph.init(key, posthogConfig(configuredHost(), window.location.origin));
      instance = ph;
      const queued = pending;
      pending = [];
      for (const p of queued) send(ph, p);
      return ph;
    })
    .catch(() => {
      pending = [];
      return null;
    });
  return loading;
}

function enqueue(p: Pending): void {
  if (!isAnalyticsActive()) return;
  if (instance) return send(instance, p);
  if (pending.length < MAX_PENDING) pending.push(p);
  void initAnalytics();
}

/**
 * Send an allow-listed event. Properties are checked again at runtime (sanitizeEventProperties).
 * `beacon`: the page is about to navigate away (checkout, downloads) — send immediately.
 * Never pass titles, captions, slugs, ids or emails: the schema has no place for them anyway.
 */
export function track<E extends AnalyticsEventName>(
  event: E,
  props: AnalyticsProps<E>,
  opts: { beacon?: boolean } = {},
): void {
  const clean = sanitizeEventProperties(event, props);
  if (clean === null) return;
  enqueue({ event, props: clean, beacon: opts.beacon === true });
}

/** track() for an event value (e.g. from the `?_ev=` flash). */
export function trackEvent(e: AnalyticsEvent, opts: { beacon?: boolean } = {}): void {
  const clean = sanitizeEventProperties(e.name, e.props);
  if (clean === null) return;
  enqueue({ event: e.name, props: clean, beacon: opts.beacon === true });
}

/** Our own $pageview (capture_pageview is off); before_send rewrites the URL properties. */
export function trackPageview(): void {
  enqueue({ event: PAGEVIEW_EVENT, props: {}, beacon: false });
}

/** Test helper: forget the instance and queue. */
export function __resetAnalyticsForTests(): void {
  instance = null;
  loading = null;
  pending = [];
}

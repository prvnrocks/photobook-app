import "server-only";

// Milestone 2 (T7, D-015): Mapbox Geocoding v6 reverse lookup with permanent=true
// (results may be stored in photos.place). Swappable via the ReverseGeocoder type.
// Privacy: coordinates and the token are never logged — only status codes.

export type ReverseGeocoder = (lat: number, lng: number) => Promise<string | null>;

export type ReverseGeocodeOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Delay before the single retry in ms (default 300). */
  retryDelayMs?: number;
};

const ENDPOINT = "https://api.mapbox.com/search/geocode/v6/reverse";
const TYPES = "neighborhood,locality,place,region,country";
const MAX_LABEL = 120;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function buildReverseUrl(lat: number, lng: number, token: string): string {
  const params = new URLSearchParams({
    longitude: String(round4(lng)),
    latitude: String(round4(lat)),
    language: "en",
    permanent: "true",
    types: TYPES,
    access_token: token,
  });
  return `${ENDPOINT}?${params.toString()}`;
}

type CtxEntry = { name?: unknown };
type Feature = {
  properties?: {
    feature_type?: unknown;
    name?: unknown;
    context?: Record<string, CtxEntry | undefined>;
  };
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * Builds a short label from a v6 FeatureCollection:
 *  neighborhood/locality + place  → "Al Bateen, Abu Dhabi"
 *  place + country                → "Paris, France"
 *  region + country               → "Abu Dhabi, United Arab Emirates"
 *  country                        → "United Arab Emirates"
 * Uses the most specific (first) feature and its context. Returns null if nothing usable.
 */
export function labelFromResponse(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features) || features.length === 0) return null;
  const f = features[0] as Feature;
  const props = f?.properties;
  if (!props || typeof props !== "object") return null;

  const ctx = (props.context && typeof props.context === "object" ? props.context : {}) as Record<
    string,
    CtxEntry | undefined
  >;
  const pick = (key: string): string | null => {
    const fromCtx = str(ctx[key]?.name);
    if (fromCtx) return fromCtx;
    return props.feature_type === key ? str(props.name) : null;
  };

  const local = pick("neighborhood") ?? pick("locality");
  const place = pick("place");
  const region = pick("region");
  const country = pick("country");

  let parts: (string | null)[];
  if (local && place) parts = [local, place];
  else if (local) parts = [local, region ?? country];
  else if (place) parts = [place, country];
  else if (region) parts = [region, country];
  else parts = [country ?? str(props.name)];

  const uniq: string[] = [];
  for (const p of parts) if (p && !uniq.includes(p)) uniq.push(p);
  if (uniq.length === 0) return null;
  const label = uniq.join(", ");
  return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1).trimEnd() + "…" : label;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Attempt = { kind: "ok"; label: string | null } | { kind: "retry"; status: number | null } | { kind: "fail" };

async function attempt(url: string, fetchImpl: typeof fetch, timeoutMs: number, outer?: AbortSignal): Promise<Attempt> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuter = () => ctrl.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) return { kind: "retry", status: res.status };
    if (!res.ok) {
      console.warn(`[geocode] reverse geocode failed (status ${res.status})`);
      return { kind: "fail" };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      console.warn("[geocode] reverse geocode returned an unreadable response");
      return { kind: "fail" };
    }
    return { kind: "ok", label: labelFromResponse(json) };
  } catch {
    if (outer?.aborted) return { kind: "fail" };
    return { kind: "retry", status: null };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

/** Reverse geocodes one coordinate to a short place label, or null on any failure. */
export async function reverseGeocode(
  lat: number,
  lng: number,
  opts: ReverseGeocodeOptions = {},
): Promise<string | null> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    console.warn("[geocode] MAPBOX_TOKEN is not set; skipping reverse geocode");
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const url = buildReverseUrl(lat, lng, token);

  for (let i = 0; i < 2; i++) {
    if (opts.signal?.aborted) return null;
    const r = await attempt(url, fetchImpl, timeoutMs, opts.signal);
    if (r.kind === "ok") return r.label;
    if (r.kind === "fail") return null;
    const what = r.status === null ? "network error or timeout" : `status ${r.status}`;
    if (i === 0) {
      console.warn(`[geocode] reverse geocode ${what}; retrying once`);
      await sleep(opts.retryDelayMs ?? 300);
    } else {
      console.warn(`[geocode] reverse geocode ${what}; giving up`);
    }
  }
  return null;
}

/** Default provider, matching the swappable ReverseGeocoder interface. */
export const mapboxReverseGeocoder: ReverseGeocoder = (lat, lng) => reverseGeocode(lat, lng);

/**
 * Geocodes many centroids with bounded concurrency. Output order matches input order;
 * failures are null. Pass `geocoder` to swap the provider (e.g. a mock in tests).
 */
export async function reverseGeocodeMany(
  centroids: { lat: number; lng: number }[],
  opts: { concurrency?: number; geocoder?: ReverseGeocoder } = {},
): Promise<(string | null)[]> {
  const geocoder = opts.geocoder ?? mapboxReverseGeocoder;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const out: (string | null)[] = new Array(centroids.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < centroids.length) {
      const i = next++;
      try {
        out[i] = await geocoder(centroids[i].lat, centroids[i].lng);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, centroids.length) }, worker));
  return out;
}

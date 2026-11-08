import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildReverseUrl,
  labelFromResponse,
  reverseGeocode,
  reverseGeocodeMany,
  type ReverseGeocoder,
} from "@/lib/geo/reverse-geocode";

const TOKEN = "pk.test-token-xyz";

const ctx = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, name]) => [k, { name, mapbox_id: `id-${k}` }]));

const UAE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        feature_type: "neighborhood",
        name: "Al Bateen",
        context: ctx({
          neighborhood: "Al Bateen",
          place: "Abu Dhabi",
          region: "Abu Dhabi",
          country: "United Arab Emirates",
        }),
      },
    },
    { type: "Feature", properties: { feature_type: "place", name: "Abu Dhabi" } },
  ],
};

const PARIS = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        feature_type: "place",
        name: "Paris",
        context: ctx({ place: "Paris", region: "Île-de-France", country: "France" }),
      },
    },
  ],
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let logs: string[];

beforeEach(() => {
  vi.stubEnv("MAPBOX_TOKEN", TOKEN);
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function expectNoSensitiveLogs() {
  for (const l of logs) {
    expect(l).not.toContain(TOKEN);
    expect(l).not.toMatch(/24\.45|54\.37|48\.85|2\.35/);
  }
}

describe("buildReverseUrl", () => {
  it("uses v6 reverse with permanent=true and 4-decimal rounding", () => {
    const u = new URL(buildReverseUrl(24.453912345, 54.377349999, TOKEN));
    expect(u.origin + u.pathname).toBe("https://api.mapbox.com/search/geocode/v6/reverse");
    expect(u.searchParams.get("latitude")).toBe("24.4539");
    expect(u.searchParams.get("longitude")).toBe("54.3773");
    expect(u.searchParams.get("permanent")).toBe("true");
    expect(u.searchParams.get("language")).toBe("en");
    expect(u.searchParams.get("types")).toBe("neighborhood,locality,place,region,country");
    expect(u.searchParams.get("access_token")).toBe(TOKEN);
  });
});

describe("labelFromResponse", () => {
  it("builds neighborhood + place for UAE", () => {
    expect(labelFromResponse(UAE)).toBe("Al Bateen, Abu Dhabi");
  });
  it("builds place + country for Paris", () => {
    expect(labelFromResponse(PARIS)).toBe("Paris, France");
  });
  it("uses locality when there is no neighborhood", () => {
    const r = {
      features: [
        {
          properties: {
            feature_type: "locality",
            name: "Saadiyat Island",
            context: ctx({ locality: "Saadiyat Island", place: "Abu Dhabi", country: "United Arab Emirates" }),
          },
        },
      ],
    };
    expect(labelFromResponse(r)).toBe("Saadiyat Island, Abu Dhabi");
  });
  it("falls back to region + country, then country, and dedupes", () => {
    const region = {
      features: [{ properties: { feature_type: "region", name: "Abu Dhabi", context: ctx({ region: "Abu Dhabi", country: "United Arab Emirates" }) } }],
    };
    expect(labelFromResponse(region)).toBe("Abu Dhabi, United Arab Emirates");
    const country = { features: [{ properties: { feature_type: "country", name: "Oman" } }] };
    expect(labelFromResponse(country)).toBe("Oman");
    const same = {
      features: [{ properties: { feature_type: "place", name: "Singapore", context: ctx({ place: "Singapore", country: "Singapore" }) } }],
    };
    expect(labelFromResponse(same)).toBe("Singapore");
  });
  it("caps at 120 chars and returns null for empty/malformed input", () => {
    const long = "x".repeat(200);
    const r = { features: [{ properties: { feature_type: "country", name: long } }] };
    expect(labelFromResponse(r)!.length).toBeLessThanOrEqual(120);
    expect(labelFromResponse({ features: [] })).toBeNull();
    expect(labelFromResponse(null)).toBeNull();
    expect(labelFromResponse({ features: [{}] })).toBeNull();
    expect(labelFromResponse("nope")).toBeNull();
  });
});

describe("reverseGeocode", () => {
  it("fetches with rounded coords and returns the label", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(UAE));
    const label = await reverseGeocode(24.453912345, 54.377349999, { fetchImpl });
    expect(label).toBe("Al Bateen, Abu Dhabi");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("permanent")).toBe("true");
    expect(url.searchParams.get("latitude")).toBe("24.4539");
    expect(url.searchParams.get("longitude")).toBe("54.3773");
    expectNoSensitiveLogs();
  });

  it("retries once on 429 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ message: "rate" }, 429))
      .mockResolvedValueOnce(jsonRes(PARIS));
    const label = await reverseGeocode(48.8566, 2.3522, { fetchImpl, retryDelayMs: 1 });
    expect(label).toBe("Paris, France");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("429"))).toBe(true);
    expectNoSensitiveLogs();
  });

  it("gives up after one retry on repeated 5xx", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}, 503));
    expect(await reverseGeocode(24.4539, 54.3773, { fetchImpl, retryDelayMs: 1 })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expectNoSensitiveLogs();
  });

  it("does not retry on 4xx (e.g. 401)", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ message: "Not Authorized" }, 401));
    expect(await reverseGeocode(24.4539, 54.3773, { fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expectNoSensitiveLogs();
  });

  it("times out → null (after one retry)", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const label = await reverseGeocode(24.4539, 54.3773, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
      retryDelayMs: 1,
    });
    expect(label).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expectNoSensitiveLogs();
  });

  it("uses a 5 s default timeout", async () => {
    vi.useFakeTimers();
    let aborted = 0;
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted++;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const p = reverseGeocode(24.4539, 54.3773, { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(aborted).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(1);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await p).toBeNull();
  });

  it("malformed JSON → null", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops", { status: 200 }));
    expect(await reverseGeocode(24.4539, 54.3773, { fetchImpl })).toBeNull();
    expectNoSensitiveLogs();
  });

  it("network error → retried once, then null", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await reverseGeocode(24.4539, 54.3773, { fetchImpl, retryDelayMs: 1 })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expectNoSensitiveLogs();
  });

  it("returns null without calling fetch when token missing or coords invalid", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(UAE));
    expect(await reverseGeocode(91, 0, { fetchImpl })).toBeNull();
    vi.stubEnv("MAPBOX_TOKEN", "");
    expect(await reverseGeocode(24.4539, 54.3773, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoSensitiveLogs();
  });
});

describe("reverseGeocodeMany", () => {
  it("keeps order, limits concurrency and maps failures to null", async () => {
    let inFlight = 0;
    let peak = 0;
    const geocoder: ReverseGeocoder = async (lat) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (lat === 3) throw new Error("boom");
      return lat === 5 ? null : `L${lat}`;
    };
    const centroids = Array.from({ length: 10 }, (_, i) => ({ lat: i, lng: 0 }));
    const out = await reverseGeocodeMany(centroids, { concurrency: 4, geocoder });
    expect(out).toEqual(["L0", "L1", "L2", null, "L4", null, "L6", "L7", "L8", "L9"]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(await reverseGeocodeMany([], { geocoder })).toEqual([]);
  });
});

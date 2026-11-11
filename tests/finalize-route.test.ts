import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  finalizeBook: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/photos/finalize", () => ({ finalizeBook: mocks.finalizeBook }));

const route = await import("@/app/api/books/[id]/finalize/route");
const { isSameOrigin } = await import("@/lib/auth/same-origin");

const ID = "22222222-2222-4222-8222-222222222222";
const COUNTS = {
  photos: 3,
  withDate: 2,
  withGps: 1,
  withPlace: 1,
  placesPending: 0,
  dupGroups: 0,
  dupPhotos: 0,
  pages: 3,
  wroteDoc: true,
  docStale: false,
};

function req(headers: Record<string, string> = { origin: "http://localhost:3000" }, body?: string) {
  return new NextRequest(`http://localhost:3000/api/books/${ID}/finalize`, {
    method: "POST",
    headers: { host: "localhost:3000", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}
const ORIGIN = { origin: "http://localhost:3000", "content-type": "application/json" };
const P1 = "00000000-0000-4000-8000-000000000001";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

let errors: string[];
beforeEach(() => {
  mocks.user = { id: "u1" };
  mocks.finalizeBook.mockReset();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/books/[id]/finalize", () => {
  it("exports nodejs runtime, maxDuration 60, POST only", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBe(60);
    expect(Object.keys(route)).not.toContain("GET");
  });

  it("401 without a user", async () => {
    mocks.user = null;
    const res = await route.POST(req(), ctx());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
    expect(mocks.finalizeBook).not.toHaveBeenCalled();
  });

  it("404 for an invalid id (no finalize call)", async () => {
    const res = await route.POST(req(), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(mocks.finalizeBook).not.toHaveBeenCalled();
  });

  it("404 when the book is missing / not the caller's", async () => {
    mocks.finalizeBook.mockResolvedValue(null);
    const res = await route.POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it.each([
    ["missing Origin", {}],
    ["foreign Origin", { origin: "https://evil.example" }],
    ["null Origin", { origin: "null" }],
    ["look-alike host", { origin: "http://localhost:3000.evil.example" }],
  ])("403 for %s (before auth / finalize)", async (_name, headers) => {
    const res = await route.POST(req(headers as Record<string, string>), ctx());
    expect(res.status).toBe(403);
    expect(mocks.finalizeBook).not.toHaveBeenCalled();
  });

  it("accepts the NEXT_PUBLIC_APP_URL origin and X-Forwarded-Host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://photobook.example.ae");
    const mk = (h: Record<string, string>) =>
      new Request("http://internal/api", { method: "POST", headers: h });
    expect(isSameOrigin(mk({ host: "internal", origin: "https://photobook.example.ae" }))).toBe(true);
    expect(
      isSameOrigin(mk({ host: "internal", "x-forwarded-host": "preview.vercel.app", origin: "https://preview.vercel.app" })),
    ).toBe(true);
    expect(isSameOrigin(mk({ host: "internal", origin: "https://other.example" }))).toBe(false);
  });

  it("200 with the counts JSON, no-store", async () => {
    mocks.finalizeBook.mockResolvedValue(COUNTS);
    const res = await route.POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(COUNTS);
    expect(mocks.finalizeBook).toHaveBeenCalledWith(ID, {}, { colors: undefined });
  });

  it("429 with Retry-After when finalize is rate limited", async () => {
    mocks.finalizeBook.mockResolvedValue({ rateLimited: true, retryAfterSeconds: 6 });
    const res = await route.POST(req(), ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("6");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("429 Retry-After is clamped to 1..60 s", async () => {
    mocks.finalizeBook.mockResolvedValue({ rateLimited: true, retryAfterSeconds: 0 });
    expect((await route.POST(req(), ctx())).headers.get("retry-after")).toBe("1");
    mocks.finalizeBook.mockResolvedValue({ rateLimited: true, retryAfterSeconds: 9999 });
    expect((await route.POST(req(), ctx())).headers.get("retry-after")).toBe("60");
  });

  it("500 with a generic message; logs the error code only", async () => {
    mocks.finalizeBook.mockRejectedValue(
      Object.assign(new Error(`boom at 24.45,54.37 ${ID}`), { code: "PGRST116" }),
    );
    const res = await route.POST(req(), ctx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: "server_error" });
    expect(JSON.stringify(body)).not.toContain("boom");
    expect(errors).toEqual(["[finalize] failed (PGRST116)"]);
  });

  it("passes validated photo colours to finalize (M10c)", async () => {
    mocks.finalizeBook.mockResolvedValue(COUNTS);
    const colors = { [P1]: "#8a7f72" };
    const res = await route.POST(req(ORIGIN, JSON.stringify({ colors })), ctx());
    expect(res.status).toBe(200);
    expect(mocks.finalizeBook).toHaveBeenCalledWith(ID, {}, { colors });
  });

  it("an empty body / empty object means no colours", async () => {
    mocks.finalizeBook.mockResolvedValue(COUNTS);
    expect((await route.POST(req(ORIGIN, ""), ctx())).status).toBe(200);
    expect((await route.POST(req(ORIGIN, "{}"), ctx())).status).toBe(200);
    expect(mocks.finalizeBook).toHaveBeenLastCalledWith(ID, {}, { colors: undefined });
  });

  it.each([
    ["bad hex", { colors: { [P1]: "#12345" } }],
    ["uppercase hex", { colors: { [P1]: "#ABCDEF" } }],
    ["named colour", { colors: { [P1]: "red" } }],
    ["non-uuid key", { colors: { "../x": "#123456" } }],
    ["unknown top-level key", { colors: {}, extra: 1 }],
    ["colors not an object", { colors: ["#123456"] }],
    [
      "more than 500 entries",
      {
        colors: Object.fromEntries(
          Array.from({ length: 501 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "#123456"]),
        ),
      },
    ],
  ])("400 invalid_body for %s (no finalize call)", async (_name, body) => {
    const res = await route.POST(req(ORIGIN, JSON.stringify(body)), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(mocks.finalizeBook).not.toHaveBeenCalled();
  });

  it("400 for malformed JSON, 413 for an oversized body; body never echoed or logged", async () => {
    const bad = await route.POST(req(ORIGIN, `{"colors": {"${P1}": "#8a7f72"`), ctx());
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).not.toContain(P1);
    const big = await route.POST(req(ORIGIN, JSON.stringify({ colors: { [P1]: "#8a7f72" }, pad: "x".repeat(70_000) })), ctx());
    expect(big.status).toBe(413);
    expect(mocks.finalizeBook).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("exactly 500 entries are accepted", async () => {
    mocks.finalizeBook.mockResolvedValue(COUNTS);
    const colors = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "#123456"]),
    );
    expect((await route.POST(req(ORIGIN, JSON.stringify({ colors })), ctx())).status).toBe(200);
  });
});

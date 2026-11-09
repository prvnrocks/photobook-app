import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getPhotoUrls: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/db/editor", () => ({
  getPhotoUrls: mocks.getPhotoUrls,
  EDITOR_URL_TTL_SECONDS: 3600,
  MAX_PHOTO_URL_IDS: 500,
}));

const route = await import("@/app/api/books/[id]/photo-urls/route");

const ID = "22222222-2222-4222-8222-222222222222";
const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function req(body?: unknown, headers: Record<string, string> = { origin: "http://localhost:3000" }) {
  return new NextRequest(`http://localhost:3000/api/books/${ID}/photo-urls`, {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

let errors: string[];
beforeEach(() => {
  mocks.user = { id: "u1" };
  mocks.getPhotoUrls.mockReset();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/books/[id]/photo-urls", () => {
  it("POST only, nodejs runtime", () => {
    expect(route.runtime).toBe("nodejs");
    expect(Object.keys(route)).not.toContain("GET");
  });

  it("403 cross-site / missing origin", async () => {
    expect((await route.POST(req({}, { origin: "https://evil.test" }), ctx())).status).toBe(403);
    expect((await route.POST(req({}, {}), ctx())).status).toBe(403);
    expect(mocks.getPhotoUrls).not.toHaveBeenCalled();
  });

  it("401 signed out", async () => {
    mocks.user = null;
    const res = await route.POST(req({}), ctx());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("404 for malformed id and for a book the user doesn't own", async () => {
    expect((await route.POST(req({}), ctx("x"))).status).toBe(404);
    mocks.getPhotoUrls.mockResolvedValue(null);
    const res = await route.POST(req({ ids: [pid(1)] }), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Book not found." });
  });

  it("400 for invalid bodies (bad json, non-uuid, > 500 ids, extra keys)", async () => {
    for (const body of ["{", { ids: ["nope"] }, { ids: Array.from({ length: 501 }, (_, i) => pid(i)) }, { ids: [], x: 1 }, { ids: "a" }]) {
      const res = await route.POST(req(body), ctx());
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_body" });
    }
    expect(mocks.getPhotoUrls).not.toHaveBeenCalled();
  });

  it("413 for oversized bodies", async () => {
    const res = await route.POST(req("x".repeat(40_000)), ctx());
    expect(res.status).toBe(413);
  });

  it("200 with fresh urls; empty body = all photos", async () => {
    const photos = [{ id: pid(1), webUrl: "https://w", thumbUrl: "https://t" }];
    mocks.getPhotoUrls.mockResolvedValue(photos);
    let res = await route.POST(req({ ids: [pid(1)] }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ photos, ttlSeconds: 3600 });
    expect(mocks.getPhotoUrls).toHaveBeenLastCalledWith(ID, [pid(1)]);

    res = await route.POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(mocks.getPhotoUrls).toHaveBeenLastCalledWith(ID, undefined);
  });

  it("accepts exactly 500 ids", async () => {
    mocks.getPhotoUrls.mockResolvedValue([]);
    const res = await route.POST(req({ ids: Array.from({ length: 500 }, (_, i) => pid(i)) }), ctx());
    expect(res.status).toBe(200);
  });

  it("500 with code only on errors — no stack, no paths", async () => {
    mocks.getPhotoUrls.mockRejectedValue(Object.assign(new Error("boom /u/b/p-web.jpg"), { code: "403" }));
    const res = await route.POST(req({}), ctx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "server_error", message: "Something went wrong. Please try again." });
    expect(errors).toEqual(["[photo-urls] failed (403)"]);
  });
});

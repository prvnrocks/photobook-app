// M9 T3: GET /api/cron/cleanup — auth (503 / 401 / 200), constant-time compare, middleware
// exclusion, vercel.json cron entry, CRON_SECRET read only in the route.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ runCleanup: vi.fn() }));
vi.mock("@/lib/cleanup/run", () => ({ runCleanup: mocks.runCleanup }));

const route = await import("@/app/api/cron/cleanup/route");
const { isAuthorizedCron, safeEqual } = await import("@/lib/cleanup/cron-auth");
const { config: middlewareConfig } = await import("@/middleware");

const SECRET = "cron_test_secret_0123456789";
const req = (auth?: string) =>
  new Request("http://localhost:3000/api/cron/cleanup", { headers: auth === undefined ? {} : { authorization: auth } });

const OK_COUNTS = { ok: true, complete: true, budgetSpent: false, ms: 5, sweeps: {} };

beforeEach(() => {
  mocks.runCleanup.mockReset();
  mocks.runCleanup.mockResolvedValue(OK_COUNTS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/cleanup", () => {
  it("route config: nodejs, force-dynamic, maxDuration 300 (literal)", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(300);
    const src = readFileSync(join(process.cwd(), "src/app/api/cron/cleanup/route.ts"), "utf8");
    expect(src).toMatch(/export const maxDuration = 300;/);
  });

  it("503 when CRON_SECRET is not set (never runs)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect(mocks.runCleanup).not.toHaveBeenCalled();
  });

  it.each([undefined, "", SECRET, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Basic ${SECRET}`, "Bearer "])(
    "401 for authorization %j",
    async (auth) => {
      vi.stubEnv("CRON_SECRET", SECRET);
      const res = await route.GET(req(auth));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(mocks.runCleanup).not.toHaveBeenCalled();
    },
  );

  it("200 with the counts for the right bearer; no-store", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(OK_COUNTS);
    expect(mocks.runCleanup).toHaveBeenCalledTimes(1);
  });

  it("500 with counts when a sweep failed; 500 without details when the run throws", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.runCleanup.mockResolvedValueOnce({ ...OK_COUNTS, ok: false });
    expect((await route.GET(req(`Bearer ${SECRET}`))).status).toBe(500);
    mocks.runCleanup.mockRejectedValueOnce(new Error("boom at /secret/path"));
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(JSON.stringify({ error: "cleanup_failed" }));
  });
});

describe("constant-time compare", () => {
  it("safeEqual is plain equality on any lengths", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("short", "a much longer string")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("isAuthorizedCron needs a non-empty secret and the exact header", () => {
    expect(isAuthorizedCron("Bearer ", "")).toBe(false);
    expect(isAuthorizedCron(null, "")).toBe(false);
    expect(isAuthorizedCron(null, "s")).toBe(false);
    expect(isAuthorizedCron("Bearer s", "s")).toBe(true);
  });

  it("uses crypto.timingSafeEqual (no early-exit string compare)", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/cleanup/cron-auth.ts"), "utf8");
    expect(src).toMatch(/timingSafeEqual\(digest\(a\), digest\(b\)\)/);
  });
});

describe("deployment wiring", () => {
  it("middleware skips the cron route (like the Stripe webhook)", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url });
    expect(matches("/api/cron/cleanup")).toBe(false);
    expect(matches("/api/stripe/webhook")).toBe(false);
    expect(matches("/dashboard")).toBe(true);
  });

  it("vercel.json: one daily cron at 01:00 UTC on the cleanup route, fluid kept", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
    expect(vercel.fluid).toBe(true);
    expect(vercel.crons).toEqual([{ path: "/api/cron/cleanup", schedule: "0 1 * * *" }]);
  });

  it("CRON_SECRET is read only in the cron route", () => {
    const root = process.cwd();
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(n) ? [p] : [];
      });
    const readers = walk(join(root, "src"))
      .filter((f) => /process\.env\.CRON_SECRET|process\.env\[\s*["']CRON_SECRET/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).split("\\").join("/"));
    expect(readers).toEqual(["src/app/api/cron/cleanup/route.ts"]);
  });
});

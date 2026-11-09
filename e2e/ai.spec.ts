import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Milestone 3 AI pipeline: signed-out checks at phone width. No Supabase writes, no AI calls.
// The signed-in flow lives in e2e/ai-auth.spec.ts (opt-in, E2E_AUTH=1).
test.use({ viewport: { width: 375, height: 812 } });

test.describe("AI screens redirect to /login when signed out", () => {
  for (const screen of ["review", "build"] as const) {
    test(`/books/<uuid>/${screen} -> /login?next=/books/<uuid>/${screen}`, async ({ page }) => {
      const id = randomUUID();
      await page.goto(`/books/${id}/${screen}`);
      await expect(page).toHaveURL(/\/login\?/);
      const url = new URL(page.url());
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("next")).toBe(`/books/${id}/${screen}`);
      await expect(page.getByTestId("login-next")).toHaveValue(`/books/${id}/${screen}`);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);
    });
  }

  test("/settings -> /login?next=%2Fsettings (M4)", async ({ page, request }) => {
    const res = await request.get(`/settings`, { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(res.status());
    const loc = new URL(res.headers()["location"] ?? "", "http://x.invalid");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/settings");
    expect(res.headers()["location"]).toContain("next=%2Fsettings");

    await page.goto(`/settings`);
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await expect(page.getByTestId("login-next")).toHaveValue("/settings");
    await expect(page.getByTestId("settings-memory")).toHaveCount(0);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
  });

  test("build?trigger=rebuild keeps a same-origin relative next", async ({ page }) => {
    const id = randomUUID();
    await page.goto(`/books/${id}/build?trigger=rebuild`);
    await expect(page).toHaveURL(/\/login\?/);
    const next = new URL(page.url()).searchParams.get("next") ?? "";
    expect(next.startsWith(`/books/${id}/build`)).toBe(true);
    expect(next.startsWith("//")).toBe(false);
  });
});

test.describe("admin trace page when signed out", () => {
  test("/admin/runs/<uuid> -> 404, no redirect", async ({ request }) => {
    const res = await request.get(`/admin/runs/${randomUUID()}`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers()["location"]).toBeUndefined();
  });

  test("/admin/runs/not-a-uuid -> 404", async ({ request }) => {
    const res = await request.get(`/admin/runs/not-a-uuid`, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });
});

test.describe("/api/ai/runs endpoints when signed out", () => {
  test("POST /api/ai/runs without Origin -> 403 forbidden (no-store)", async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL });
    const res = await api.post(`/api/ai/runs`, { data: { bookId: randomUUID() } });
    expect(res.status()).toBe(403);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    await api.dispose();
  });

  test("POST /api/ai/runs cross-site Origin -> 403", async ({ request }) => {
    const res = await request.post(`/api/ai/runs`, {
      headers: { origin: "https://evil.example" },
      data: { bookId: randomUUID() },
    });
    expect(res.status()).toBe(403);
  });

  test("POST /api/ai/runs same Origin, no cookie -> 401 unauthenticated", async ({ request, baseURL }) => {
    const res = await request.post(`/api/ai/runs`, {
      headers: { origin: new URL(baseURL!).origin },
      data: { bookId: randomUUID(), trigger: "build" },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  test("GET /api/ai/runs/<uuid> no cookie -> 401", async ({ request }) => {
    const res = await request.get(`/api/ai/runs/${randomUUID()}`, { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  test("POST /api/ai/runs/<uuid>/advance without Origin -> 403", async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL });
    const res = await api.post(`/api/ai/runs/${randomUUID()}/advance`);
    expect(res.status()).toBe(403);
    await api.dispose();
  });

  test("POST /api/ai/runs/<uuid>/advance same Origin, no cookie -> 401", async ({ request, baseURL }) => {
    const res = await request.post(`/api/ai/runs/${randomUUID()}/advance`, {
      headers: { origin: new URL(baseURL!).origin },
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });
});

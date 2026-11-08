import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Milestone 2 upload: signed-out checks at phone width. No Supabase writes.
// The signed-in flow lives in e2e/upload-auth.spec.ts (opt-in, E2E_AUTH=1).
test.use({ viewport: { width: 375, height: 812 } });

test.describe("upload routes redirect to /login when signed out", () => {
  test("/books/new -> /login?next=%2Fbooks%2Fnew", async ({ page }) => {
    await page.goto("/books/new");
    await expect(page).toHaveURL(/\/login\?/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/books/new");
    await expect(page.getByTestId("login-email")).toBeVisible();
  });

  test("/books/<uuid>/upload -> /login?next=/books/<uuid>/upload", async ({ page }) => {
    const id = randomUUID();
    await page.goto(`/books/${id}/upload`);
    await expect(page).toHaveURL(/\/login\?/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe(`/books/${id}/upload`);
    await expect(page.getByTestId("login-next")).toHaveValue(`/books/${id}/upload`);
  });
});

test.describe("POST /api/books/[id]/finalize when signed out", () => {
  test("no Origin header -> 403 forbidden", async ({ playwright, baseURL }) => {
    // A fresh context without extra headers; APIRequestContext sends no Origin by default.
    const api = await playwright.request.newContext({ baseURL });
    const res = await api.post(`/api/books/${randomUUID()}/finalize`);
    expect(res.status()).toBe(403);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    await api.dispose();
  });

  test("cross-site Origin -> 403 forbidden", async ({ request }) => {
    const res = await request.post(`/api/books/${randomUUID()}/finalize`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status()).toBe(403);
  });

  test("same Origin, no session cookie -> 401 unauthenticated", async ({ request, baseURL }) => {
    const res = await request.post(`/api/books/${randomUUID()}/finalize`, {
      headers: { origin: new URL(baseURL!).origin },
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  test("GET is not allowed -> 405", async ({ request }) => {
    const res = await request.get(`/api/books/${randomUUID()}/finalize`, { maxRedirects: 0 });
    expect(res.status()).toBe(405);
  });
});

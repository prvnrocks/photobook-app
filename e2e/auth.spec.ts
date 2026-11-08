import { expect, test } from "@playwright/test";

// Signed-out auth flows at phone width. Never submits the email form
// (that would send a real email via the hosted Supabase project).
test.use({ viewport: { width: 375, height: 812 } });

test.describe("protected routes redirect to /login when signed out", () => {
  test("/dashboard -> /login?next=%2Fdashboard", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.search).toContain("next=%2Fdashboard");
    await expect(page.getByTestId("login-email")).toBeVisible();
  });

  test("/books/new -> /login?next=%2Fbooks%2Fnew", async ({ page }) => {
    await page.goto("/books/new");
    await expect(page).toHaveURL(/\/login\?/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.search).toBe("?next=%2Fbooks%2Fnew");
  });
});

test.describe("/login at 375px", () => {
  test("shows email, send and Google controls with mobile-friendly sizes", async ({ page }) => {
    await page.goto("/login");
    const email = page.getByTestId("login-email");
    const send = page.getByTestId("login-send");
    const google = page.getByTestId("login-google");
    await expect(email).toBeVisible();
    await expect(send).toBeVisible();
    await expect(google).toBeVisible();

    const fontSize = await email.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16); // prevents iOS zoom on focus

    for (const btn of [send, google]) {
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
  });

  test("next=//evil.com is sanitised to /dashboard", async ({ page }) => {
    await page.goto("/login?next=//evil.com");
    await expect(page.getByTestId("login-next")).toHaveValue("/dashboard");
  });

  test("next=/books/abc is preserved", async ({ page }) => {
    await page.goto("/login?next=/books/abc");
    await expect(page.getByTestId("login-next")).toHaveValue("/books/abc");
  });

  test("error=auth shows the error banner", async ({ page }) => {
    await page.goto("/login?error=auth");
    await expect(page.getByTestId("login-error")).toBeVisible();
  });

  test("no error banner without error param", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("login-email")).toBeVisible();
    await expect(page.getByTestId("login-error")).toHaveCount(0);
  });
});

test("landing CTA goes to /login", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("cta-create").click();
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByTestId("login-email")).toBeVisible();
});

test.describe("auth callback routes fail closed", () => {
  test("/auth/callback without code -> /login?error=auth", async ({ page }) => {
    await page.goto("/auth/callback");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("auth");
    await expect(page.getByTestId("login-error")).toBeVisible();
  });

  test("/auth/confirm with bad token + evil next -> /login?error=auth", async ({ request, baseURL }) => {
    const res = await request.get("/auth/confirm?token_hash=bad&type=email&next=//evil.com", {
      maxRedirects: 0,
    });
    expect([302, 303, 307, 308]).toContain(res.status());
    const location = new URL(res.headers()["location"], baseURL);
    expect(location.origin).toBe(new URL(baseURL!).origin);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("auth");
    expect(res.headers()["location"]).not.toContain("evil.com");
  });
});

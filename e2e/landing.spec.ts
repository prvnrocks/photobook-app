import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

test.describe("landing page at 375px", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders hero, CTA and all sections", async ({ page }) => {
    await expect(page).toHaveTitle(/^Photobook — /);
    await expect(page.getByTestId("hero-heading")).toBeVisible();
    await expect(page.getByTestId("hero-heading")).toContainText("AI builds your album");
    const cta = page.getByTestId("cta-create");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("Make your book");
    await expect(cta).toHaveAttribute("href", "/login?next=%2Fbooks%2Fstart");
    for (const id of ["section-hero", "section-how", "section-pricing", "section-faq", "site-footer"]) {
      await expect(page.getByTestId(id)).toBeAttached();
    }
    await expect(page.getByTestId("section-examples")).toHaveCount(0);
    await expect(page.getByTestId("plan-paid-price")).toHaveText("AED 39");
    await expect(page.getByText("Made in Abu Dhabi")).toBeVisible();
  });

  test("has no horizontal overflow (FAQ open too)", async ({ page }) => {
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    expect(await width()).toBeLessThanOrEqual(375);
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    expect(await width()).toBeLessThanOrEqual(375);
  });

  test("FAQ opens without JS frameworks (native details)", async ({ page }) => {
    const faq = page.getByTestId("faq-after_30_days");
    await faq.locator("summary").click();
    await expect(faq).toHaveAttribute("open", "");
    await expect(faq).toContainText("deleted");
  });

  test("Arabic caption renders RTL in Cairo", async ({ page }) => {
    const ar = page.getByTestId("sample-caption-ar");
    await expect(ar).toBeVisible();
    await expect(ar).toHaveAttribute("dir", "auto");
    await expect(ar).toHaveText("أجمل الذكريات تبدأ بصورة");
    const style = await ar.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { direction: cs.direction, fontFamily: cs.fontFamily };
    });
    expect(style.direction).toBe("rtl");
    expect(style.fontFamily).toMatch(/cairo/i);
  });

  test("footer links open Privacy and Terms", async ({ page }) => {
    await page.getByTestId("footer-privacy").click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy Policy");
    await expect(page.getByTestId("legal-draft-note")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    await page.getByTestId("footer-terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terms of Service");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});

test.describe("SEO routes", () => {
  test("OG image route returns a PNG", async ({ page, request }) => {
    await page.goto("/");
    const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    expect(og).toBeTruthy();
    const res = await request.get(new URL(og!).pathname + new URL(og!).search);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    const body = await res.body();
    expect(body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  test("sitemap lists only public pages", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    expect(xml).toContain("/privacy</loc>");
    expect(xml).toContain("/terms</loc>");
    expect(xml).not.toContain("/b/");
  });

  test("login page links to Terms and Privacy", async ({ page }) => {
    await page.goto("/login");
    const legal = page.getByTestId("login-legal");
    await expect(legal.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    await expect(legal.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  });
});

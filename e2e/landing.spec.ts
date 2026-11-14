import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

test.describe("landing page at 375px", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders hero, CTA and all sections", async ({ page }) => {
    await expect(page).toHaveTitle(/^Photobook — /);
    await expect(page.getByTestId("hero-heading")).toBeVisible();
    await expect(page.getByTestId("hero-heading")).toHaveText("Your memories, in print.");
    const cta = page.getByTestId("cta-create");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("Make my book");
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

  test("bookshelf: default cover visible, arrows move the selection, no page overflow", async ({ page }) => {
    await expect(page.getByTestId("shelf-title")).toHaveText("The Day We Said Yes");
    const cover = page.getByRole("button", { name: "The Day We Said Yes" });
    await expect(cover).toHaveAttribute("aria-current", "true");
    await expect(cover).toBeInViewport();
    await page.getByTestId("shelf-next").click();
    await expect(page.getByTestId("shelf-title")).toHaveText("The Wedding");
    await expect(page.getByRole("button", { name: "The Wedding" })).toHaveAttribute("aria-current", "true");
    await page.getByTestId("shelf-prev").click();
    await page.getByTestId("shelf-prev").click();
    await expect(page.getByTestId("shelf-title")).toHaveText("First Steps");
    // tap targets on the shelf controls are at least 44 px
    for (const id of ["shelf-prev", "shelf-next", "shelf-view-sample", "shelf-filter-all", "shelf-filter-kids"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test("bookshelf: filter chips re-filter; tapping a spine selects it", async ({ page }) => {
    await page.getByTestId("shelf-filter-kids").click();
    await expect(page.getByTestId("shelf-filter-kids")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("shelf-title")).toHaveText("First Steps");
    await expect(page.getByTestId("shelf-book-the-wedding")).toHaveAttribute("aria-hidden", "true");
    await page.getByRole("button", { name: "New Beginnings" }).click();
    await expect(page.getByTestId("shelf-title")).toHaveText("New Beginnings");
    await page.getByTestId("shelf-filter-all").click();
    await expect(page.getByTestId("shelf-title")).toHaveText("New Beginnings");
  });

  test("bookshelf: clicking the selected cover opens the preview; Esc closes and returns focus", async ({ page }) => {
    const cover = page.getByRole("button", { name: "The Day We Said Yes" });
    await cover.click();
    const dialog = page.getByRole("dialog", { name: "The Day We Said Yes" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("shelf-preview-close")).toBeFocused();
    await expect(page.getByTestId("shelf-preview-cta")).toHaveAttribute("href", "/login?next=%2Fbooks%2Fstart");
    await expect(page.getByTestId("shelf-preview-cta")).toHaveText("Make a book like this");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(cover).toBeFocused();
    // View sample album opens it too; the close button closes it
    await page.getByTestId("shelf-view-sample").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("shelf-preview-close").click();
    await expect(dialog).toBeHidden();
  });

  test("bookshelf: the Arabic sample book renders its Arabic title and sample line in Cairo, RTL", async ({ page }) => {
    await page.getByTestId("shelf-filter-family").click();
    await page.getByRole("button", { name: "Family Reunion" }).click();
    await expect(page.getByTestId("shelf-title")).toHaveText("Family Reunion");
    const coverTitle = page.getByTestId("shelf-book-family-reunion").getByTestId("shelf-cover-title-ar");
    await expect(coverTitle).toHaveText("لمّة العائلة");
    await expect(coverTitle).toBeInViewport();
    await page.getByRole("button", { name: "Family Reunion" }).click();
    const dialog = page.getByRole("dialog", { name: /لمّة العائلة/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { level: 2 })).toContainText("لمّة العائلة");
    const line = page.getByTestId("sample-caption-ar");
    await expect(line).toBeVisible();
    await expect(line).toContainText("اجتمعنا");
    expect(await line.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    expect(await line.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Cairo/);
    expect(await page.evaluate(() => document.fonts.check('18px "Cairo"', "لمّة"))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test("bookshelf: keyboard arrows move selection and focus", async ({ page }) => {
    await page.getByRole("button", { name: "The Day We Said Yes" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("button", { name: "The Wedding" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("button", { name: "Our Family" })).toBeFocused();
    await expect(page.getByTestId("shelf-prev")).toBeDisabled();
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

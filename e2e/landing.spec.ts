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
    await expect(cta).toHaveAttribute("href", "/login?next=%2Fbooks%2Fnew");
    for (const id of ["section-hero", "section-marquee", "section-how", "section-pricing", "section-faq", "site-footer"]) {
      await expect(page.getByTestId(id)).toBeAttached();
    }
    await expect(page.getByTestId("section-examples")).toHaveCount(0);
    // M16: the "Pick a style to start" shelf is gone
    await expect(page.getByTestId("section-shelf")).toHaveCount(0);
    await expect(page.getByText("Pick a style to start")).toHaveCount(0);
    await expect(page.getByTestId("plan-paid-price")).toHaveText("AED 39");
    await expect(page.getByTestId("site-footer").getByText("Made in Abu Dhabi")).toBeVisible();
  });

  test("M16 hero: one h1 in Bricolage, 44 px targets, the book sits under the CTA, gold CTA", async ({ page }) => {
    await expect(page.locator("h1")).toHaveCount(1);
    const heading = page.getByTestId("hero-heading");
    expect(await heading.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Bricolage Grotesque/);
    for (const id of ["cta-create", "header-signin"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const cta = (await page.getByTestId("cta-create").boundingBox())!;
    const book = page.getByRole("img", { name: /The Day We Said Yes/ });
    await expect(book).toBeVisible();
    expect((await book.boundingBox())!.y).toBeGreaterThan(cta.y + cta.height);
    // CTA: ink #1b1b1d on gold foil #c9a227 (7.11:1); hero on deep emerald #0e3b2e with cream text
    expect(await page.getByTestId("cta-create").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color])).toEqual([
      "rgb(201, 162, 39)",
      "rgb(27, 27, 29)",
    ]);
    expect(await page.getByTestId("section-hero").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color])).toEqual([
      "rgb(14, 59, 46)",
      "rgb(242, 232, 216)",
    ]);
  });

  test("marquee: scrolls, pauses with the toggle (44 px), lists every benefit once for screen readers", async ({ page }) => {
    const marquee = page.getByTestId("section-marquee");
    const track = marquee.locator(".home-marquee-track");
    expect(await track.evaluate((el) => getComputedStyle(el).animationName)).toBe("home-marquee");
    const toggle = page.getByTestId("marquee-pause");
    const label = marquee.locator("label");
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await label.click();
    await expect(toggle).toBeChecked();
    await page.mouse.move(0, 0);
    await toggle.blur();
    expect(await track.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("paused");
    await expect(marquee.getByRole("listitem")).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test("reduced motion: marquee and gold flecks are still", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    const track = page.getByTestId("section-marquee").locator(".home-marquee-track");
    expect(await track.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    // one static copy: the 3 repeats are display:none, every benefit is visible
    await expect(page.getByTestId("section-marquee").locator('ul[aria-hidden="true"]').first()).toBeHidden();
    await expect(page.getByTestId("section-marquee").getByText("Made in Abu Dhabi").first()).toBeVisible();
    await expect(page.getByTestId("marquee-pause")).toBeHidden();
    const fleck = page.locator(".home-fleck").first();
    expect(await fleck.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
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

  test("hero Arabic card: «لمّة العائلة» renders in Lalezar, RTL, visible at 375 px", async ({ page }) => {
    const tag = page.getByTestId("hero-tag");
    await expect(tag).toBeVisible();
    await expect(tag).toContainText("Captions in Arabic or English");
    const title = page.getByTestId("hero-tag-ar");
    await expect(title).toHaveText("لمّة العائلة");
    await expect(title).toHaveAttribute("lang", "ar");
    await title.scrollIntoViewIfNeeded();
    await expect(title).toBeInViewport();
    expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^lalezar/i);
    expect(await title.locator("span[dir=auto]").evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.evaluate(() => document.fonts.check('40px "lalezar"', "لمّة"))).toBe(true);
    // the card stays inside the hero and never widens the page
    const hero = (await page.getByTestId("section-hero").boundingBox())!;
    const box = (await tag.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(hero.y + hero.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
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

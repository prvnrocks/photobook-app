import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

test.describe("landing page at 375px", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders hero, title, disabled CTA and footer", async ({ page }) => {
    await expect(page).toHaveTitle("Photobook");
    await expect(page.getByTestId("hero-heading")).toBeVisible();
    await expect(page.getByTestId("hero-heading")).toHaveText(
      "Turn your photos into a beautiful book",
    );
    await expect(page.getByRole("button", { name: "Create your book" })).toBeDisabled();
    await expect(page.getByText("Made in Abu Dhabi")).toBeVisible();
  });

  test("has no horizontal overflow", async ({ page }) => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
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

  test("English caption renders LTR with dir=auto", async ({ page }) => {
    const en = page.getByText("Golden hour on the Corniche, just the two of us.");
    await expect(en).toHaveAttribute("dir", "auto");
    expect(await en.evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
  });
});

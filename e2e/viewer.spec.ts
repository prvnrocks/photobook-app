// M6 flipbook viewer on the dev-only /dev-viewer fixture (no auth / Supabase), run against `next dev`
// like e2e/editor.spec.ts. 375 px touch (single page) + 1280 px (spread). Covers swipe, counter,
// chapter label, Contents, watermark + footer (unpaid only), Arabic, end card, pseudo-fullscreen,
// photo windowing (≤ 5 pages carry image URLs on a phone) and no horizontal overflow.
// (Replaces e2e/viewer-chrome.spec.ts from T5.)
import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
}

async function swipeLeft(page: Page) {
  // Synthetic touch swipe (right → left) on the visible page, fast enough for page-flip's swipe detection.
  const box = (await page.getByTestId("flipbook").boundingBox())!;
  await page.evaluate(
    ({ x0, x1, y }) => {
      const target = document.elementFromPoint(x0, y)!;
      const touch = (x: number) => new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
      const fire = (type: string, x: number) =>
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch(x)],
            changedTouches: [touch(x)],
          }),
        );
      fire("touchstart", x0);
      for (let i = 1; i <= 5; i++) fire("touchmove", x0 + ((x1 - x0) * i) / 5);
      fire("touchend", x1);
    },
    { x0: box.x + box.width * 0.8, x1: box.x + box.width * 0.2, y: box.y + box.height / 2 },
  );
}

async function noHorizontalOverflow(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
}

const counter = (page: Page) => page.getByTestId("page-counter");

/** Flip indexes whose page currently has at least one <img> with a real src (windowing). */
async function pagesWithImages(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const out = new Set<number>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-flip-index]"))) {
      const imgs = Array.from(el.querySelectorAll("img"));
      if (imgs.some((i) => (i.getAttribute("src") ?? "") !== "")) out.add(Number(el.dataset.flipIndex));
    }
    return [...out].sort((a, b) => a - b);
  });
}

test.describe("phone 375 (touch)", () => {
  test.use({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });

  test("counter follows swipes, chapter label changes, contents jump, end card", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=0");
    await expect(counter(page)).toHaveText("Cover");
    await noHorizontalOverflow(page);
    await swipeLeft(page);
    await expect(counter(page)).toHaveText("1 / 12");
    await expect(page.getByTestId("chapter-label")).toHaveText("Arrival · 12 Feb");

    // Chapter boundary: pages 1-4 Arrival, page 5 starts the Arabic dinner chapter.
    for (let i = 0; i < 3; i++) await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("4 / 12");
    await expect(page.getByTestId("chapter-label")).toHaveAttribute("data-chapter-id", "ch-arrival");
    await swipeLeft(page);
    await expect(counter(page)).toHaveText("5 / 12");
    const label = page.getByTestId("chapter-label");
    await expect(label).toHaveAttribute("data-chapter-id", "ch-dinner");
    const style = await label.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { direction: cs.direction, font: cs.fontFamily };
    });
    expect(style.direction).toBe("rtl");
    expect(style.font.toLowerCase()).toContain("cairo");

    // Contents jump to the desert chapter (first page 9).
    await page.getByTestId("contents-button").click();
    await page.locator('[data-testid="contents-item"][data-chapter-id="ch-desert"]').click();
    await expect(page.getByTestId("contents-sheet")).toHaveCount(0);
    await expect(counter(page)).toHaveText("9 / 12");
    await expect(page.getByTestId("chapter-label")).toContainText("Desert morning");

    // End card reachable and shown alone.
    for (let i = 0; i < 4; i++) await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("End");
    await expect(page.getByTestId("next-page")).toBeDisabled();
    await expect(page.getByTestId("end-card-cta")).toBeVisible();
    await noHorizontalOverflow(page);
  });

  test("watermark + footer only when unpaid", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=0");
    await expect(page.getByTestId("made-with-footer")).toBeVisible();
    await expect(page.getByTestId("watermark").first()).toBeVisible();
    await ready(page, "/dev-viewer?paid=1");
    await expect(page.getByTestId("made-with-footer")).toHaveCount(0);
    await expect(page.getByTestId("watermark")).toHaveCount(0);
    await noHorizontalOverflow(page);
  });

  test("copy link shows a toast; WhatsApp link is encoded", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ready(page, "/dev-viewer?paid=0");
    await page.getByTestId("share-button").click();
    const wa = await page.getByTestId("share-whatsapp").getAttribute("href");
    expect(wa).toBe(`https://wa.me/?text=${encodeURIComponent("Our Abu Dhabi trip https://example.com/b/dev-viewer")}`);
    await page.getByTestId("share-copy").click();
    await expect(page.getByTestId("share-toast")).toHaveText("Link copied");
    await noHorizontalOverflow(page);
  });

  test("pseudo-fullscreen hides controls, tap shows them", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
      Object.defineProperty(Document.prototype, "webkitFullscreenEnabled", { get: () => false });
    });
    await ready(page, "/dev-viewer?paid=0");
    await page.getByTestId("fullscreen-button").click();
    const shell = page.getByTestId("viewer-shell");
    await expect(shell).toHaveAttribute("data-fullscreen", "pseudo");
    await expect(page.getByTestId("viewer-bottom-bar")).toHaveCount(0);
    await expect(page.getByTestId("viewer-top-bar")).toHaveCount(0);
    await expect(page.getByTestId("made-with-footer")).toHaveCount(0);
    await expect(page.getByTestId("watermark").first()).toBeVisible();
    await page.getByTestId("show-controls").click();
    await expect(page.getByTestId("viewer-bottom-bar")).toBeVisible();
    await page.getByTestId("fullscreen-button").click();
    await expect(shell).toHaveAttribute("data-fullscreen", "off");
    await expect(page.getByTestId("made-with-footer")).toBeVisible();
  });

  test("Arabic book title renders RTL in Cairo", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=1&lang=ar");
    const t = page.getByTestId("viewer-title");
    await expect(t).toHaveText("رحلتنا إلى أبوظبي");
    const s = await t.evaluate((el) => ({ d: getComputedStyle(el).direction, f: getComputedStyle(el).fontFamily }));
    expect(s.d).toBe("rtl");
    expect(s.f.toLowerCase()).toContain("cairo");
    await noHorizontalOverflow(page);
  });

  test("single-page mode; only pages near the current one carry image URLs (≤ 5)", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=0");
    await expect(page.getByTestId("flipbook")).toHaveAttribute("data-spread", "false");
    expect(await page.locator("[data-testid=flipbook]").count()).toBe(1);
    const atCover = await pagesWithImages(page);
    expect(atCover.length).toBeGreaterThan(0);
    expect(atCover.length).toBeLessThanOrEqual(5);
    expect(Math.max(...atCover)).toBeLessThanOrEqual(2);
    for (let i = 0; i < 6; i++) await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("6 / 12");
    await expect.poll(async () => (await pagesWithImages(page)).includes(6)).toBe(true);
    const mid = await pagesWithImages(page);
    expect(mid.length).toBeLessThanOrEqual(5);
    expect(Math.min(...mid)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...mid)).toBeLessThanOrEqual(8);
  });

  test("two swipes forward, prev button goes back; prev disabled on the cover", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=0");
    await expect(page.getByTestId("prev-page")).toBeDisabled();
    await swipeLeft(page);
    await swipeLeft(page);
    await expect(counter(page)).toHaveText("2 / 12");
    await page.getByTestId("prev-page").click();
    await expect(counter(page)).toHaveText("1 / 12");
  });

  test("Arabic captions use dir=auto and render RTL", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=0&lang=ar");
    for (let i = 0; i < 4; i++) await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("4 / 12");
    const caps = page.locator('[data-testid="page-caption"]');
    await expect.poll(() => caps.count()).toBeGreaterThan(0);
    const info = await caps.evaluateAll((els) =>
      els.map((el) => ({ dir: el.getAttribute("dir"), d: getComputedStyle(el).direction, ar: /[\u0600-\u06FF]/.test(el.textContent ?? "") })),
    );
    expect(info.every((c) => c.dir === "auto")).toBe(true);
    const arabic = info.filter((c) => c.ar);
    expect(arabic.length).toBeGreaterThan(0);
    expect(arabic.every((c) => c.d === "rtl")).toBe(true);
    await noHorizontalOverflow(page);
  });
});

test.describe("desktop 1280 (spread)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("spread counter, keyboard, contents, end card alone", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=0");
    await expect(page.getByTestId("flipbook")).toHaveAttribute("data-spread", "true");
    await expect(counter(page)).toHaveText("Cover");
    await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("1–2 / 12");
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("3–4 / 12");
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("5–6 / 12");
    await expect(page.getByTestId("chapter-label")).toHaveAttribute("data-chapter-id", "ch-dinner");
    await page.getByTestId("contents-button").click();
    await page.locator('[data-testid="contents-item"][data-chapter-id="ch-desert"]').click();
    await expect(counter(page)).toHaveText("9–10 / 12");
    await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("11–12 / 12");
    await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("End");
    await expect(page.getByTestId("end-card-cta")).toBeVisible();
    await noHorizontalOverflow(page);
  });

  test("native fullscreen keeps the controls", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=1");
    await page.getByTestId("fullscreen-button").click();
    await expect(page.getByTestId("viewer-shell")).toHaveAttribute("data-fullscreen", /native|pseudo/);
    await expect(page.getByTestId("viewer-bottom-bar")).toBeVisible();
    await page.getByTestId("fullscreen-button").click();
    await expect(page.getByTestId("viewer-shell")).toHaveAttribute("data-fullscreen", "off");
  });

  test("unpaid spread: watermark + footer, paid: neither; no overflow", async ({ page }) => {
    await ready(page, "/dev-viewer?paid=0");
    await expect(page.getByTestId("made-with-footer")).toBeVisible();
    await expect(page.getByTestId("watermark").first()).toBeVisible();
    await noHorizontalOverflow(page);
    await ready(page, "/dev-viewer?paid=1");
    await expect(page.getByTestId("made-with-footer")).toHaveCount(0);
    await expect(page.getByTestId("watermark")).toHaveCount(0);
    await page.getByTestId("next-page").click();
    await expect(counter(page)).toHaveText("1–2 / 12");
    await noHorizontalOverflow(page);
  });
});

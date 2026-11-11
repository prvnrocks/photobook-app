import { expect, test, type Page } from "@playwright/test";

// M10b A15 — editor UI for spread layouts on the dev-only /dev-editor?sample=modern-portrait
// fixture (stubbed save, placeholder photos). Modern portrait sample (15 pages):
//   0 one-band · 1 two-panel · 2–3 spread-mosaic · 4–5 spread-panorama · 6–7 spread-grid · 8–14 singles.
// /dev-editor 404s under `next start`, so every block skips itself against production builds.

const SAMPLE = "?sample=modern-portrait";
const SHOTS = "docs/design";

const errors: string[] = [];
test.beforeAll(async ({ request }) => {
  const res = await request.get(`/dev-editor${SAMPLE}`);
  test.skip(res.status() === 404, "/dev-editor is dev-only (404 under next start)");
});
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(st);
    });
  });
});
test.afterEach(() => {
  expect(errors, "no page errors").toEqual([]);
});

const carousel = (page: Page) => page.getByTestId("page-carousel");
const cur = (page: Page) => page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
const counter = (page: Page) => page.getByTestId("page-counter");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const tileIds = (page: Page) => page.$$eval('[data-testid="pages-tile"]', (els) => els.map((e) => e.getAttribute("data-page-id")));
const spreadTiles = (page: Page) => page.locator('[data-testid="pages-tile"][data-spread="true"]');

async function settle(page: Page) {
  await expect
    .poll(
      async () => {
        const c = (await carousel(page).boundingBox())?.x ?? 0;
        const x1 = (await cur(page).boundingBox())?.x ?? 999;
        await page.waitForTimeout(100);
        const x2 = (await cur(page).boundingBox())?.x ?? 999;
        return Math.abs(x1 - x2) < 1 && Math.abs(x2 - c) < 2;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
}

async function open(page: Page, mode: "single" | "spread") {
  await page.goto(`/dev-editor${SAMPLE}`);
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(carousel(page)).toHaveAttribute("data-mode", mode);
  await expect(counter(page)).toContainText("Cover");
  await settle(page);
}

/** Phone: step the single-page carousel until the counter reads "<n> / …" (n = 1-based page). */
async function goToPage(page: Page, n: number) {
  const at = async () => {
    const t = (await counter(page).innerText()).trim();
    return t.startsWith("Cover") ? 0 : Number(t.split("/")[0].trim());
  };
  for (let i = 0; i < 30 && (await at()) !== n; i++) {
    const was = await at();
    await page.getByTestId(was < n ? "carousel-next" : "carousel-prev").click();
    await expect.poll(at).not.toBe(was);
    await settle(page);
  }
  expect(await at()).toBe(n);
}

async function waitSaved(page: Page) {
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
}

test.describe("open book at 1024 × 768", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("apply a spread layout on a left page; either half selects the whole spread", async ({ page }) => {
    await open(page, "spread");
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("1–2 / 15");
    await settle(page);
    const spread = cur(page).getByTestId("editor-spread");
    await expect(spread).not.toHaveAttribute("data-spread-layout", "true");

    // Select a photo on the left page → Layout.
    await cur(page).locator('[data-testid="spread-page"][data-side="left"] [data-testid="slot-target"]').first().click();
    await page.getByTestId("editor-tool-layout").click();
    const picker = page.getByTestId("layout-picker");
    await expect(picker).toBeVisible();
    // Only modern portrait layouts; spreads grouped and enabled on a left page.
    await expect(picker.locator('[data-layout-id^="c-"], [data-layout-id="full-page"], [data-layout-id^="m-l-"]')).toHaveCount(0);
    const spreads = page.getByTestId("layout-spreads").getByTestId("layout-option");
    await expect(spreads).toHaveCount(3);
    for (const b of await spreads.all()) await expect(b).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/m10b-editor-1024-picker.png` });

    await page.locator('[data-testid="layout-option"][data-layout-id="m-p-spread-grid"]').click();
    await expect(spread).toHaveAttribute("data-spread-layout", "true");
    await expect(counter(page)).toHaveText("1–2 / 15");

    // A slot on the RIGHT half is editable (owned by the left page) and selects the spread.
    const rightSlot = cur(page).locator('[data-testid="spread-page"][data-side="right"] [data-testid="slot-target"]').first();
    await rightSlot.click();
    await expect(rightSlot).toHaveAttribute("data-selected", "true");
    await expect(spread).toHaveAttribute("data-spread-active", "true");
    await expect(cur(page).locator('[data-testid="spread-page"][data-active="true"]')).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/m10b-editor-1024-spread-selected.png` });
    await waitSaved(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("drag a spread tile in the Pages sheet: the pair moves as one unit", async ({ page }) => {
    await open(page, "spread");
    await page.getByTestId("editor-tool-pages").click();
    await expect(page.getByTestId("pages-sheet")).toBeVisible();
    const before = await tileIds(page);
    expect(before.slice(0, 5)).toEqual(["s0", "s1", "s2", "s4", "s6"]);
    await expect(spreadTiles(page)).toHaveCount(3);

    const src = page.locator('[data-testid="pages-tile"][data-page-id="s2"] [data-testid="pages-thumb"]');
    const dst = page.locator('[data-testid="pages-tile"][data-page-id="s4"] [data-testid="pages-thumb"]');
    // Both tiles on screen (else dnd-kit auto-scrolls the panel under the pointer).
    await src.evaluate((el) => el.scrollIntoView({ block: "start" }));
    const a = (await src.boundingBox())!;
    const b = (await dst.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + ((b.y + b.height / 2 - (a.y + a.height / 2)) * i) / 12);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await expect.poll(async () => (await tileIds(page)).slice(0, 5)).toEqual(["s0", "s1", "s4", "s2", "s6"]);
    await expect(spreadTiles(page)).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/m10b-editor-1024-pages.png` });
    await waitSaved(page);
  });
});

test.describe("phone at 375 px", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("right page: spread layouts shown disabled with 'Starts on a left page'", async ({ page }) => {
    await open(page, "single");
    await goToPage(page, 2);
    await page.getByTestId("editor-tool-layout").click();
    const group = page.getByTestId("layout-spreads");
    await expect(group).toBeVisible();
    const opts = group.getByTestId("layout-option");
    await expect(opts).toHaveCount(3);
    for (const b of await opts.all()) {
      await expect(b).toBeDisabled();
      await expect(b).toContainText("Starts on a left page");
    }
    // Single layouts stay available.
    await expect(page.locator('[data-testid="layout-option"][data-role="page"]').first()).toBeEnabled();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await group.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/m10b-editor-375-picker-right-page.png` });
  });

  test("right half of a spread: its slots are editable without leaving the page", async ({ page }) => {
    await open(page, "single");
    await goToPage(page, 4); // right half of the mosaic
    const slot = cur(page).getByTestId("slot-target").first();
    await slot.click();
    await expect(slot).toHaveAttribute("data-selected", "true");
    await expect(counter(page)).toHaveText("4 / 15");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("delete a spread from either half: confirm, both pages go, Undo restores", async ({ page }) => {
    await open(page, "single");
    await goToPage(page, 4);
    await page.getByTestId("editor-tool-page-menu").click();
    await expect(page.getByTestId("page-menu-delete")).toHaveText(/Delete pages 3–4/);
    await page.getByTestId("page-menu-delete").click();
    const confirm = page.getByTestId("page-menu-confirm");
    await expect(confirm).toContainText("Delete this 2-page spread?");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/m10b-editor-375-delete-spread.png` });
    await page.getByTestId("page-menu-confirm-delete").click();
    await expect(counter(page)).toHaveText(/\/ 13$/);
    await expect(page.getByTestId("editor-toast")).toContainText("Pages 3–4 deleted");
    await page.getByTestId("editor-toast-action").click();
    await expect(counter(page)).toHaveText("3 / 15");
    await waitSaved(page);
  });

  test("cancel keeps the spread", async ({ page }) => {
    await open(page, "single");
    await goToPage(page, 3);
    await page.getByTestId("editor-tool-page-menu").click();
    await page.getByTestId("page-menu-delete").click();
    await page.getByTestId("page-menu-confirm-cancel").click();
    await expect(page.getByTestId("page-menu")).toBeVisible();
    await expect(counter(page)).toHaveText("3 / 15");
  });

  test("insert a page before a spread → spread split + Undo restores it", async ({ page }) => {
    await open(page, "single");
    await goToPage(page, 2);
    await page.getByTestId("editor-tool-add-page").click();
    await expect(counter(page)).toHaveText("3 / 16");
    const toast = page.getByTestId("editor-toast");
    await expect(toast).toContainText(/split/);
    await expect(page.getByTestId("editor-toast-action")).toHaveText("Undo");
    await page.screenshot({ path: `${SHOTS}/m10b-editor-375-split-toast.png` });
    await page.getByTestId("editor-toast-action").click();
    await expect(counter(page)).toHaveText(/\/ 15$/);

    await page.getByTestId("editor-tool-pages").click();
    await expect(page.getByTestId("pages-sheet")).toBeVisible();
    await expect(spreadTiles(page)).toHaveCount(3);
    expect((await tileIds(page)).slice(0, 5)).toEqual(["s0", "s1", "s2", "s4", "s6"]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/m10b-editor-375-pages.png` });
  });

  test("View spread sheet shows a spread's two halves", async ({ page }) => {
    await open(page, "single");
    await goToPage(page, 3);
    await page.getByTestId("view-spread").click();
    await expect(page.getByTestId("spread-preview-counter")).toHaveText("3–4 / 15");
    const shown = page.locator('[data-testid="spread-preview-item"][aria-hidden="false"]');
    await expect(shown.getByTestId("spread-preview-page")).toHaveCount(2);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

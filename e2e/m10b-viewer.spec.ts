// M10b A13 — spreads in the flipbook viewer, on the dev-only /dev-viewer?sample= fixtures (no auth /
// Supabase; run against `next dev` like e2e/viewer.spec.ts). Modern portrait + modern landscape
// sample books (src/lib/book/dev-sample.ts: spreads on even indices, text panels, sliced cover).
//   - 1280 px (two-page mode): pages are whole pixels and touch at the fold; both halves of the
//     panorama place the ONE photo box at the same spot; pixel check — no 1 px line at the fold
//     that isn't image (a seam at 999 px landscape before the fix); landscape 210:148
//   - 375 px (single page): each spread half is its own page (right half = the left page's photo,
//     correct crop), counter counts pages; no horizontal overflow anywhere
// Screenshots m10b-viewer-<sample>-<width>[-left|-right].png go to the test output folder, or to
// M10B_SHOT_DIR when set (docs/design holds the committed set).
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";

type Sample = "modern-portrait" | "modern-landscape";
const SAMPLES: Array<{ sample: Sample; ratio: number; pages: number }> = [
  { sample: "modern-portrait", ratio: 148 / 210, pages: 15 },
  { sample: "modern-landscape", ratio: 210 / 148, pages: 16 },
];
// Doc pages 4–5 are the panorama spread in both samples → flip indexes 5 (left) and 6 (right).
const PANO_LEFT = 5;

const shotPath = (info: TestInfo, name: string) =>
  process.env.M10B_SHOT_DIR ? path.join(process.env.M10B_SHOT_DIR, name) : info.outputPath(name);

async function ready(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

async function noHorizontalOverflow(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
}

/** Next button until page-flip reports `index` as current (spread: the pair's left index). */
async function flipTo(page: Page, index: number) {
  const book = page.getByTestId("flipbook");
  for (let i = 0; i < 30; i++) {
    const cur = Number(await book.getAttribute("data-current-page"));
    if (cur >= index) break;
    await page.getByTestId("next-page").click();
    await expect(book).not.toHaveAttribute("data-current-page", String(cur));
  }
  await expect(book).toHaveAttribute("data-current-page", String(index));
  await page.waitForTimeout(700); // flip animation settles
}

const rectOf = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

/** All visible book <img>s have decoded (no broken / pending photo). */
async function imagesLoaded(page: Page, sel: string) {
  await expect
    .poll(() => page.locator(`${sel} img`).evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
}

/**
 * Seam detector at the fold: share of rows where one of the columns next to the fold (x−1, x, x+1
 * in device px) differs from BOTH its neighbours while those neighbours agree — a 1 px line that
 * doesn't belong to the image (a gap showing the stage, or a misaligned half). Image detail that
 * crosses the fold (text, edges) makes neighbours disagree and doesn't count. The pre-fix seam at
 * 999 px landscape hit ~100 % of rows.
 */
async function foldSeamRows(page: Page, foldX: number, top: number, height: number): Promise<number> {
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const x0 = Math.floor(foldX) - 10;
  const clip = { x: x0, y: Math.ceil(top + 4), width: 20, height: Math.floor(height - 8) };
  const { data, info } = await sharp(await page.screenshot({ clip })).raw().toBuffer({ resolveWithObject: true });
  const f = Math.round((foldX - x0) * dpr);
  const px = (x: number, y: number) => {
    const o = (y * info.width + x) * info.channels;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const diff = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  let seamRows = 0;
  for (let y = 0; y < info.height; y++) {
    const line = [f - 1, f, f + 1].some((x) => {
      const m = px(x - 1, y);
      const c = px(x, y);
      const q = px(x + 1, y);
      return diff(c, m) > 24 && diff(c, q) > 24 && diff(m, q) < 24;
    });
    if (line) seamRows++;
  }
  return seamRows / info.height;
}

for (const { sample, ratio, pages } of SAMPLES) {
  test.describe(`${sample}`, () => {
    test("1280 two-page mode: panorama halves meet at the fold, no seam, correct ratio", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await ready(page, `/dev-viewer?paid=1&sample=${sample}`);
      await expect(page.getByTestId("flipbook")).toHaveAttribute("data-spread", "true");
      await noHorizontalOverflow(page);
      await flipTo(page, PANO_LEFT);
      await expect(page.getByTestId("page-counter")).toHaveText(`${PANO_LEFT}–${PANO_LEFT + 1} / ${pages}`);

      const L = `[data-flip-index="${PANO_LEFT}"]`;
      const R = `[data-flip-index="${PANO_LEFT + 1}"]`;
      await expect(page.locator(`${R} [data-spread-side="right"]`)).toHaveCount(1);
      await imagesLoaded(page, L);
      await imagesLoaded(page, R);
      const l = await rectOf(page, L);
      const r = await rectOf(page, R);
      // Whole-pixel pages that touch at the fold, same height, the book format's ratio.
      expect(Number.isInteger(l.width)).toBe(true);
      expect(r.width).toBe(l.width);
      expect(r.x).toBeCloseTo(l.x + l.width, 3);
      expect(r.y).toBeCloseTo(l.y, 3);
      expect(l.width / l.height).toBeCloseTo(ratio, 2);
      // One photo box across both halves: same viewport position from either page.
      const li = await rectOf(page, `${L} img`);
      const ri = await rectOf(page, `${R} img`);
      expect(Math.abs(li.x - ri.x)).toBeLessThan(0.1);
      expect(Math.abs(li.width - ri.width)).toBeLessThan(0.1);
      expect(Math.abs(li.y - ri.y)).toBeLessThan(0.1);

      expect(await foldSeamRows(page, r.x, l.y, l.height)).toBeLessThan(0.05);
      await page.screenshot({ path: shotPath(test.info(), `m10b-viewer-${sample}-1280.png`) });
    });

    test("odd widths: pages stay whole pixels, no seam at the fold", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await ready(page, `/dev-viewer?paid=1&sample=${sample}`);
      await flipTo(page, PANO_LEFT);
      for (const [w, h] of [[999, 777], [1281, 801], [793, 700]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(300);
        const l = await rectOf(page, `[data-flip-index="${PANO_LEFT}"]`);
        const r = await rectOf(page, `[data-flip-index="${PANO_LEFT + 1}"]`);
        expect(Number.isInteger(l.width), `${w}: ${l.width}`).toBe(true);
        expect(r.x).toBeCloseTo(l.x + l.width, 3);
        expect(await foldSeamRows(page, r.x, l.y, l.height), `${w}×${h}`).toBeLessThan(0.05);
        await noHorizontalOverflow(page);
      }
    });

    test("375 single-page mode: each spread half is its own page", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 740 });
      await ready(page, `/dev-viewer?paid=1&sample=${sample}`);
      await expect(page.getByTestId("flipbook")).toHaveAttribute("data-spread", "false");
      await noHorizontalOverflow(page);

      await flipTo(page, PANO_LEFT);
      await expect(page.getByTestId("page-counter")).toHaveText(`${PANO_LEFT} / ${pages}`);
      const L = `[data-flip-index="${PANO_LEFT}"]`;
      await expect(page.locator(`${L} [data-spread-side="left"]`)).toHaveCount(1);
      await imagesLoaded(page, L);
      const l = await rectOf(page, L);
      expect(l.width / l.height).toBeCloseTo(ratio, 2);
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x + l.width).toBeLessThanOrEqual(375);
      // The photo box spans two page widths starting at this page's left edge (left half).
      const li = await rectOf(page, `${L} img`);
      expect(li.width).toBeGreaterThan(l.width * 1.5);
      await page.screenshot({ path: shotPath(test.info(), `m10b-viewer-${sample}-375-left.png`) });

      await flipTo(page, PANO_LEFT + 1);
      await expect(page.getByTestId("page-counter")).toHaveText(`${PANO_LEFT + 1} / ${pages}`);
      const R = `[data-flip-index="${PANO_LEFT + 1}"]`;
      await expect(page.locator(`${R} [data-spread-side="right"]`)).toHaveCount(1);
      await imagesLoaded(page, R);
      const r = await rectOf(page, R);
      const ri = await rectOf(page, `${R} img`);
      // Right half: the same photo box shifted one page left (its right part shows here).
      expect(ri.x + ri.width).toBeCloseTo(li.x + li.width - l.width + (r.x - l.x), 0);
      expect(ri.width).toBeCloseTo(li.width, 1);
      await noHorizontalOverflow(page);
      await page.screenshot({ path: shotPath(test.info(), `m10b-viewer-${sample}-375-right.png`) });
    });
  });
}

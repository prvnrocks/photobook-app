// Task 7 — representative visual regression of COMPOSED storybooks (dev fixtures, no sign-in, no DB,
// no AI): each template family × 2 styles × 2 formats + an Arabic book, screenshotted page by page
// from /dev-story-compose (404 in production → runs against `next dev`). Also asserts that no text
// panel of those books overflows (the sheet-probe method: distinct line tops × line-height).
// Photos are inline SVG placeholders, so the screenshots are the same on every machine.
//
//   npx playwright test e2e/task7-story-compose.spec.ts --workers=1
//   (against another server: TASK7_BASE=http://localhost:3971 …; update: --update-snapshots)
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.TASK7_BASE ?? "";
const FAMILIES = ["chapter_opening", "hero", "collage", "storytelling", "closing"] as const;
const BOOKS = [
  { style: "modern", format: "portrait" },
  { style: "modern", format: "landscape" },
  { style: "magazine", format: "portrait" },
  { style: "magazine", format: "landscape" },
] as const;

test.use({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });

async function open(page: Page, query: string) {
  await page.goto(`${BASE}/dev-story-compose?${query}`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    document.querySelectorAll("nextjs-portal").forEach((e) => e.remove());
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  });
}

async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-text-panel] p, [data-caption-area] p")].flatMap((p) => {
      const box = p.parentElement!;
      const cs = getComputedStyle(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      const turned = !!p.closest("[data-text-turn]");
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(turned ? r.left : r.top))).size;
      const need = lines * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const over = need > box.clientHeight + 0.5 || (p as HTMLElement).scrollWidth > box.clientWidth + 1;
      return over ? [`${p.closest("[data-layout]")?.getAttribute("data-layout") ?? "cover"}`] : [];
    }),
  );
}

for (const b of BOOKS) {
  test(`${b.style} ${b.format}: one page per family, no text overflow`, async ({ page }) => {
    await open(page, `style=${b.style}&format=${b.format}&photos=24`);
    expect(await overflowing(page)).toEqual([]);
    for (const family of FAMILIES) {
      const fig = page.locator(`figure[data-family="${family}"]`).first();
      await expect(fig, family).toBeVisible();
      await expect(fig).toHaveScreenshot(`${b.style}-${b.format}-${family}.png`, { maxDiffPixelRatio: 0.01 });
    }
  });
}

test("Arabic editorial portrait: chapter opening + storytelling, RTL text, no overflow", async ({ page }) => {
  await open(page, "style=editorial&format=portrait&photos=24&lang=ar");
  expect(await overflowing(page)).toEqual([]);
  await expect(page.locator('[data-text-panel="pageText"] p[lang="ar"]').first()).toBeVisible();
  for (const family of ["chapter_opening", "storytelling"] as const) {
    await expect(page.locator(`figure[data-family="${family}"]`).first()).toHaveScreenshot(`editorial-portrait-ar-${family}.png`, { maxDiffPixelRatio: 0.01 });
  }
});

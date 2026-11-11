import { expect, test, type Locator, type Page } from "@playwright/test";
import { paintOrder, pointInSlot, slotAt, type Point } from "../src/lib/book/slot-geometry";
import type { Layout } from "../src/lib/book/types";
import { getLayout } from "../src/lib/layouts";

// M10c T14 — editor on shaped / tilted / framed slots, on the dev-only /dev-editor samples
// (stubbed save, placeholder photos):
//   scrapbook-portrait: 0 s-p-one-polaroid · 1 s-p-two-overlap · 2–3 spread-hero · …
//   geometric-portrait: 0 g-p-one-band · 1 g-p-two-diag · 2–3 spread-band · 4 g-p-two-circle · …
// Points come from the same slot geometry the app uses (slotAt / pointInSlot), mapped onto the
// rendered page box. /dev-editor 404s under `next start`, so every block skips itself there.

const SHOTS = "docs/design";

const errors: string[] = [];
test.beforeAll(async ({ request }) => {
  const res = await request.get("/dev-editor?sample=scrapbook-portrait");
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
const target = (page: Page, i: number) => cur(page).locator(`[data-slot-index="${i}"] [data-testid="slot-target"]`);

function layout(id: string): Layout {
  const l = getLayout(id);
  if (!l) throw new Error(`missing layout ${id}`);
  return l;
}

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

async function open(page: Page, sample: string) {
  await page.goto(`/dev-editor?sample=${sample}`);
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(counter(page)).toContainText("Cover");
  await settle(page);
}

/** Step the carousel until the counter reads "<n> / …" (n = 1-based page). */
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

/** Layout point (% of the page) → client point on the rendered page `frame`. */
async function clientOf(frame: Locator, pt: Point): Promise<{ x: number; y: number }> {
  const b = (await frame.boundingBox())!;
  return { x: b.x + (pt.x / 100) * b.width, y: b.y + (pt.y / 100) * b.height };
}

/** A point inside both slots' shapes (sampled over their bounding-box overlap). */
function overlapPoint(l: Layout, a: number, b: number): Point {
  const sa = l.slots[a];
  const sb = l.slots[b];
  for (let x = Math.max(sa.x, sb.x) - 10; x <= Math.min(sa.x + sa.w, sb.x + sb.w) + 10; x += 0.5)
    for (let y = Math.max(sa.y, sb.y) - 10; y <= Math.min(sa.y + sa.h, sb.y + sb.h) + 10; y += 0.5)
      if (pointInSlot(l, a, { x, y }) && pointInSlot(l, b, { x, y })) return { x, y };
  throw new Error(`slots ${a} and ${b} of ${l.id} don't overlap`);
}

/** Centre of the region where slot i is the visible top slot (well inside it). */
function visiblePoint(l: Layout, i: number): Point {
  const s = l.slots[i];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let x = s.x - 10; x <= s.x + s.w + 10; x += 0.5)
    for (let y = s.y - 10; y <= s.y + s.h + 10; y += 0.5)
      if (slotAt(l, { x, y }) === i) {
        sx += x;
        sy += y;
        n++;
      }
  const c = { x: sx / n, y: sy / n };
  if (slotAt(l, c) !== i) throw new Error(`no clear visible centre for slot ${i} of ${l.id}`);
  return c;
}

/** A point in both slots' bounding boxes that only one slot's SHAPE covers; returns that slot. */
function bboxOverlapShapeHit(l: Layout, a: number, b: number): { pt: Point; hit: number } {
  const sa = l.slots[a];
  const sb = l.slots[b];
  for (let x = Math.max(sa.x, sb.x); x <= Math.min(sa.x + sa.w, sb.x + sb.w); x += 0.5)
    for (let y = Math.max(sa.y, sb.y); y <= Math.min(sa.y + sa.h, sb.y + sb.h); y += 0.5) {
      const inA = pointInSlot(l, a, { x, y });
      const inB = pointInSlot(l, b, { x, y });
      // Clear of the edges: 1 % away still inside the same slot only.
      if (inA !== inB && slotAt(l, { x: x + 1, y }) === slotAt(l, { x, y }) && slotAt(l, { x: x - 1, y }) === slotAt(l, { x, y }))
        return { pt: { x, y }, hit: inA ? a : b };
    }
  throw new Error(`no bbox-only overlap for ${l.id}`);
}

test.describe("phone at 375 px (touch)", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("scrapbook: tap where tilted polaroids overlap selects the visible top one", async ({ page }) => {
    await open(page, "scrapbook-portrait");
    await goToPage(page, 2);
    const l = layout("s-p-two-overlap");
    const frame = cur(page).locator('[data-page="1"]');
    await expect(frame).toHaveAttribute("data-layout", l.id);
    const [bottom, top] = paintOrder(l);
    const p = await clientOf(frame, overlapPoint(l, bottom, top));

    // Shadows / decorations never take the tap.
    const hitEl = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? { testid: el.getAttribute("data-testid"), deco: !!el.closest("[data-decoration],[data-slot-shadow]") } : null;
    }, p);
    expect(hitEl?.deco).toBe(false);

    await page.touchscreen.tap(p.x, p.y);
    await expect(target(page, top)).toHaveAttribute("data-selected", "true");
    await expect(target(page, bottom)).not.toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("editor-tool-crop")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/m10c-editor-375-selected-polaroid.png` });

    // Tap the lower photo where only it shows → it is selected instead.
    const q = await clientOf(frame, visiblePoint(l, bottom));
    await page.touchscreen.tap(q.x, q.y);
    await expect(target(page, bottom)).toHaveAttribute("data-selected", "true");
    await expect(target(page, top)).not.toHaveAttribute("data-selected", "true");
  });

  test("scrapbook: layout picker diagrams draw tilt + polaroid frames, options ≥ 44 px", async ({ page }) => {
    await open(page, "scrapbook-portrait");
    await goToPage(page, 2);
    await page.getByTestId("editor-tool-layout").click();
    const picker = page.getByTestId("layout-picker");
    await expect(picker).toBeVisible();
    const opt = picker.locator('[data-testid="layout-option"][data-layout-id="s-p-two-overlap"]');
    await expect(opt.locator("[data-diagram-shaped]")).toHaveCount(2);
    for (const b of await picker.getByTestId("layout-option").all()) {
      const box = (await b.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("geometric: where diagonal boxes overlap, the tap selects the slot whose shape is there", async ({ page }) => {
    await open(page, "geometric-portrait");
    await goToPage(page, 2);
    const l = layout("g-p-two-diag");
    const frame = cur(page).locator('[data-page="1"]');
    await expect(frame).toHaveAttribute("data-layout", l.id);
    const { pt, hit } = bboxOverlapShapeHit(l, 0, 1);
    const p = await clientOf(frame, pt);
    await page.touchscreen.tap(p.x, p.y);
    await expect(target(page, hit)).toHaveAttribute("data-selected", "true");
    await expect(target(page, 1 - hit)).not.toHaveAttribute("data-selected", "true");
    // Polygon slots draw their outline as an SVG of the shape.
    await expect(target(page, hit).getByTestId("slot-outline")).toBeVisible();
  });

  test("geometric: crop on a circle slot shows the round mask and saves", async ({ page }) => {
    await open(page, "geometric-portrait");
    await goToPage(page, 5);
    const l = layout("g-p-two-circle");
    const frame = cur(page).locator('[data-page="4"]');
    await expect(frame).toHaveAttribute("data-layout", l.id);
    const ci = l.slots.findIndex((s) => s.shape?.kind === "circle");
    expect(ci).toBeGreaterThanOrEqual(0);
    const img = () => cur(page).locator(`[data-slot-index="${ci}"] img`).first();
    const before = await img().getAttribute("style");
    const s = l.slots[ci];
    const c = await clientOf(frame, { x: s.x + s.w / 2, y: s.y + s.h / 2 });
    await page.touchscreen.tap(c.x, c.y);
    await expect(target(page, ci)).toHaveAttribute("data-selected", "true");
    await page.getByTestId("editor-tool-crop").click();
    const area = page.getByTestId("crop-area");
    await expect(area).toBeVisible();
    await expect(page.getByTestId("crop-mask")).toHaveAttribute("data-shape", "ellipse");
    // Square crop box for a circle (the unrotated photo rect).
    const box = (await area.boundingBox())!;
    expect(Math.abs(box.width - box.height)).toBeLessThan(2);
    await page.getByTestId("crop-zoom").fill("2");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2 - i * 5, box.y + box.height / 2 + i * 3);
    await page.mouse.up();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/m10c-editor-375-crop-circle.png` });
    const cropStyle = await page.getByTestId("crop-image").getAttribute("style");
    await page.getByTestId("crop-done").click();
    await expect(page.getByTestId("editor-panel-crop")).toHaveCount(0);
    const after = await img().getAttribute("style");
    expect(after).not.toBe(before);
    const pct = (v: string | null) => (v?.match(/(left|top|width|height):\s*[-\d.]+%/g) ?? []).join(";");
    expect(pct(after)).toBe(pct(cropStyle));
    await waitSaved(page);
  });
});

test.describe("375 px with a mouse", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("scrapbook: drag a photo onto the tilted top polaroid swaps the two", async ({ page }) => {
    await open(page, "scrapbook-portrait");
    await goToPage(page, 2);
    const l = layout("s-p-two-overlap");
    const frame = cur(page).locator('[data-page="1"]');
    const [bottom, top] = paintOrder(l);
    expect(l.slots[top].rotate).toBeTruthy();
    const src = (i: number) => cur(page).locator(`[data-slot-index="${i}"] img`).first().getAttribute("src");
    const a0 = await src(bottom);
    const b0 = await src(top);
    expect(a0).not.toBe(b0);

    const from = await clientOf(frame, visiblePoint(l, bottom));
    // Drop where both polaroids' boxes overlap: the visible (top, tilted) one must be the target.
    const to = await clientOf(frame, overlapPoint(l, bottom, top));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
      await page.waitForTimeout(30);
    }
    await expect(target(page, top)).toHaveAttribute("data-drop-target", "true");
    await expect(page.getByTestId("slot-drag-preview")).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => src(top)).toBe(a0);
    await expect.poll(() => src(bottom)).toBe(b0);
    await expect(target(page, top)).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("slot-drag-preview")).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await waitSaved(page);
  });
});

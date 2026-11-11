import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// Milestone 5 editor.
// 1. Signed-out guards (any server): no Supabase writes, no AI calls.
// 2. Editor UI at 375 px on the dev-only /dev-editor fixture (stubbed save, placeholder photos).
//    /dev-editor 404s under `next start`, so that block skips itself against production builds;
//    the default playwright.config runs `npm run dev`, where it runs.
// The live signed-in flow is e2e/editor-auth.spec.ts (opt-in, E2E_AUTH=1).

const W = 375;
test.use({ viewport: { width: W, height: 812 } });

test.describe("editor routes when signed out", () => {
  test("/books/<uuid>/edit -> /login?next=/books/<uuid>/edit", async ({ page, request }) => {
    const id = randomUUID();
    const res = await request.get(`/books/${id}/edit`, { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(res.status());
    const loc = new URL(res.headers()["location"] ?? "", "http://x.invalid");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe(`/books/${id}/edit`);

    await page.goto(`/books/${id}/edit`);
    await expect(page).toHaveURL(/\/login\?/);
    await expect(page.getByTestId("login-next")).toHaveValue(`/books/${id}/edit`);
    await expect(page.getByTestId("editor-shell")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W);
  });

  test("/books/not-a-uuid/edit signed out still goes to login (no 500)", async ({ request }) => {
    const res = await request.get(`/books/not-a-uuid/edit`, { maxRedirects: 0 });
    expect([302, 303, 307, 308, 404]).toContain(res.status());
  });

  const docBody = () => ({ doc: { version: 1 }, baseRev: 1 });

  test("PUT /api/books/<uuid>/doc without Origin -> 403 forbidden (no-store)", async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL });
    const res = await api.put(`/api/books/${randomUUID()}/doc`, { data: docBody() });
    expect(res.status()).toBe(403);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    await api.dispose();
  });

  test("PUT /api/books/<uuid>/doc cross-site Origin -> 403", async ({ request }) => {
    const res = await request.put(`/api/books/${randomUUID()}/doc`, {
      headers: { origin: "https://evil.example" },
      data: docBody(),
    });
    expect(res.status()).toBe(403);
  });

  test("PUT /api/books/<uuid>/doc same Origin, no cookie -> 401 unauthenticated", async ({ request, baseURL }) => {
    const res = await request.put(`/api/books/${randomUUID()}/doc`, {
      headers: { origin: new URL(baseURL!).origin },
      data: docBody(),
    });
    expect(res.status()).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  test("POST /api/books/<uuid>/photo-urls: no Origin 403, cross-site 403, same Origin no cookie 401", async ({ playwright, request, baseURL }) => {
    const id = randomUUID();
    const api = await playwright.request.newContext({ baseURL });
    const noOrigin = await api.post(`/api/books/${id}/photo-urls`, { data: {} });
    expect(noOrigin.status()).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ error: "forbidden" });
    await api.dispose();

    const cross = await request.post(`/api/books/${id}/photo-urls`, { headers: { origin: "https://evil.example" }, data: {} });
    expect(cross.status()).toBe(403);

    const res = await request.post(`/api/books/${id}/photo-urls`, { headers: { origin: new URL(baseURL!).origin }, data: {} });
    expect(res.status()).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  test("POST /api/ai/rewrite: no Origin 403, cross-site 403, same Origin no cookie 401", async ({ playwright, request, baseURL }) => {
    const body = { bookId: randomUUID(), pageId: "p1", instruction: "rewrite", text: "Sunset walk" };
    const api = await playwright.request.newContext({ baseURL });
    const noOrigin = await api.post(`/api/ai/rewrite`, { data: body });
    expect(noOrigin.status()).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ error: "forbidden" });
    await api.dispose();

    const cross = await request.post(`/api/ai/rewrite`, { headers: { origin: "https://evil.example" }, data: body });
    expect(cross.status()).toBe(403);

    const res = await request.post(`/api/ai/rewrite`, { headers: { origin: new URL(baseURL!).origin }, data: body });
    expect(res.status()).toBe(401);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });
});

// ---------------------------------------------------------------------------------------------
// /dev-editor fixture (dev server only)
// Fixture pages: 1 full-page (low-res crop) · 2 one-portrait · 3 two-vertical (slot 2 empty) ·
// 4 two-horizontal · 5 three-mixed · 6 four-grid. d14/d15 = AI-dropped. ?pages=20 → 20 pages, 3 chapters.
// ---------------------------------------------------------------------------------------------

test.describe("editor UI at 375 px (/dev-editor)", () => {
  test.use({ viewport: { width: W, height: 812 }, hasTouch: true, isMobile: true });

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`/dev-editor`);
    test.skip(res.status() === 404, "/dev-editor is dev-only (404 under next start)");
  });

  const errors: string[] = [];
  test.beforeEach(async ({ page }) => {
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(String(e)));
    // Hide the Next.js dev overlay badge (it can sit over the toolbar).
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

  const cur = (page: Page) => page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
  const counter = (page: Page) => page.getByTestId("page-counter");
  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  async function expectNoOverflow(page: Page, label: string) {
    expect(await overflow(page), `horizontal overflow: ${label}`).toBeLessThanOrEqual(0);
  }
  async function open(page: Page, query = "") {
    await page.goto(`/dev-editor${query}`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(counter(page)).toContainText("Cover");
    await settle(page);
  }
  async function itemOf(page: Page): Promise<number> {
    const t = (await counter(page).innerText()).trim();
    return t.startsWith("Cover") ? 0 : Number(t.split("/")[0].trim());
  }
  /** Wait until the scroll-snap carousel rests on the current slide (left edge at x≈0, not moving). */
  async function settle(page: Page) {
    await expect
      .poll(
        async () => {
          const x1 = (await cur(page).boundingBox())?.x ?? 999;
          await page.waitForTimeout(100);
          const x2 = (await cur(page).boundingBox())?.x ?? 999;
          return Math.abs(x1 - x2) < 1 && Math.abs(x2) < 2;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  }
  async function goToItem(page: Page, n: number) {
    for (let i = 0; i < 30 && (await itemOf(page)) !== n; i++) {
      const at = await itemOf(page);
      await page.getByTestId(at < n ? "carousel-next" : "carousel-prev").click();
      await expect.poll(() => itemOf(page)).not.toBe(at);
      await settle(page);
    }
    expect(await itemOf(page)).toBe(n);
  }
  async function waitSaved(page: Page) {
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    await expect(page.getByTestId("save-status")).toContainText("Saved ✓");
  }
  /** Touch swipe on the carousel (CDP synthesized gesture; native scroll-snap does the rest). */
  async function swipe(page: Page, dir: "left" | "right") {
    const box = (await page.getByTestId("page-carousel").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      xDistance: dir === "left" ? -220 : 220,
      yDistance: 0,
      gestureSourceType: "touch",
      speed: 1200,
    });
    await cdp.detach();
    await settle(page);
  }

  test("swipe between pages; counter follows; no overflow", async ({ page }) => {
    await open(page);
    await expectNoOverflow(page, "cover");
    await swipe(page, "left");
    await expect(counter(page)).toHaveText(/^1 \/ 6$/);
    await swipe(page, "left");
    await expect(counter(page)).toHaveText(/^2 \/ 6$/);
    await swipe(page, "right");
    await expect(counter(page)).toHaveText(/^1 \/ 6$/);
    await page.getByTestId("carousel-prev").click();
    await expect(counter(page)).toContainText("Cover");
    await expectNoOverflow(page, "after swipes");
  });

  test("edit an Arabic caption inline → RTL + Cairo, dir=auto, Saved ✓", async ({ page }) => {
    await open(page);
    await goToItem(page, 2);
    await cur(page).getByTestId("caption-target").click();
    const input = page.getByTestId("caption-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("dir", "auto");
    await input.fill("");
    await input.pressSequentially("غروب الشمس على الكورنيش", { delay: 5 });
    const onPage = cur(page).getByTestId("page-caption");
    await expect(onPage).toHaveText("غروب الشمس على الكورنيش");
    const st = await onPage.evaluate((el) => ({ dir: el.getAttribute("dir"), cdir: getComputedStyle(el).direction }));
    expect(st.dir).toBe("auto");
    expect(st.cdir).toBe("rtl");
    await expect(input).toHaveAttribute("lang", "ar");
    await waitSaved(page);
    await expectNoOverflow(page, "caption sheet");
    // Arabic font is available (Cairo or Tajawal).
    expect(await page.evaluate(() => document.fonts.check('16px "Cairo"') || document.fonts.check('16px "Tajawal"'))).toBe(true);
  });

  test("replace an empty slot with an AI-dropped photo → placed + Saved ✓", async ({ page }) => {
    await open(page);
    await goToItem(page, 3);
    await cur(page).locator('[data-slot-index="1"] [data-testid="slot-target"]').click();
    await page.getByTestId("editor-tool-replace").click();
    await expect(page.getByTestId("editor-panel-replace")).toBeVisible();
    await expectNoOverflow(page, "photo picker");
    await page.getByTestId("picker-tab-dropped").click();
    await page.locator('[data-testid="picker-photo"][data-photo-id="d14"]').click();
    await expect(page.getByTestId("editor-panel-replace")).toHaveCount(0);
    const src = await cur(page).locator('[data-slot-index="1"] img').first().getAttribute("src");
    expect(decodeURIComponent(src ?? "")).toContain("d14 ");
    await waitSaved(page);
  });

  test("layout change re-flows photos; toast Undo restores the layout", async ({ page }) => {
    await open(page);
    await goToItem(page, 6);
    await expect(cur(page).locator("[data-layout]").first()).toHaveAttribute("data-layout", "four-grid");
    await cur(page).locator('[data-slot-index="0"] [data-testid="slot-target"]').click();
    await page.getByTestId("editor-tool-layout").click();
    await expect(page.getByTestId("editor-panel-layout")).toBeVisible();
    await expectNoOverflow(page, "layout picker");
    await page.locator('[data-testid="layout-option"][data-layout-id="full-page"]').click();
    await expect(cur(page).locator("[data-layout]").first()).toHaveAttribute("data-layout", "full-page");
    const toast = page.getByTestId("editor-toast");
    await expect(toast).toContainText("3 photos moved to Not used");
    await expectNoOverflow(page, "toast");
    await page.getByTestId("editor-toast-action").click();
    await expect(cur(page).locator("[data-layout]").first()).toHaveAttribute("data-layout", "four-grid");
    await expect(page.getByTestId("editor-toast")).toHaveCount(0);
    await waitSaved(page);
  });

  test("pan + zoom crop persists on the page after leaving and coming back", async ({ page }) => {
    await open(page);
    await goToItem(page, 2);
    const img = () => cur(page).locator('[data-slot-index="0"] img').first();
    const before = await img().getAttribute("style");
    await cur(page).locator('[data-slot-index="0"] [data-testid="slot-target"]').click();
    await page.getByTestId("editor-tool-crop").click();
    const area = page.getByTestId("crop-area");
    await expect(area).toBeVisible();
    await expectNoOverflow(page, "crop");
    const box = (await area.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 - i * 6, box.y + box.height / 2);
    await page.mouse.up();
    await page.getByTestId("crop-zoom").fill("2");
    const cropStyle = await page.getByTestId("crop-image").getAttribute("style");
    await page.getByTestId("crop-done").click();
    await expect(page.getByTestId("editor-panel-crop")).toHaveCount(0);
    const after = await img().getAttribute("style");
    expect(after).not.toBe(before);
    const pct = (s: string | null) => (s?.match(/(left|top|width|height):\s*[-\d.]+%/g) ?? []).join(";");
    expect(pct(after)).toBe(pct(cropStyle));
    await waitSaved(page);
    await goToItem(page, 4);
    await goToItem(page, 2);
    expect(pct(await img().getAttribute("style"))).toBe(pct(after));
  });

  test("reorder pages with the move buttons (Pages sheet) → Saved ✓", async ({ page }) => {
    await open(page, "?pages=20");
    await expect(counter(page)).toContainText("20 pages");
    await page.getByTestId("editor-tool-pages").click();
    await expect(page.getByTestId("pages-sheet")).toBeVisible();
    await expectNoOverflow(page, "pages sheet");
    const order = () => page.$$eval('[data-testid="pages-tile"]', (els) => els.map((e) => e.getAttribute("data-page-id")));
    const o1 = await order();
    expect(o1).toHaveLength(20);
    await page.getByTestId("pages-move-later").first().click();
    await expect.poll(order).toEqual([o1[1], o1[0], ...o1.slice(2)]);
    await waitSaved(page);
    await page.getByTestId("pages-move-earlier").nth(1).click();
    await expect.poll(order).toEqual(o1);
  });

  test("delete a page + Undo lands on the restored page", async ({ page }) => {
    await open(page, "?pages=20");
    await page.getByTestId("editor-tool-pages").click();
    const order = () => page.$$eval('[data-testid="pages-tile"]', (els) => els.map((e) => e.getAttribute("data-page-id")));
    const o1 = await order();
    await page.getByTestId("pages-thumb").nth(3).click();
    await expect(counter(page)).toHaveText("4 / 20");
    await page.getByTestId("editor-tool-page-menu").click();
    await expect(page.getByTestId("page-menu")).toBeVisible();
    await expectNoOverflow(page, "page menu");
    await page.getByTestId("page-menu-delete").click();
    await expect(counter(page)).toHaveText(/\/ 19$/);
    await expect(page.getByTestId("editor-toast")).toContainText("Page 4 deleted");
    await page.getByTestId("editor-toast-action").click();
    await expect(counter(page)).toHaveText("4 / 20");
    await page.getByTestId("editor-tool-pages").click();
    await expect.poll(order).toEqual(o1);
    await waitSaved(page);
  });

  test("delete the LAST page → header Undo lands on the restored page (T14 bug 3)", async ({ page }) => {
    await open(page);
    await goToItem(page, 6);
    await page.getByTestId("editor-tool-page-menu").click();
    await page.getByTestId("page-menu-delete").click();
    await expect(counter(page)).toHaveText("5 / 5");
    await page.getByTestId("editor-undo").click();
    await expect(counter(page)).toHaveText("6 / 6");
    await settle(page);
    await expect(cur(page).locator("[data-layout]").first()).toHaveAttribute("data-layout", "four-grid");
    await page.getByTestId("editor-redo").click();
    await expect(counter(page)).toHaveText("5 / 5");
  });

  test("rapid Next taps (< 150 ms apart) are all counted (T14 bug 2)", async ({ page }) => {
    await open(page);
    const next = page.getByTestId("carousel-next");
    for (let i = 0; i < 4; i++) {
      await next.click();
      await page.waitForTimeout(60);
    }
    await expect(counter(page)).toHaveText("4 / 6");
    await settle(page);
    await expect(counter(page)).toHaveText("4 / 6");
    await expect(cur(page)).toHaveAttribute("aria-label", "Page 4 of 6");
    // And back.
    const prev = page.getByTestId("carousel-prev");
    for (let i = 0; i < 3; i++) {
      await prev.click();
      await page.waitForTimeout(60);
    }
    await settle(page);
    await expect(counter(page)).toHaveText("1 / 6");
    // A swipe still works after programmatic scrolling.
    await swipe(page, "left");
    await expect(counter(page)).toHaveText("2 / 6");
  });

  test("free book at 20 pages: Add page opens the Upgrade sheet, no page 21", async ({ page }) => {
    await open(page, "?pages=20");
    await goToItem(page, 20);
    await page.getByTestId("editor-tool-add-page").click();
    await expect(page.getByTestId("upgrade-sheet")).toBeVisible();
    // M7: live when the dev server has Stripe keys, else disabled + "Payments unavailable".
    const btn = page.getByTestId("upgrade-button");
    await expect(btn).toHaveText("Upgrade this book — AED 39");
    const on = (await page.getByTestId("upgrade-button-wrap").getAttribute("data-payments")) === "on";
    if (process.env.E2E_PAYMENTS === "1") expect(on).toBe(true);
    if (process.env.E2E_PAYMENTS === "0") expect(on).toBe(false);
    if (on) {
      await expect(btn).toBeEnabled();
      await expect(page.getByTestId("upgrade-button-unavailable")).toHaveCount(0);
    } else {
      await expect(btn).toBeDisabled();
      await expect(page.getByTestId("upgrade-button-unavailable")).toHaveText("Payments unavailable");
    }
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(counter(page)).toHaveText("20 / 20");
    await expectNoOverflow(page, "upgrade sheet");
    await page.getByTestId("editor-panel-close").click();
    await expect(page.getByTestId("upgrade-sheet")).toHaveCount(0);
  });

  test("paid book: PDF tool (no Upgrade) → sheet → saves first, then downloads (API mocked)", async ({ page }) => {
    const calls: string[] = [];
    await page.route("**/api/books/*/pdf**", (route) => {
      calls.push(route.request().method());
      return route.request().method() === "POST"
        ? route.fulfill({ status: 202, json: { status: "rendering", exportId: "e9" } })
        : route.fulfill({
            json: { status: "ready", exportId: "e9", url: "/__pdf-mock/book.pdf", filename: "book.pdf", bytes: 1_200_000, pageCount: 7 },
          });
    });
    await page.route("**/__pdf-mock/**", (route) =>
      route.fulfill({ headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="book.pdf"' }, body: "%PDF-1.7\n" }),
    );
    await open(page, "?paid=1");
    await expect(page.getByTestId("editor-tool-upgrade")).toHaveCount(0);
    const tool = page.getByTestId("editor-tool-pdf");
    await expect(tool).toBeVisible();
    await tool.click();
    await expect(page.getByTestId("pdf-panel")).toBeVisible();
    const btn = page.getByTestId("pdf-download");
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoOverflow(page, "pdf sheet");
    const download = page.waitForEvent("download");
    await btn.click();
    await expect(page.getByTestId("pdf-status")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    expect((await download).suggestedFilename()).toBe("book.pdf");
    await expect(page.getByTestId("pdf-ready-detail")).toHaveText("1.1 MB · 7 pages");
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expectNoOverflow(page, "pdf ready");
    expect(calls).toEqual(["POST", "GET"]);
    // Free book: no PDF tool.
    await open(page);
    await expect(page.getByTestId("editor-tool-pdf")).toHaveCount(0);
  });

  test("?upgrade=cancelled: floating 'Payment cancelled' notice, param removed, dismissible", async ({ page }) => {
    await page.goto("/dev-editor?upgrade=cancelled");
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    const notice = page.getByTestId("upgrade-cancelled");
    await expect(notice).toContainText("Payment cancelled");
    await expect(page).toHaveURL(/\/dev-editor$/);
    await expectNoOverflow(page, "cancelled notice");
    await page.getByTestId("upgrade-cancelled-dismiss").click();
    await expect(notice).toHaveCount(0);
  });

  test("Add page below the limit inserts after the current page", async ({ page }) => {
    await open(page);
    await goToItem(page, 2);
    await page.getByTestId("editor-tool-add-page").click();
    await expect(counter(page)).toHaveText("3 / 7");
    await waitSaved(page);
  });

  async function openAiMenu(page: Page, query: string) {
    await open(page, query);
    await goToItem(page, 2);
    await cur(page).getByTestId("caption-target").click();
    await page.getByTestId("caption-open-ai").click();
    await expect(page.getByTestId("ai-caption-menu")).toBeVisible();
  }

  test("✨ AI off: menu explains, options disabled", async ({ page }) => {
    await openAiMenu(page, "?ai=off");
    await expect(page.getByTestId("ai-caption-blocked")).toContainText("AI captions aren't switched on yet");
    await expect(page.getByTestId("ai-option-rewrite")).toBeDisabled();
    await expectNoOverflow(page, "✨ off");
  });

  test("✨ limit: message + Upgrade opens the Upgrade sheet", async ({ page }) => {
    await openAiMenu(page, "?ai=limit");
    await expect(page.getByTestId("ai-caption-limit")).toContainText("No AI rewrites left");
    await page.getByTestId("ai-upgrade").click();
    await expect(page.getByTestId("upgrade-sheet")).toBeVisible();
    await expectNoOverflow(page, "✨ limit");
  });

  test("✨ mocked success: preview → Use this → caption replaced + Saved ✓ → undo", async ({ page }) => {
    let posted: Record<string, unknown> | null = null;
    await page.route("**/api/ai/rewrite", async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "Sunset over the Corniche, just us two.", lang: "en", remaining: 17 }),
      });
    });
    await openAiMenu(page, "?ai=replay");
    const original = await cur(page).getByTestId("page-caption").innerText();
    await page.getByTestId("ai-option-shorter").click();
    await expect(page.getByTestId("ai-preview")).toContainText("Sunset over the Corniche");
    await expect(page.getByTestId("ai-rewrites-left")).toContainText("17");
    expect(posted).toMatchObject({ instruction: "shorter" });
    expect(posted).not.toHaveProperty("targetLang");
    await expectNoOverflow(page, "✨ preview");
    await page.getByTestId("ai-use-this").click();
    await expect(cur(page).getByTestId("page-caption")).toHaveText("Sunset over the Corniche, just us two.");
    await waitSaved(page);
    await page.getByTestId("editor-panel-close").click();
    await page.getByTestId("editor-undo").click();
    await expect(cur(page).getByTestId("page-caption")).toHaveText(original);
  });

  for (const [status, body, copy] of [
    [409, { error: "already_running" }, "One rewrite at a time"],
    [502, { error: "rewrite_unusable", retryable: false }, "Couldn't improve this one"],
    [502, { error: "refusal", retryable: false }, "Can't rewrite this caption"],
    [502, { error: "timeout", retryable: true }, "Try again"],
    [400, { error: "too_short" }, "This caption is already short"],
  ] as const) {
    test(`✨ mocked ${status} ${body.error} → "${copy}"`, async ({ page }) => {
      await page.route("**/api/ai/rewrite", (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
      await openAiMenu(page, "?ai=replay");
      const before = await cur(page).getByTestId("page-caption").innerText();
      await page.getByTestId("ai-option-rewrite").click();
      await expect(page.getByTestId("ai-caption-message")).toContainText(copy);
      await expect(cur(page).getByTestId("page-caption")).toHaveText(before);
    });
  }

  // Session-wide failures switch ✨ off like AI off: blocked copy, every option disabled.
  for (const [status, body, copy] of [
    [503, { error: "ai_off" }, "AI captions aren't switched on yet"],
    [503, { error: "ai_unavailable" }, "AI captions aren't available right now"],
    [502, { error: "auth", retryable: false }, "AI captions aren't available right now — try later"],
    [502, { error: "bad_request", retryable: false }, "AI captions aren't available right now — try later"],
    [429, { error: "daily_limit" }, "You've reached today's AI rewrite limit — try again tomorrow"],
  ] as const) {
    test(`✨ mocked ${status} ${body.error} → ✨ off: "${copy}"`, async ({ page }) => {
      let calls = 0;
      await page.route("**/api/ai/rewrite", (r) => {
        calls++;
        return r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      await openAiMenu(page, "?ai=replay");
      await page.getByTestId("ai-option-rewrite").click();
      await expect(page.getByTestId("ai-caption-blocked")).toContainText(copy);
      await expect(page.getByTestId("ai-option-rewrite")).toBeDisabled();
      await expect(page.getByTestId("ai-upgrade")).toHaveCount(0);
      // Still off after closing and reopening the menu.
      await page.getByTestId("editor-panel-close").click();
      await page.getByTestId("editor-tool-ai-caption").click();
      await expect(page.getByTestId("ai-caption-blocked")).toContainText(copy);
      expect(calls).toBe(1);
    });
  }

  test("✨ Shorter is disabled for a caption of ≤ 3 words", async ({ page }) => {
    await open(page, "?ai=replay");
    await goToItem(page, 2);
    await cur(page).getByTestId("caption-target").click();
    await page.getByTestId("caption-input").fill("Eid mubarak");
    await page.getByTestId("caption-open-ai").click();
    await expect(page.getByTestId("ai-option-shorter")).toBeDisabled();
    await expect(page.getByTestId("ai-option-rewrite")).toBeEnabled();
    await expect(page.getByTestId("ai-shorter-hint")).toContainText("This caption is already short");
  });

  test("caption sheet is docked under the page: the caption being edited stays visible", async ({ page }) => {
    await open(page);
    await goToItem(page, 2);
    await cur(page).getByTestId("caption-target").click();
    const panel = page.getByTestId("editor-panel-caption");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-docked", "true");
    await settle(page);
    await page.getByTestId("caption-input").fill("Still visible while typing");
    const cap = cur(page).getByTestId("page-caption");
    await expect(cap).toHaveText("Still visible while typing");
    await expect
      .poll(async () => {
        const c = (await cap.boundingBox())!;
        const p = (await panel.boundingBox())!;
        return c.y >= 0 && c.y + c.height <= p.y + 1;
      })
      .toBe(true);
    await expectNoOverflow(page, "docked caption sheet");
    // M11 T14: Replace docks under the page too (the spot being filled stays visible); Crop keeps the sheet.
    await page.getByTestId("editor-panel-close").click();
    await cur(page).locator('[data-slot-index="0"] [data-testid="slot-target"]').click();
    await page.getByTestId("editor-tool-replace").click();
    await expect(page.getByTestId("editor-panel-replace")).toHaveAttribute("data-docked", "true");
    await page.getByTestId("editor-panel-close").click();
    await page.getByTestId("editor-tool-crop").click();
    await expect(page.getByTestId("editor-panel-crop")).toHaveAttribute("data-docked", "false");
  });

  test("M11: Layout picker docks under the page — page stays visible, options ≥ 44 px; coach line once", async ({ page }) => {
    await open(page);
    // One-time coach line: in the toolbar flow (never over the page), dismissible, remembered.
    const coach = page.getByTestId("editor-coach");
    await expect(coach).toContainText("Tap a photo to swap, crop or change its layout");
    const cov = (await cur(page).boundingBox())!;
    const cb = (await coach.boundingBox())!;
    expect(cb.y).toBeGreaterThanOrEqual(cov.y + cov.height - 1);
    await page.getByTestId("editor-coach-dismiss").click();
    await expect(coach).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(page.getByTestId("editor-toolbar")).toBeVisible();
    await expect(coach).toHaveCount(0);
    await settle(page);

    await goToItem(page, 2);
    await page.getByTestId("editor-tool-layout").click();
    const panel = page.getByTestId("editor-panel-layout");
    await expect(panel).toHaveAttribute("data-docked", "true");
    await expect(page.getByTestId("editor-tool-layout")).toHaveAttribute("aria-pressed", "true");
    const pageEl = cur(page).locator("[data-page]").first();
    await expect
      .poll(async () => {
        const pg = (await pageEl.boundingBox())!;
        const pn = (await panel.boundingBox())!;
        return pg.height > 120 && pg.y >= 0 && pg.y + pg.height <= pn.y + 1;
      })
      .toBe(true);
    const pn = (await panel.boundingBox())!;
    expect(pn.height).toBeLessThanOrEqual(812 * 0.42 + 1);
    for (const o of await page.getByTestId("layout-option").all()) {
      const b = await o.boundingBox();
      if (!b) continue;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoOverflow(page, "docked layout picker");
  });

  async function editCoverTitle(page: Page, title: string) {
    await page.getByTestId("cover-text-target").click();
    await page.getByTestId("cover-title-input").fill(title);
  }

  test("cover title edit (Arabic) → header + cover update, Saved ✓", async ({ page }) => {
    await open(page);
    await editCoverTitle(page, "سارة و عمر");
    await expect(page.getByTestId("cover-title").first()).toHaveText("سارة و عمر");
    await expect(page.getByTestId("editor-title")).toHaveText("سارة و عمر");
    await waitSaved(page);
    await expectNoOverflow(page, "cover text sheet");
  });

  const banners: [string, string, string][] = [
    ["conflict", "save-banner-conflict", "Changed in another tab"],
    ["unavailable", "save-banner-unavailable", "Saving unavailable"],
    ["invalid", "save-banner-invalid", "Not saved"],
    ["offline", "", "Offline – retrying"],
  ];
  for (const [mode, banner, label] of banners) {
    test(`?save=${mode}: edit → "${label}"${banner ? " + banner" : ""}`, async ({ page }) => {
      await open(page, `?save=${mode}`);
      await editCoverTitle(page, "New title");
      await expect(page.getByTestId("save-status")).toContainText(label, { timeout: 10_000 });
      if (banner) await expect(page.getByTestId(banner)).toBeVisible();
      await expectNoOverflow(page, `banner ${mode}`);
    });
  }

  test("?save=readonly: banner on load, no editing tools, undo disabled", async ({ page }) => {
    await open(page, "?save=readonly");
    await expect(page.getByTestId("save-banner-readOnly")).toBeVisible();
    await expect(page.getByTestId("editor-tool-add-page")).toHaveCount(0);
    await expect(page.getByTestId("editor-undo")).toBeDisabled();
    await expectNoOverflow(page, "read-only");
  });

  test("no horizontal overflow on every sheet (chaptered 20-page book)", async ({ page }) => {
    await open(page, "?pages=20&ai=replay");
    // cover sheet
    await page.getByTestId("cover-text-target").click();
    await expect(page.getByTestId("editor-panel-cover-text")).toBeVisible();
    await expectNoOverflow(page, "cover-text");
    await page.getByTestId("editor-panel-close").click();
    // find a page with a caption
    let found = false;
    for (let n = 1; n <= 20 && !found; n++) {
      await goToItem(page, n);
      found = (await cur(page).getByTestId("caption-target").count()) > 0;
    }
    expect(found).toBe(true);
    await cur(page).getByTestId("caption-target").click();
    await expect(page.getByTestId("caption-input")).toBeVisible();
    await expectNoOverflow(page, "caption");
    // Close the open panel between tools (sheets have a backdrop over the toolbar); the selection stays.
    for (const tool of ["ai-caption", "caption-style", "chapter"]) {
      await page.getByTestId("editor-panel-close").click();
      const btn = page.getByTestId(`editor-tool-${tool}`);
      await expect(btn, `toolbar shows ${tool} for a caption`).toBeVisible();
      await btn.click();
      await expect(page.getByTestId(`editor-panel-${tool}`)).toBeVisible();
      await expectNoOverflow(page, tool);
    }
    await page.getByTestId("editor-panel-close").click();
    for (const tool of ["replace", "crop", "layout", "pages", "page-menu"]) {
      if (await page.getByTestId("editor-panel-close").isVisible()) await page.getByTestId("editor-panel-close").click();
      const slot = cur(page).locator('[data-slot-index="0"] [data-testid="slot-target"]');
      // A second tap on a selected slot deselects it — only tap when not selected.
      const selected = (await slot.getAttribute("data-selected")) === "true";
      // Slot tools need the slot selected; page tools (Pages / Page menu) show with no selection.
      if ((tool === "replace" || tool === "crop") && !selected) await slot.click();
      if ((tool === "pages" || tool === "page-menu") && selected) await slot.click();
      await page.getByTestId(`editor-tool-${tool}`).click();
      await expect(page.getByTestId(`editor-panel-${tool}`)).toBeVisible();
      await expectNoOverflow(page, tool);
      if (tool === "crop") await page.getByTestId("crop-done").click();
      else await page.getByTestId("editor-panel-close").click();
    }
  });

  test("caption fonts Inter / Playfair / Cairo / Tajawal + alignment apply to the page", async ({ page }) => {
    await open(page);
    await goToItem(page, 2);
    await cur(page).getByTestId("caption-target").click();
    await page.getByTestId("caption-open-style").click();
    const cap = cur(page).getByTestId("page-caption");
    for (const f of ["Inter", "Playfair", "Cairo", "Tajawal"]) {
      await page.getByTestId(`font-${f}`).click();
      await expect.poll(() => cap.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(f === "Playfair" ? "Playfair" : f);
    }
    await page.getByTestId("align-right").click();
    await expect.poll(() => cap.evaluate((el) => getComputedStyle(el).textAlign)).toBe("right");
    await waitSaved(page);
    await expectNoOverflow(page, "font picker");
  });

  test("low-resolution warning on a zoomed slot explains, never blocks", async ({ page }) => {
    await open(page);
    await goToItem(page, 1);
    const badge = cur(page).getByTestId("low-res-badge").first();
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(cur(page).getByTestId("low-res-message")).toContainText("blurry when printed");
    // Still editable: the slot tools work.
    await cur(page).locator('[data-slot-index="0"] [data-testid="slot-target"]').click();
    await expect(page.getByTestId("editor-tool-replace")).toBeVisible();
  });

  test("Move to chapter appends the page to that chapter; toast Undo", async ({ page }) => {
    await open(page, "?pages=20");
    await goToItem(page, 4);
    await page.getByTestId("editor-tool-page-menu").click();
    await expect(page.getByTestId("page-menu")).toBeVisible();
    await page.getByTestId("page-menu-chapter").last().click();
    await expect(counter(page)).toHaveText("20 / 20");
    await expect(page.getByTestId("editor-toast")).toContainText("The party");
    await page.getByTestId("editor-toast-action").click();
    await expect(page.getByTestId("editor-toast")).toHaveCount(0);
    await waitSaved(page);
  });

  test("Done saves pending edits, then leaves the editor", async ({ page }) => {
    await open(page, "?ai=off");
    await editCoverTitle(page, "Done test");
    await page.getByTestId("editor-panel-close").click();
    await page.getByTestId("editor-done").click();
    // dev fixture has no finish action → after saving it navigates to backHref (/dev-editor).
    await expect(page).toHaveURL(/\/dev-editor$/);
    await expect(page.getByTestId("editor-done-error")).toHaveCount(0);
  });

  test("Done while offline stays and explains", async ({ page }) => {
    await open(page, "?save=offline");
    await editCoverTitle(page, "Offline");
    await page.getByTestId("editor-panel-close").click();
    await page.getByTestId("editor-done").click();
    await expect(page.getByTestId("editor-done-error")).toContainText("couldn't save", { timeout: 15_000 });
    await expect(page).toHaveURL(/save=offline/);
  });
});

// ---------------------------------------------------------------------------------------------
// M10a A9: facing-pages editor. ≥ md shows the open book (cover alone, then pages [1,2], [3,4],
// … like the flipbook); phones keep one page + a read-only "View spread" sheet.
// ---------------------------------------------------------------------------------------------

test.describe("facing pages (/dev-editor)", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get(`/dev-editor`);
    test.skip(res.status() === 404, "/dev-editor is dev-only (404 under next start)");
  });

  const errors: string[] = [];
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
  const side = (page: Page, s: "left" | "right") => cur(page).locator(`[data-testid="spread-page"][data-side="${s}"]`);
  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  /** The current slide rests flush with the carousel's left edge. */
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

  async function openSpread(page: Page, query = "") {
    await page.goto(`/dev-editor${query}`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(carousel(page)).toHaveAttribute("data-mode", "spread");
    await expect(counter(page)).toContainText("Cover");
    await settle(page);
  }

  test.describe("at 1024 × 768", () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test("cover alone, then two pages side by side; arrows + keys move by spread", async ({ page }) => {
      await openSpread(page);
      await expect(cur(page).getByTestId("editor-spread")).toHaveAttribute("data-kind", "cover");
      await expect(cur(page).getByTestId("spread-page")).toHaveCount(0);
      await expect(page.getByTestId("view-spread")).toHaveCount(0);

      await page.getByTestId("carousel-next").click();
      await expect(counter(page)).toHaveText("1–2 / 6");
      await settle(page);
      const l = (await side(page, "left").boundingBox())!;
      const r = (await side(page, "right").boundingBox())!;
      expect(Math.abs(l.y - r.y)).toBeLessThan(1);
      expect(Math.abs(l.x + l.width - r.x)).toBeLessThan(1); // touching at the fold
      expect(Math.abs(l.width - r.width)).toBeLessThan(1);
      const c = (await carousel(page).boundingBox())!;
      expect(l.x).toBeGreaterThanOrEqual(c.x);
      expect(r.x + r.width).toBeLessThanOrEqual(c.x + c.width + 1);
      await expect(cur(page).getByTestId("spread-fold")).toHaveCount(1);
      await expect(side(page, "left")).toHaveAttribute("data-active", "true");

      await page.getByTestId("carousel-next").click();
      await expect(counter(page)).toHaveText("3–4 / 6");
      await page.keyboard.press("ArrowRight");
      await expect(counter(page)).toHaveText("5–6 / 6");
      await expect(page.getByTestId("carousel-next")).toBeDisabled();
      await page.keyboard.press("ArrowLeft");
      await expect(counter(page)).toHaveText("3–4 / 6");
      await page.getByTestId("carousel-prev").click();
      await page.getByTestId("carousel-prev").click();
      await expect(counter(page)).toContainText("Cover");
      await settle(page);
      await expect(cur(page).getByTestId("editor-spread")).toHaveAttribute("data-kind", "cover");
      // Strip groups thumbnails like the book opens.
      await expect(page.getByTestId("page-strip")).toHaveAttribute("data-mode", "spread");
      await expect(page.getByTestId("strip-spread")).toHaveCount(4);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test("tap the right page's caption → the edit lands on the right page", async ({ page }) => {
      await openSpread(page);
      await page.getByTestId("carousel-next").click();
      await expect(counter(page)).toHaveText("1–2 / 6");
      await settle(page);
      const left = side(page, "left");
      const right = side(page, "right");
      await expect(right).toHaveAttribute("data-page-idx", "1");
      const leftBefore = await left.innerHTML();

      // A slot tap on the right page makes it current (tools act on it)…
      await right.locator('[data-slot-index="0"] [data-testid="slot-target"]').click();
      await expect(right).toHaveAttribute("data-active", "true");
      await expect(left).toHaveAttribute("data-active", "false");
      await page.getByTestId("editor-tool-dev-panel").click();
      await expect(page.getByTestId("editor-panel-dev-panel")).toContainText("Page: 1 · selection: slot");
      await page.getByTestId("editor-panel-close").click();

      // …and so does a caption tap.
      await right.getByTestId("caption-target").click();
      const input = page.getByTestId("caption-input");
      await expect(input).toBeVisible();
      await input.fill("Right-hand page caption");
      await expect(right.getByTestId("page-caption")).toHaveText("Right-hand page caption");
      await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
      expect(await left.innerHTML()).toBe(leftBefore);
      await expect(counter(page)).toHaveText("1–2 / 6");

      // Tapping the left page moves "current" back (the selection there drops).
      await page.getByTestId("editor-panel-close").click();
      await left.locator('[data-slot-index="0"] [data-testid="slot-target"]').click();
      await expect(left).toHaveAttribute("data-active", "true");
      await page.getByTestId("editor-tool-dev-panel").click();
      await expect(page.getByTestId("editor-panel-dev-panel")).toContainText("Page: 0 · selection: slot");
    });

    test("strip tap on a right-hand page shows its spread with that page current", async ({ page }) => {
      await openSpread(page);
      await page.getByTestId("page-strip").getByRole("button", { name: "Page 4", exact: true }).click();
      await expect(counter(page)).toHaveText("3–4 / 6");
      await settle(page);
      await expect(side(page, "right")).toHaveAttribute("data-active", "true");
    });
  });

  test.describe("at 1280 × 800 (landscape book)", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("two landscape pages side by side, fitted to width", async ({ page }) => {
      await openSpread(page, "?format=landscape");
      await page.getByTestId("carousel-next").click();
      await expect(counter(page)).toHaveText("1–2 / 6");
      await settle(page);
      const spread = (await cur(page).getByTestId("editor-spread").boundingBox())!;
      const c = (await carousel(page).boundingBox())!;
      expect(spread.width / spread.height).toBeGreaterThan(2.7); // 420 / 148 ≈ 2.84
      expect(spread.x).toBeGreaterThanOrEqual(c.x);
      expect(spread.x + spread.width).toBeLessThanOrEqual(c.x + c.width + 1);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe("at 375 px", () => {
    test.use({ viewport: { width: W, height: 812 }, hasTouch: true, isMobile: true });

    test("single page + View spread sheet: shows the current spread, swipes, jumps to a page", async ({ page }) => {
      await page.goto(`/dev-editor`);
      await expect(page.getByTestId("editor-shell")).toBeVisible();
      await expect(carousel(page)).toHaveAttribute("data-mode", "single");
      await expect(page.getByTestId("editor-spread")).toHaveCount(0);
      await page.getByTestId("carousel-next").click();
      await page.getByTestId("carousel-next").click();
      await page.getByTestId("carousel-next").click();
      await expect(counter(page)).toHaveText("3 / 6");
      await settle(page);

      await page.getByTestId("view-spread").click();
      const sheet = page.getByTestId("spread-preview");
      await expect(sheet).toBeVisible();
      await expect(page.getByTestId("spread-preview-counter")).toHaveText("3–4 / 6");
      const shownItem = sheet.locator('[data-testid="spread-preview-item"][aria-hidden="false"]');
      await expect(shownItem.getByTestId("spread-preview-page")).toHaveCount(2);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.getByTestId("spread-preview-next").click();
      await expect(page.getByTestId("spread-preview-counter")).toHaveText("5–6 / 6");
      await page.getByTestId("spread-preview-prev").click();
      await page.getByTestId("spread-preview-prev").click();
      await expect(page.getByTestId("spread-preview-counter")).toHaveText("1–2 / 6");
      // Tap the right-hand page → editor jumps to it, sheet closes.
      await expect(shownItem).toHaveAttribute("data-spread", "1");
      await shownItem.locator('[data-testid="spread-preview-page"][data-page-idx="1"]').click();
      await expect(sheet).toHaveCount(0);
      await expect(counter(page)).toHaveText("2 / 6");
      await settle(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test("spread sheet traps focus (Tab / Shift+Tab) and returns it to the Spread button (N6)", async ({ page }) => {
      await page.goto(`/dev-editor`);
      await expect(page.getByTestId("editor-shell")).toBeVisible();
      await page.getByTestId("carousel-next").click();
      await expect(counter(page)).toHaveText("1 / 6");
      await settle(page);
      await page.getByTestId("view-spread").click();
      const sheet = page.getByTestId("spread-preview");
      await expect(sheet).toBeVisible();
      await expect(page.getByTestId("spread-preview-close")).toBeFocused();
      const inside = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="spread-preview"]'));
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        expect(await inside(), `Tab ${i + 1} stays in the sheet`).toBe(true);
      }
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Shift+Tab");
        expect(await inside(), `Shift+Tab ${i + 1} stays in the sheet`).toBe(true);
      }
      // Tab from the close button wraps around: forward from the last element lands on the first.
      await page.getByTestId("spread-preview-close").focus();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("spread-preview-next")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("spread-preview-close")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(page.getByTestId("view-spread")).toBeFocused();
      // Closing by tapping a page returns focus too.
      await page.getByTestId("view-spread").click();
      await sheet.locator('[data-testid="spread-preview-item"][aria-hidden="false"] [data-testid="spread-preview-page"]').first().click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByTestId("view-spread")).toBeFocused();
    });
  });

  test.describe("first paint at 1024 × 768 (N7)", () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test("never shows the single-page carousel before the spread; no hydration warnings", async ({ page, request }) => {
      // Server HTML: the single carousel is md:hidden and a spread-shaped placeholder shows on md+.
      const html = await (await request.get(`/dev-editor`)).text();
      expect(html).toContain('data-testid="spread-placeholder"');
      const logs: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") logs.push(m.text());
      });
      await page.addInitScript(() => {
        const w = window as unknown as { __singleSeen?: boolean; __placeholderSeen?: boolean };
        w.__singleSeen = false;
        w.__placeholderSeen = false;
        const check = () => {
          const single = document.querySelector<HTMLElement>('[data-testid="page-carousel"][data-mode="single"]');
          if (single && single.getBoundingClientRect().width > 0) w.__singleSeen = true;
          const ph = document.querySelector<HTMLElement>('[data-testid="spread-placeholder"]');
          if (ph && ph.getBoundingClientRect().width > 0) w.__placeholderSeen = true;
        };
        // Checked once per frame (what can be painted), from the first frame on.
        const loop = () => {
          check();
          if (performance.now() < 5000) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await page.goto(`/dev-editor`);
      await expect(carousel(page)).toHaveAttribute("data-mode", "spread");
      await expect(page.getByTestId("spread-placeholder")).toHaveCount(0);
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as unknown as { __singleSeen?: boolean }).__singleSeen)).toBe(false);
      expect(logs.filter((l) => /hydrat|did not match|server rendered/i.test(l)), "no hydration warnings").toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// M10a A8: Background tool on /dev-editor?bg=1 (uuid background photos: …f5 kept, …f4 AI-dropped;
// the stub save runs the real validateEditorDoc and exposes the stored JSON as
// window.__devEditorLastSave). Screenshots: E2E_SHOTS=<dir>.
// ---------------------------------------------------------------------------------------------

test.describe("backgrounds at 375 px (/dev-editor?bg=1)", () => {
  test.use({ viewport: { width: W, height: 812 }, hasTouch: true, isMobile: true });

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`/dev-editor`);
    test.skip(res.status() === 404, "/dev-editor is dev-only (404 under next start)");
  });

  const errors: string[] = [];
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

  const DROPPED_UUID = "00000000-0000-4000-8000-0000000000f4";
  const NAVY_RGB = "rgb(30, 42, 71)";
  const cur = (page: Page) => page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
  const counter = (page: Page) => page.getByTestId("page-counter");
  const panel = (page: Page) => page.getByTestId("editor-panel-background");
  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  /**
   * Background colour of every page frame. The carousel only mounts pages near the current one;
   * the page strip (hidden below lg, still rendered) has the cover + every page.
   */
  const frameColours = (page: Page, scope: "strip" | "carousel" = "strip") =>
    page.$$eval(
      scope === "strip" ? '[data-testid="page-strip"] [data-page]' : '[data-testid="carousel-item"] [data-page]',
      (els) => els.map((e) => getComputedStyle(e).backgroundColor),
    );
  const lastSave = (page: Page) =>
    page.evaluate(() => (window as unknown as { __devEditorLastSave?: { rev: number; stored: Record<string, unknown> } }).__devEditorLastSave ?? null);
  async function shot(page: Page, name: string) {
    const dir = process.env.E2E_SHOTS;
    if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
  }
  async function settle(page: Page) {
    await expect
      .poll(
        async () => {
          const x1 = (await cur(page).boundingBox())?.x ?? 999;
          await page.waitForTimeout(100);
          const x2 = (await cur(page).boundingBox())?.x ?? 999;
          return Math.abs(x1 - x2) < 1 && Math.abs(x2) < 2;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  }
  async function waitSaved(page: Page) {
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
  }

  test("paper for this page, navy for the whole book, faded photo, reset, undo — autosaved as doc v2", async ({ page }) => {
    await page.goto(`/dev-editor?bg=1`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(counter(page)).toContainText("Cover");
    await settle(page);

    // Cover: only "Whole book".
    await page.getByTestId("editor-tool-background").click();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId("bg-scope-page")).toBeDisabled();
    await expect(page.getByTestId("bg-scope-book")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("bg-cover-note")).toBeVisible();
    await page.getByTestId("editor-panel-close").click();

    // Page 2 (one photo + caption) → Paper → Linen, this page only. The panel docks under the page.
    await page.getByTestId("carousel-next").click();
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("2 / 6");
    await settle(page);
    await page.getByTestId("editor-tool-background").click();
    await expect(panel(page)).toHaveAttribute("data-docked", "true");
    await expect(page.getByTestId("bg-scope-page")).toHaveAttribute("aria-checked", "true");
    // The page stays in view above the panel (live preview).
    const pageBox = (await cur(page).locator('[data-testid="editor-page"]').boundingBox())!;
    const panelBox = (await panel(page).boundingBox())!;
    expect(pageBox.y + pageBox.height).toBeLessThanOrEqual(panelBox.y + 1);
    await page.getByTestId("bg-tab-texture").click();
    expect(await overflow(page), "paper tab overflow").toBeLessThanOrEqual(0);
    await page.getByTestId("bg-texture-linen").click();
    await expect(page.getByTestId("bg-texture-linen")).toHaveAttribute("aria-checked", "true");
    await expect(cur(page).locator('[data-bg="texture"][data-bg-texture="linen"]')).toHaveCount(1);
    const carouselLinen = page.locator('[data-testid="carousel-item"] [data-bg-texture="linen"]');
    await expect(carouselLinen).toHaveCount(1); // no other page
    await expect(page.getByTestId("bg-reset")).toBeVisible();
    await shot(page, "375-paper-linen");
    await waitSaved(page);
    let saved = await lastSave(page);
    expect(saved?.stored.version).toBe(2);
    expect((saved?.stored.pages as { background?: unknown }[])[1].background).toEqual({ kind: "texture", textureId: "linen", source: "user" });

    // Whole book → navy: every page navy (the linen override is replaced), captions white.
    await page.getByTestId("bg-scope-book").click();
    await expect(page.getByTestId("bg-replace-note")).toContainText("1 page");
    await page.getByTestId("bg-tab-color").click();
    expect(await overflow(page), "colour tab overflow").toBeLessThanOrEqual(0);
    await page.getByTestId("bg-colour-navy").click();
    await expect(page.getByTestId("bg-colour-navy")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-bg-texture="linen"]')).toHaveCount(0); // carousel + page strip
    await expect(page.getByTestId("editor-toast")).toContainText("Whole book updated");
    const colours = await frameColours(page);
    expect(colours.length).toBeGreaterThanOrEqual(7); // cover + 6 pages
    expect(new Set(colours)).toEqual(new Set([NAVY_RGB]));
    expect(new Set(await frameColours(page, "carousel"))).toEqual(new Set([NAVY_RGB]));
    const captions = page.locator('[data-testid="page-caption"]');
    expect(await captions.count()).toBeGreaterThan(0);
    for (const c of await captions.all()) await expect(c).toHaveClass(/\btext-white\b/);
    await shot(page, "375-whole-book-navy");

    // This page → Photo (an AI-dropped photo is fine as a background) → fade 0.8.
    await page.getByTestId("bg-scope-page").click();
    await page.getByTestId("bg-tab-photo").click();
    expect(await overflow(page), "photo tab overflow").toBeLessThanOrEqual(0);
    await expect(page.getByTestId("bg-fade")).toBeDisabled();
    await page.locator(`[data-testid="bg-photo"][data-photo-id="${DROPPED_UUID}"]`).click();
    await expect(cur(page).locator('[data-bg="photo"]')).toHaveCount(1);
    await page.getByTestId("bg-fade").fill("0.8");
    await expect(page.getByTestId("bg-fade-value")).toHaveText("80%");
    await expect(cur(page).locator('[data-bg="veil"]')).toHaveAttribute("style", /rgba\(255, 255, 255, 0\.8\)/);
    await shot(page, "375-photo-fade");
    await waitSaved(page);
    saved = await lastSave(page);
    expect(saved?.stored.version).toBe(2);
    expect(saved?.stored.style).toMatchObject({ background: { kind: "color", hex: "#1E2A47" } });
    expect((saved?.stored.pages as { background?: unknown }[])[1].background).toEqual({
      kind: "photo",
      photoId: DROPPED_UUID,
      veil: 0.8,
      veilColor: "#FFFFFF",
      source: "user",
    });

    // Reset → back to the book's navy; undo brings the faded photo back.
    await page.getByTestId("bg-reset").click();
    await expect(cur(page).locator('[data-bg="veil"]')).toHaveCount(0);
    await expect(page.getByTestId("bg-reset")).toHaveCount(0);
    expect(new Set(await frameColours(page, "carousel"))).toEqual(new Set([NAVY_RGB]));
    await page.getByTestId("editor-panel-close").click();
    await page.getByTestId("editor-undo").click();
    await expect(cur(page).locator('[data-bg="veil"]')).toHaveAttribute("style", /rgba\(255, 255, 255, 0\.8\)/);
    await waitSaved(page);
    saved = await lastSave(page);
    expect((saved?.stored.pages as { background?: { veil?: number } }[])[1].background?.veil).toBe(0.8);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  // ---- M10a review fixes --------------------------------------------------------------------

  const KEPT_UUID = "00000000-0000-4000-8000-0000000000f5";

  /** Nothing selected on page 1: the 6 real tools (Layout … Upgrade), then /dev-editor's 2 demo tools. */
  async function page1Tools(page: Page) {
    await page.goto(`/dev-editor?bg=1`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await settle(page);
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("1 / 6");
    await settle(page);
    return page.locator('[data-testid^="editor-tool-"]');
  }

  /** Hide /dev-editor's demo tools so the row is exactly what the real editor shows. */
  const HIDE_DEV_TOOLS = '[data-testid^="editor-tool-dev-"]{display:none!important}';

  test("toolbar at 375: every real tool on screen without scrolling, labels unclipped, no page overflow", async ({ page }) => {
    const tools = await page1Tools(page);
    const devTools = await page.addStyleTag({ content: HIDE_DEV_TOOLS });
    const visible = page.locator('[data-testid^="editor-tool-"]:not([data-testid^="editor-tool-dev-"])');
    const ids = await visible.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("editor-tool-", "")));
    expect(ids).toEqual(["layout", "background", "pages", "add-page", "page-menu", "upgrade"]);
    await expect(page.getByTestId("toolbar-fade-end")).toHaveAttribute("data-visible", "false");
    for (let i = 0; i < ids.length; i++) {
      const t = visible.nth(i);
      const box = (await t.boundingBox())!;
      expect(box.width, ids[i]).toBeGreaterThanOrEqual(44);
      expect(box.width, ids[i]).toBeLessThanOrEqual(72);
      expect(box.x, ids[i]).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, ids[i]).toBeLessThanOrEqual(W);
      // Label fits its button (no clipping / overflow).
      const fits = await t.evaluate((el) => {
        const label = el.querySelector("span")!;
        const b = el.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        return l.left >= b.left - 0.5 && l.right <= b.right + 0.5;
      });
      expect(fits, `label fits: ${ids[i]}`).toBe(true);
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(page, "375-toolbar");
    // With the 2 demo tools too (8 tools) the row scrolls: fade edge, last tool reachable.
    await devTools.evaluate((el) => (el as HTMLElement).remove());
    await expect(page.getByTestId("toolbar-fade-end")).toHaveAttribute("data-visible", "true");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(page, "375-toolbar-scroll");
    const lastTool = tools.last();
    await page.getByTestId("editor-toolbar-row").evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: "instant" }));
    const box = (await lastTool.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(W);
    await expect(page.getByTestId("toolbar-fade-start")).toHaveAttribute("data-visible", "true");
    await expect(page.getByTestId("toolbar-fade-end")).toHaveAttribute("data-visible", "false");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test.describe("at 320 px", () => {
    test.use({ viewport: { width: 320, height: 700 } });

    test("toolbar: the row scrolls with a fade edge, every real tool reachable, no page overflow", async ({ page }) => {
      const tools = await page1Tools(page);
      await page.addStyleTag({ content: HIDE_DEV_TOOLS });
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      for (const id of ["layout", "background", "pages", "add-page", "page-menu", "upgrade"]) {
        const t = page.getByTestId(`editor-tool-${id}`);
        await t.scrollIntoViewIfNeeded();
        const box = (await t.boundingBox())!;
        expect(box.x, id).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, id).toBeLessThanOrEqual(320);
      }
      expect(await tools.count()).toBeGreaterThanOrEqual(6);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test("Whole book: fade / veil colour keep page backgrounds (no toast); a new photo replaces them; toast sits above the panel", async ({ page }) => {
    await page.goto(`/dev-editor?bg=1`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await settle(page);
    // Page 2 → Linen (this page).
    await page.getByTestId("carousel-next").click();
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("2 / 6");
    await settle(page);
    await page.getByTestId("editor-tool-background").click();
    await page.getByTestId("bg-tab-texture").click();
    await page.getByTestId("bg-texture-linen").click();
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(1);

    // Whole book → a photo: replaces the linen page → warning toast, placed above the docked panel.
    await page.getByTestId("bg-scope-book").click();
    await page.getByTestId("bg-tab-photo").click();
    await page.locator(`[data-testid="bg-photo"][data-photo-id="${KEPT_UUID}"]`).click();
    const toast = page.getByTestId("editor-toast");
    await expect(toast).toContainText("Whole book updated (1 page lost");
    await expect(page.getByTestId("editor-toast-host")).toHaveAttribute("data-above-panel", "true");
    const toastBox = (await toast.boundingBox())!;
    const panelBox = (await panel(page).boundingBox())!;
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(panelBox.y + 1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(page, "375-toast-above-panel");
    await page.locator('[data-testid="editor-toast"] button[aria-label="Dismiss"]').click();
    await expect(toast).toHaveCount(0);

    // Linen again on page 2 (This page), then adjust the book photo's fade + veil colour.
    await page.getByTestId("bg-scope-page").click();
    await page.getByTestId("bg-tab-texture").click();
    await page.getByTestId("bg-texture-linen").click();
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(1);
    await page.getByTestId("bg-scope-book").click();
    await page.getByTestId("bg-tab-photo").click();
    await expect(page.getByTestId("bg-replace-note")).toContainText("Changing the fade keeps them.");
    // N4/N5: white veil → slider starts at 60 %, value text in percent.
    const fade = page.getByTestId("bg-fade");
    await expect(fade).toHaveAttribute("min", "0.6");
    await fade.fill("0.85");
    await expect(fade).toHaveAttribute("aria-valuetext", "85%");
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(1);
    await page.getByTestId("bg-veil-navy").click();
    await expect(fade).toHaveAttribute("min", "0.5");
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(1);
    await expect(toast).toHaveCount(0);
    await waitSaved(page);
    const saved = await lastSave(page);
    expect(saved?.stored.style).toMatchObject({ background: { kind: "photo", photoId: KEPT_UUID, veil: 0.85, veilColor: "#1E2A47" } });
    expect((saved?.stored.pages as { background?: unknown }[])[1].background).toEqual({ kind: "texture", textureId: "linen", source: "user" });

    // A different photo for the whole book replaces the linen page again (with the toast).
    await page.locator(`[data-testid="bg-photo"][data-photo-id="${DROPPED_UUID}"]`).click();
    await expect(toast).toContainText("1 page lost");
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(0);
  });

  test("radio groups: one tab stop, arrow keys move + select (N5)", async ({ page }) => {
    await page.goto(`/dev-editor?bg=1`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await settle(page);
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("1 / 6");
    await settle(page);
    await page.getByTestId("editor-tool-background").click();
    const colours = page.getByTestId("bg-colours");
    await expect(colours.locator('[tabindex="0"]')).toHaveCount(1);
    const checked = colours.locator('[aria-checked="true"]');
    await checked.focus();
    const before = await checked.getAttribute("data-testid");
    await page.keyboard.press("ArrowRight");
    const after = colours.locator('[aria-checked="true"]');
    await expect(after).not.toHaveAttribute("data-testid", before!);
    await expect(after).toBeFocused();
    await expect(colours.locator('[tabindex="0"]')).toHaveCount(1);
    // The arrow key stayed in the group: the editor did not flip pages.
    await expect(counter(page)).toHaveText("1 / 6");
    await page.keyboard.press("Home");
    await expect(page.getByTestId("bg-colour-white")).toBeFocused();
    await expect(page.getByTestId("bg-colour-white")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("End");
    await expect(page.getByTestId("bg-colour-black")).toHaveAttribute("aria-checked", "true");
    // Scope group: ArrowRight → Whole book.
    await page.getByTestId("bg-scope-page").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("bg-scope-book")).toBeFocused();
    await expect(page.getByTestId("bg-scope-book")).toHaveAttribute("aria-checked", "true");
  });

  // ---- M10b A4: picker polish ---------------------------------------------------------------

  test("fade slider shows a stored light 50 % veil as 50 %; the first change goes to the 60 % minimum", async ({ page }) => {
    await page.goto(`/dev-editor?bg=1&bgveil=light50`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await settle(page);
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("1 / 6");
    await settle(page);
    // The page renders the stored 0.5 veil.
    await expect(cur(page).locator('[data-bg="veil"]').first()).toHaveCSS("background-color", "rgba(255, 255, 255, 0.5)");
    await page.getByTestId("editor-tool-background").click();
    await expect(page.getByTestId("bg-panel-photo")).toBeVisible();
    const fade = page.getByTestId("bg-fade");
    await expect(page.getByTestId("bg-fade-value")).toHaveText("50%");
    await expect(fade).toHaveValue("0.5");
    await expect(fade).toHaveAttribute("min", "0.5");
    await expect(fade).toHaveAttribute("aria-valuetext", "50%");
    await shot(page, "375-fade-stored-50");
    // A new change respects the light-veil minimum (N4): one step up lands on 60 %.
    await fade.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("bg-fade-value")).toHaveText("60%");
    await expect(fade).toHaveValue("0.6");
    await expect(fade).toHaveAttribute("min", "0.6");
    await expect(counter(page)).toHaveText("1 / 6");
    await expect(cur(page).locator('[data-bg="veil"]').first()).toHaveCSS("background-color", "rgba(255, 255, 255, 0.6)");
    await waitSaved(page);
    const saved = await lastSave(page);
    expect((saved?.stored.pages as { background?: { veil?: number } }[])[0].background).toMatchObject({ kind: "photo", veil: 0.6, veilColor: "#FFFFFF" });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("Whole-book photo grid: arrow keys move focus only, Enter applies once (one undo step)", async ({ page }) => {
    await page.goto(`/dev-editor?bg=1`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await settle(page);
    await page.getByTestId("carousel-next").click();
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("2 / 6");
    await settle(page);
    await page.getByTestId("editor-tool-background").click();
    await page.getByTestId("bg-tab-texture").click();
    await page.getByTestId("bg-texture-linen").click();
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(1);
    await waitSaved(page);
    const coloursBefore = await frameColours(page);

    await page.getByTestId("bg-scope-book").click();
    await page.getByTestId("bg-tab-photo").click();
    const grid = page.getByTestId("bg-photos");
    await expect(grid).toHaveAttribute("data-keys", "focus");
    const kept = grid.locator(`[data-photo-id="${KEPT_UUID}"]`);
    const dropped = grid.locator(`[data-photo-id="${DROPPED_UUID}"]`);
    await kept.focus();
    await page.keyboard.press("ArrowRight");
    await expect(dropped).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(kept).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dropped).toBeFocused();
    // Nothing applied: no photo checked, no toast, the book and the linen page unchanged.
    await expect(grid.locator('[aria-checked="true"]')).toHaveCount(0);
    await expect(page.getByTestId("editor-toast")).toHaveCount(0);
    await expect(page.locator('[data-testid="page-strip"] [data-bg="photo"], [data-testid="page-strip"] [data-bg="veil"]')).toHaveCount(0);
    expect(await frameColours(page)).toEqual(coloursBefore);
    await expect(counter(page)).toHaveText("2 / 6");

    // Enter applies the focused photo to the whole book: one edit, the warning toast.
    await page.keyboard.press("Enter");
    await expect(dropped).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("editor-toast")).toContainText("1 page lost");
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(0);
    await waitSaved(page);
    const saved = await lastSave(page);
    expect(saved?.stored.style).toMatchObject({ background: { kind: "photo", photoId: DROPPED_UUID } });

    // A single undo restores the book colour and the linen page.
    await page.getByTestId("editor-undo").click();
    await expect(page.locator('[data-testid="page-strip"] [data-bg-texture="linen"]')).toHaveCount(1);
    await expect(grid.locator('[aria-checked="true"]')).toHaveCount(0);
    expect(await frameColours(page)).toEqual(coloursBefore);
  });

  test("toast follows the panel when it changes size after the toast appeared", async ({ page }) => {
    await page.goto(`/dev-editor?bg=1`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await settle(page);
    await page.getByTestId("carousel-next").click();
    await expect(counter(page)).toHaveText("1 / 6");
    await settle(page);
    await page.getByTestId("editor-tool-background").click();
    await page.getByTestId("bg-tab-texture").click();
    await page.getByTestId("bg-texture-linen").click();
    await page.getByTestId("bg-scope-book").click();
    await page.getByTestId("bg-tab-color").click();
    await page.getByTestId("bg-colour-navy").click();
    const toast = page.getByTestId("editor-toast");
    await expect(toast).toContainText("1 page lost");
    await expect(page.getByTestId("editor-toast-host")).toHaveAttribute("data-above-panel", "true");
    const above = async () => {
      const t = (await toast.boundingBox())!;
      const p = (await panel(page).boundingBox())!;
      return t.y + t.height <= p.y + 1 && p.y - (t.y + t.height) < 24;
    };
    await expect.poll(above).toBe(true);
    // The panel shrinks while the toast shows (no window resize): the toast moves down with it.
    const topBefore = (await panel(page).boundingBox())!.y;
    await panel(page).evaluate((el) => {
      (el as HTMLElement).style.maxHeight = "160px";
    });
    await expect.poll(async () => (await panel(page).boundingBox())!.y - topBefore).toBeGreaterThan(40);
    await expect.poll(above).toBe(true);
    // Closing the panel → default spot; reopening the tool → above the new panel again.
    await page.getByTestId("editor-panel-close").click();
    await expect(page.getByTestId("editor-toast-host")).toHaveAttribute("data-above-panel", "false");
    await page.getByTestId("editor-tool-background").click();
    await expect(page.getByTestId("editor-toast-host")).toHaveAttribute("data-above-panel", "true");
    await expect.poll(above).toBe(true);
  });
});

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

  test("free book at 20 pages: Add page opens the Upgrade sheet, no page 21", async ({ page }) => {
    await open(page, "?pages=20");
    await goToItem(page, 20);
    await page.getByTestId("editor-tool-add-page").click();
    await expect(page.getByTestId("upgrade-sheet")).toBeVisible();
    await expect(page.getByTestId("upgrade-button")).toBeDisabled(); // "Coming soon" until M7 (D-037 3)
    await expect(counter(page)).toHaveText("20 / 20");
    await expectNoOverflow(page, "upgrade sheet");
    await page.getByTestId("editor-panel-close").click();
    await expect(page.getByTestId("upgrade-sheet")).toHaveCount(0);
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
    [503, { error: "ai_off" }, "AI captions aren't switched on yet"],
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
    // The open sheet's backdrop covers the toolbar on mobile: close it, the selection stays.
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

// M6 publish screen on the dev-only /dev-publish fixture (real PublishPanelView, stubbed actions;
// no auth / Supabase / migration 1000), run against `next dev` like e2e/editor.spec.ts.
// Every state at 375 px: no horizontal overflow, copy per state, conflict auto-retry, password
// validation. Also the signed-out guard of the real /books/<id>/publish route.
import { expect, test, type Page } from "@playwright/test";

const VIEWPORT = { width: 375, height: 740 };
test.use({ viewport: VIEWPORT, hasTouch: true, isMobile: true });

async function open(page: Page, state: string, result = "ok") {
  await page.goto(`/dev-publish?state=${state}&result=${result}`);
  await expect(page.getByTestId("publish-panel")).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
}

/**
 * Upgrade button follows the server's isPaymentsEnabled() (Stripe keys in the dev server env).
 * E2E_PAYMENTS=1 / 0 pins the expectation; unset → it must be consistent with the rendered flag.
 */
async function expectUpgradeState(page: Page, testId: string): Promise<boolean> {
  const wrap = page.getByTestId(`${testId}-wrap`);
  await expect(wrap).toBeVisible();
  const on = (await wrap.getAttribute("data-payments")) === "on";
  if (process.env.E2E_PAYMENTS === "1") expect(on, "payments should be enabled (keys set)").toBe(true);
  if (process.env.E2E_PAYMENTS === "0") expect(on, "payments should be disabled (no keys)").toBe(false);
  const btn = page.getByTestId(testId);
  await expect(btn).toContainText("AED 39");
  await expect(btn).not.toContainText(/coming soon/i);
  if (on) {
    await expect(btn).toBeEnabled();
    await expect(page.getByTestId(`${testId}-unavailable`)).toHaveCount(0);
  } else {
    await expect(btn).toBeDisabled();
    await expect(page.getByTestId(`${testId}-unavailable`)).toHaveText("Payments unavailable");
  }
  const box = (await btn.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width);
  return on;
}

const STATES = ["draft", "draft-paid", "empty", "page_limit", "invalid_doc", "live", "live-paid", "changes", "password", "expired", "unpublished"];

test("every state fits 375 px without horizontal overflow", async ({ page }) => {
  for (const s of STATES) {
    await open(page, s);
    await noHorizontalOverflow(page);
    // The long link field must not push the layout.
    const url = page.getByTestId("publish-url");
    if (await url.count()) {
      const box = (await url.boundingBox())!;
      expect(box.x + box.width, s).toBeLessThanOrEqual(VIEWPORT.width);
    }
  }
});

test("draft (free): Publish → live with link, 30-day expiry label, free notice, share buttons", async ({ page }) => {
  await open(page, "draft");
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "unpublished");
  await expect(page.getByTestId("publish-draft")).toContainText("Ready to share?");
  await expect(page.getByTestId("publish-free-notice")).toContainText("Free link works for 30 days");
  await expect(page.getByTestId("unpublish-section")).toHaveCount(0);
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live");
  await expect(page.getByTestId("publish-live")).toBeVisible();
  await expect(page.getByTestId("publish-url")).toHaveValue(/\/b\/sara-and-omar-wedding-7Hq2xYp9Kd$/);
  await expect(page.getByTestId("publish-expiry")).toHaveText(/^Link expires \d{1,2} [A-Z][a-z]{2}( \d{4})?$/);
  await expect(page.getByTestId("share-whatsapp")).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
  await expect(page.getByTestId("publish-open")).toHaveAttribute("href", "/b/sara-and-omar-wedding-7Hq2xYp9Kd");
  await expect(page.getByTestId("unpublish-button")).toBeVisible();
  await noHorizontalOverflow(page);
});

test("landed from the editor's Share (M13 T9): 'Your book is live', WhatsApp first and above the fold, param dropped", async ({ page }) => {
  await page.goto("/dev-publish?state=live&shared=live");
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live");
  await expect(page).toHaveURL(/\/dev-publish\?state=live$/);
  const wa = page.getByTestId("share-whatsapp");
  await expect(wa).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
  const box = (await wa.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y + box.height, "WhatsApp is visible without scrolling").toBeLessThanOrEqual(VIEWPORT.height);
  const y = async (id: string) => (await page.getByTestId(id).boundingBox())!.y;
  expect(await y("share-whatsapp")).toBeLessThan(await y("share-copy"));
  expect(await y("share-copy")).toBeLessThan(await y("publish-free-notice"));
  await expect(page.getByTestId("publish-live")).toContainText("Anyone with the link can see it");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath("share-landed-375.png"), fullPage: true });

  await page.goto("/dev-publish?state=live&shared=changes");
  await expect(page.getByTestId("publish-message")).toHaveText("Changes published");
  await page.goto("/dev-publish?state=live");
  await expect(page.getByTestId("publish-message")).toHaveCount(0);
});

test("paid states: permanent link, no free notice", async ({ page }) => {
  await open(page, "live-paid");
  await expect(page.getByTestId("publish-expiry")).toHaveText("Permanent link");
  await expect(page.getByTestId("publish-free-notice")).toHaveCount(0);
  await open(page, "draft-paid");
  await expect(page.getByTestId("publish-free-notice")).toHaveCount(0);
});

test("blocked states: disabled Publish with the reason", async ({ page }) => {
  const cases: [string, RegExp][] = [
    ["empty", /no pages yet/],
    ["page_limit", /more than 20 pages/],
    ["invalid_doc", /needs fixing/],
  ];
  for (const [s, copy] of cases) {
    await open(page, s);
    await expect(page.getByTestId("publish-blocked")).toHaveText(copy);
    await expect(page.getByTestId("publish-button")).toBeDisabled();
  }
});

test("changes: Publish changes chip → 'Changes published'", async ({ page }) => {
  await open(page, "changes");
  await expect(page.getByTestId("publish-changes")).toContainText("edits that aren't in the shared book");
  await page.getByTestId("publish-changes-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Changes published");
  await expect(page.getByTestId("publish-changes")).toHaveCount(0);
});

test("expired: upgrade copy, no publish, no password field", async ({ page }) => {
  await open(page, "expired");
  await expect(page.getByTestId("publish-panel")).toHaveAttribute("data-state", "expired");
  await expect(page.getByTestId("publish-expired")).toContainText("This free link has expired — Upgrade to bring it back");
  await expect(page.getByTestId("publish-button")).toHaveCount(0);
  await expect(page.getByTestId("password-section")).toHaveCount(0);
  await expectUpgradeState(page, "publish-upgrade");
});

test("upgrade (free notice): 'Upgrade this book — AED 39', enabled iff payments on; tap without a session → sign in", async ({ page }) => {
  await open(page, "draft");
  const on = await expectUpgradeState(page, "publish-upgrade");
  await expect(page.getByTestId("publish-upgrade")).toHaveText("Upgrade this book — AED 39");
  await noHorizontalOverflow(page);
  if (on) {
    // The real server action runs; the dev fixture has no session → unauthenticated.
    await page.getByTestId("publish-upgrade").click();
    await expect(page.getByTestId("publish-upgrade-message")).toContainText("Please sign in again");
    await expect(page.getByTestId("publish-upgrade-message").getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      /^\/login\?next=%2Fbooks%2F/,
    );
    await expect(page.getByTestId("publish-upgrade")).toBeEnabled();
    await noHorizontalOverflow(page);
  }
  // Paid books: no upgrade button anywhere.
  await open(page, "live-paid");
  await expect(page.getByTestId("publish-upgrade")).toHaveCount(0);
});

test("?upgrade=cancelled: 'Payment cancelled' notice, param removed from the URL, dismissible", async ({ page }) => {
  await page.goto("/dev-publish?state=draft&upgrade=cancelled");
  const notice = page.getByTestId("upgrade-cancelled");
  await expect(notice).toContainText("Payment cancelled");
  await expect(page).toHaveURL(/\/dev-publish\?state=draft$/);
  await noHorizontalOverflow(page);
  const dismiss = page.getByTestId("upgrade-cancelled-dismiss");
  expect((await dismiss.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await dismiss.click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("publish-panel")).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("unpublished (was live): Publish keeps the same link and expiry copy", async ({ page }) => {
  await open(page, "unpublished");
  await expect(page.getByTestId("publish-draft")).toContainText("keeps the same link and expiry date");
  await expect(page.getByTestId("publish-button")).toHaveText("Publish");
});

test("unpublish needs confirmation", async ({ page }) => {
  await open(page, "live");
  await page.getByTestId("unpublish-button").click();
  await expect(page.getByTestId("unpublish-confirm")).toContainText("The link stops working for everyone");
  await page.getByTestId("unpublish-confirm-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Unpublished — the link no longer works");
  await expect(page.getByTestId("publish-draft")).toBeVisible();
});

test("conflict once → automatic retry succeeds; conflict twice → 'Something changed — try again'", async ({ page }) => {
  await open(page, "draft", "conflict");
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 10_000 });

  await open(page, "draft", "conflict2");
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Something changed — try again", { timeout: 10_000 });
  await expect(page.getByTestId("publish-button")).toBeEnabled();

  await open(page, "draft", "failed");
  await page.getByTestId("publish-button").click();
  await expect(page.getByTestId("publish-message")).toContainText("Couldn't publish right now");
});

test("password: length validation, save, change, remove", async ({ page }) => {
  await open(page, "live");
  await expect(page.getByTestId("password-status")).toContainText("Off");
  await page.getByTestId("password-edit").click();
  const input = page.getByTestId("password-input");
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("abc");
  await page.getByTestId("password-save").click();
  await expect(page.getByTestId("password-error")).toHaveText("Use at least 4 characters.");
  await input.fill("x".repeat(65));
  await expect(page.getByTestId("password-error")).toHaveCount(0); // typing clears the error
  await page.getByTestId("password-save").click();
  await expect(page.getByTestId("password-error")).toHaveText("Use at most 64 characters.");
  // 4 code points (emoji are 2 UTF-16 units each) is valid.
  await input.fill("🔑🔑ab");
  await page.getByTestId("password-save").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Password saved");
  await expect(page.getByTestId("password-status")).toContainText("On");
  await expect(page.getByTestId("password-input")).toHaveCount(0); // never kept on screen
  await page.getByTestId("password-remove").click();
  await expect(page.getByTestId("publish-message")).toHaveText("Password removed");
  await expect(page.getByTestId("password-status")).toContainText("Off");
  await noHorizontalOverflow(page);
});

test("signed out: /books/<uuid>/publish redirects to login", async ({ page }) => {
  const id = "00000000-0000-4000-8000-0000000000aa";
  await page.goto(`/books/${id}/publish`);
  await expect(page).toHaveURL(/\/login(\?|$)/);
  expect(decodeURIComponent(page.url())).toContain(`/books/${id}/publish`);
});

// M8 T8: "Download PDF" on paid books. The PDF API is route-mocked (202 → polling → ready); the
// "signed URL" is a same-origin path answered as an attachment, so Chromium downloads it.
const PDF_MOCK_URL = "/__pdf-mock/sara-and-omar.pdf";

async function mockPdfApi(page: Page, gets: Array<Record<string, unknown>>, post: { status: number; body: Record<string, unknown> } = { status: 202, body: { status: "queued", exportId: "e1" } }) {
  const calls: string[] = [];
  await page.route("**/api/books/*/pdf**", async (route) => {
    const req = route.request();
    calls.push(`${req.method()} ${new URL(req.url()).search}`);
    if (req.method() === "POST") return route.fulfill({ status: post.status, json: post.body });
    const next = gets.shift() ?? { status: "rendering" };
    return route.fulfill({ status: 200, json: next });
  });
  await page.route("**/__pdf-mock/**", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="sara-and-omar.pdf"' },
      body: "%PDF-1.7\n%%EOF\n",
    }),
  );
  return calls;
}

const READY_BODY = { status: "ready", exportId: "e1", url: PDF_MOCK_URL, filename: "sara-and-omar.pdf", bytes: 2_516_582, pageCount: 41 };

test("PDF (paid): Download PDF → preparing → polls → ready downloads + 'Download again'; fits 375 px", async ({ page }) => {
  const calls = await mockPdfApi(page, [{ status: "queued" }, { status: "rendering" }, READY_BODY]);
  for (const s of ["draft-paid", "live-paid"]) {
    await open(page, s);
    await expect(page.getByTestId("publish-pdf")).toBeVisible();
    await noHorizontalOverflow(page);
  }
  const btn = page.getByTestId("pdf-download");
  await expect(btn).toHaveText("Download PDF");
  const box = (await btn.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width);

  const download = page.waitForEvent("download");
  await btn.click();
  const status = page.getByTestId("pdf-status");
  await expect(status).toHaveAttribute("data-state", /starting|preparing/);
  await expect(status).toContainText("Preparing your PDF… this can take up to a minute");
  await expect(btn).toBeDisabled();
  await noHorizontalOverflow(page);

  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  expect((await download).suggestedFilename()).toBe("sara-and-omar.pdf");
  await expect(status).toContainText("Your PDF is ready");
  await expect(page.getByTestId("pdf-ready-detail")).toHaveText("2.4 MB · 41 pages");
  const again = page.getByTestId("pdf-download-again");
  await expect(again).toHaveAttribute("href", PDF_MOCK_URL);
  expect((await again.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page).toHaveURL(/\/dev-publish\?state=live-paid/); // the page stays
  await noHorizontalOverflow(page);
  expect(calls).toEqual(["POST ", "GET ?exportId=e1", "GET ?exportId=e1", "GET ?exportId=e1"]);
});

test("PDF (paid): failed job and daily cap show copy and allow a retry", async ({ page }) => {
  await mockPdfApi(page, [{ status: "failed", error: "render_timeout" }]);
  await open(page, "draft-paid");
  await page.getByTestId("pdf-download").click();
  const status = page.getByTestId("pdf-status");
  await expect(status).toHaveAttribute("data-state", "error", { timeout: 10_000 });
  await expect(status).toContainText("We couldn't make your PDF — try again");
  await expect(page.getByTestId("pdf-download")).toHaveText("Try again");
  await expect(page.getByTestId("pdf-download")).toBeEnabled();
  await noHorizontalOverflow(page);

  await page.unrouteAll({ behavior: "wait" });
  await mockPdfApi(page, [], { status: 429, body: { error: "daily_cap" } });
  await page.getByTestId("pdf-download").click();
  await expect(status).toHaveAttribute("data-code", "daily_cap");
  await expect(status).toContainText("You've made a lot of PDFs today — try again tomorrow");
});

test("PDF (free): no download button — upgrade only", async ({ page }) => {
  for (const s of ["draft", "live", "expired"]) {
    await open(page, s);
    await expect(page.getByTestId("pdf-download")).toHaveCount(0);
    await expect(page.getByTestId("publish-pdf")).toHaveCount(0);
  }
  await open(page, "draft");
  await expectUpgradeState(page, "publish-upgrade");
});

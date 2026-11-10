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
  await expect(page.getByTestId("publish-upgrade")).toBeDisabled();
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

// Task 8 — the storybook generation screen (wizard step 6) and the editor's Story actions, on the
// dev-only fixtures (no sign-in, no DB, no AI; /dev-story-run and /dev-editor 404 in production →
// run against `next dev`). Writes the 375 px screenshots docs/design/task8-*.png.
//
//   npx playwright test e2e/task8-story-generation.spec.ts --workers=1
//   (against another server: TASK8_BASE=http://localhost:3118 …)
//
// The signed-in end-to-end round (a real book through Design → step 6 → editor, refresh mid-run,
// Stop / Try again, Rewrite story against the API) is in the "live" block below: it only runs with
// E2E_AUTH=1 (deferred until after Task 10 — not run as part of Task 8).
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.TASK8_BASE ?? "";
const W = 375;
/** Screenshots go here (TASK8_SHOTS to keep them out of a running dev server's tree, then copy). */
const SHOTS = process.env.TASK8_SHOTS ?? "docs/design";
test.use({ viewport: { width: W, height: 812 }, deviceScaleFactor: 2 });

async function settle(page: Page) {
  await page.evaluate(async () => {
    document.querySelectorAll("nextjs-portal").forEach((e) => e.remove());
    await document.fonts.ready;
    // lazy images off screen never decode: wait for the visible ones, at most 3 s
    const visible = [...document.images].filter((i) => i.loading !== "lazy" || i.getBoundingClientRect().top < innerHeight);
    await Promise.race([Promise.all(visible.map((i) => i.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
  });
}

async function openRun(page: Page, state: string) {
  const res = await page.goto(`${BASE}/dev-story-run?state=${state}`, { waitUntil: "networkidle" });
  test.skip(res?.status() === 404, "dev fixture (next dev only)");
  await expect(page.getByTestId("wizard-step-story-generation")).toBeVisible();
  await expect(page.getByTestId("dev-story-run")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
  await settle(page);
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W);
}

test.describe("step 6 — Your memories are becoming a story. (dev fixture)", () => {
  test("running at stage 3: real counts only, no percentage, Stop is a 44 px target", async ({ page }) => {
    await openRun(page, "running");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your memories are becoming a story.");
    const rows = page.getByTestId("story-stages").locator("li");
    await expect(rows).toHaveCount(4);
    await expect(page.getByTestId("story-stage-discovering")).toContainText("Discovering your best moments");
    await expect(page.getByTestId("story-stage-discovering-detail")).toHaveText("40 photos");
    await expect(page.getByTestId("story-stage-organizing-detail")).toHaveText("7 moments · 3 chapters");
    await expect(page.getByTestId("story-stage-writing")).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("story-stage-writing-detail")).toHaveText("Chapter 2 of 3");
    await expect(page.getByTestId("story-stage-designing")).toHaveAttribute("data-status", "pending");
    expect(await page.locator("body").innerText()).not.toContain("%");
    await expect(page.locator('[role="progressbar"], progress')).toHaveCount(0);
    await expect(page.getByTestId("story-live")).toHaveText("Writing your story — Chapter 2 of 3");
    const stop = await page.getByTestId("story-stop").boundingBox();
    expect(stop!.height).toBeGreaterThanOrEqual(44);
    await noHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS}/task8-step6-running.png`, fullPage: true });
  });

  test("Stop → the stopped card; Continue my story runs again", async ({ page }) => {
    await openRun(page, "running");
    await page.getByTestId("story-stop").click();
    await expect(page.getByTestId("story-stopped")).toHaveAttribute("data-code", "cancelled");
    await expect(page.getByTestId("story-stopped-reason")).toContainText("You stopped this");
    await page.getByTestId("story-try-again").click();
    await expect(page.getByTestId("story-progress")).toHaveAttribute("data-phase", "running");
  });

  test("cancelled (refresh after Stop)", async ({ page }) => {
    await openRun(page, "cancelled");
    await expect(page.getByTestId("story-stage-writing")).toHaveAttribute("data-status", "failed");
    await expect(page.getByTestId("story-try-again")).toHaveText("Continue my story");
    await noHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS}/task8-step6-cancelled.png`, fullPage: true });
  });

  test("failed with a plain reason and Try again (+ Open my book when it has pages)", async ({ page }) => {
    await openRun(page, "failed");
    await expect(page.getByTestId("story-stage-designing")).toHaveAttribute("data-status", "failed");
    await expect(page.getByTestId("story-stopped-reason")).toContainText("The book changed while we were designing it");
    await expect(page.getByTestId("story-try-again")).toHaveText("Try again");
    await expect(page.getByTestId("story-open-book")).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS}/task8-step6-failed.png`, fullPage: true });
  });

  test("made without AI: the honest line, then the editor", async ({ page }) => {
    await openRun(page, "rule");
    await expect(page.getByTestId("story-outcome")).toContainText("Made without AI");
    await expect(page.getByTestId("dev-story-opened")).toHaveText("editor", { timeout: 5000 });
  });
});

async function openStoryEditor(page: Page) {
  const res = await page.goto(`${BASE}/dev-editor?story=1&ai=replay`, { waitUntil: "networkidle" });
  test.skip(res?.status() === 404, "dev fixture (next dev only)");
  await expect(page.getByTestId("editor-shell")).toBeVisible();
  await expect(page.getByTestId("editor-tool-story")).toBeVisible({ timeout: 30_000 });
  await settle(page);
}

test.describe("editor Story actions (dev fixture)", () => {
  test("the actions sheet: Rewrite story · Change photo · Regenerate page · View chapters", async ({ page }) => {
    await openStoryEditor(page);
    await page.getByTestId("editor-tool-story").click();
    await expect(page.getByTestId("story-actions")).toBeVisible();
    for (const id of ["story-action-rewrite", "story-action-photo", "story-action-page", "story-action-chapters"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId("story-action-rewrite")).toBeDisabled(); // nothing selected yet
    await noHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS}/task8-editor-actions.png` });
  });

  test("Regenerate page: a new layout for the page, one Undo", async ({ page }) => {
    await openStoryEditor(page);
    await page.getByTestId("carousel-next").click();
    await page.getByTestId("carousel-next").click();
    await page.getByTestId("editor-tool-story").click();
    await page.getByTestId("story-action-page").click();
    const msg = page.getByTestId("story-action-message");
    if (await msg.isVisible().catch(() => false)) return; // that page has only one fitting layout
    await expect(page.getByTestId("editor-toast")).toContainText("New layout for page");
    await page.getByTestId("editor-toast").getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("editor-toast")).toHaveCount(0);
  });

  test("Rewrite story on the user's own words: a proposal to accept or keep", async ({ page }) => {
    await openStoryEditor(page);
    await page.route("**/api/books/*/story-rewrite", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Two of us, one long evening by the water.", lang: "en", proposal: true }) }));
    // pages with story text: the first carousel page that shows a tap target for a text
    for (let i = 0; i < 6; i++) {
      const target = page.locator('[data-testid="carousel-item"][aria-hidden="false"] [data-testid="page-text-target"]').first();
      if (await target.count()) {
        await target.click();
        break;
      }
      await page.getByTestId("carousel-next").click();
    }
    await expect(page.getByTestId("page-text-input")).toBeVisible();
    await page.getByTestId("page-text-input").fill("Our own words about the first evening by the sea.");
    await page.getByTestId("editor-tool-story").click();
    await page.getByTestId("story-action-rewrite").click();
    await page.getByTestId("story-rewrite-shorter").click();
    await expect(page.getByTestId("story-proposal-text")).toHaveText("Two of us, one long evening by the water.");
    await expect(page.getByTestId("story-proposal-text")).toHaveAttribute("dir", "auto");
    await noHorizontalScroll(page);
    await page.getByTestId("story-proposal").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/task8-rewrite-proposal.png` });
    await page.getByTestId("story-proposal-discard").click();
    await expect(page.getByTestId("story-proposal")).toHaveCount(0);
  });

  test("View chapters: titles + page ranges, tap to jump", async ({ page }) => {
    await openStoryEditor(page);
    await page.getByTestId("editor-tool-story").click();
    await page.getByTestId("story-action-chapters").click();
    await expect(page.getByTestId("story-chapters")).toBeVisible();
    const rows = page.locator('[data-testid^="story-chapter-"]');
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    await expect(rows.first()).toContainText(/Pages? \d/);
    await noHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS}/task8-view-chapters.png` });
    await rows.nth(1).click();
    await expect(page.getByTestId("story-chapters")).toHaveCount(0);
  });

  test("an outcome line after a partial generation, dismissible", async ({ page }) => {
    const res = await page.goto(`${BASE}/dev-editor?story=1&ai=replay&outcome=partial`, { waitUntil: "networkidle" });
    test.skip(res?.status() === 404, "dev fixture (next dev only)");
    await expect(page.getByTestId("story-outcome-notice")).toContainText("Some chapters have no text yet");
    await page.getByTestId("story-outcome-dismiss").click();
    await expect(page.getByTestId("story-outcome-notice")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------- live (deferred)

test.describe("live storybook generation (E2E_AUTH=1, signed-in, hosted DB)", () => {
  test.skip(process.env.E2E_AUTH !== "1", "signed-in e2e deferred until after Task 10");
  test("Design → step 6 → stages advance → refresh re-attaches → editor opens; Stop / Continue; Rewrite story", async () => {
    // Written for the final end-to-end round (uses e2e/helpers like task5-story-wizard.spec.ts):
    //   1. sign in a test user, create a book through steps 1–5 with 6 photos (AI_MODE=replay)
    //   2. Design Continue → URL ?step=6, headline "Your memories are becoming a story.", rows advance
    //   3. reload mid-run → same run id continues (no second POST /api/ai/story-runs)
    //   4. Stop → "You stopped this"; Continue my story → finishes; the editor opens (no step 7)
    //   5. editor: Story → View chapters, Regenerate page + Undo, Rewrite story (shorter) on AI text
    //   6. AI_MODE=off variant: "Made without AI" outcome line in the editor
    test.fixme(true, "run in the post-Task-10 live round");
  });
});

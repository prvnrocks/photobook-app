// Task 8 — the storybook generation screen (wizard step 6) and the editor's Story actions, on the
// dev-only fixtures (no sign-in, no DB, no AI; /dev-story-run and /dev-editor 404 in production →
// run against `next dev`). Writes the 375 px screenshots docs/design/task8-*.png.
//
//   npx playwright test e2e/task8-story-generation.spec.ts --workers=1
//   (against another server: TASK8_BASE=http://localhost:3118 …)
//
// The signed-in round (a real book through Design → step 6 → editor, refresh mid-run, Stop /
// Continue my story) is in the "live" block below: it only runs with E2E_AUTH=1 against a
// `next start` replay server (the dev-fixture tests above skip there — their routes 404).
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { createBookViaWizard, finishBookSetup, wizardStepUrl } from "./helpers/create-book";

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
    await expect(page.getByTestId("story-stage-discovering-detail")).toHaveText("40 photos · 9 similar set aside · 1 blurry");
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

// ---------------------------------------------------------------------------- live (signed-in)
//
// E2E_AUTH=1 against a `next start` server with AI_MODE=replay and an empty ANTHROPIC_API_KEY (hosted
// Supabase). ONE throwaway user `e2e+task8-<random>@example.com` (admin generateLink, no email).
// Every tick (POST /api/ai/story-runs/<id>/advance) is delayed 1.5 s on the test side so a refresh
// and a Stop land while the job runs. The editor's Story actions on a real book are covered by
// e2e/storybook-full-flow.spec.ts. afterAll (always): storage under `<uid>/`, the user, its runs.

test.describe("live storybook generation (E2E_AUTH=1, signed-in, hosted DB)", () => {
  test.skip(process.env.E2E_AUTH !== "1", "set E2E_AUTH=1 (signed-in, hosted DB, replay server)");
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: W, height: 812 }, hasTouch: true, isMobile: true });

  let admin: SupabaseClient;
  let uid = "";
  let email = "";
  let bookId = "";
  let ctx: BrowserContext;
  let page: Page;
  const startPosts: string[] = [];

  const listAll = async (bucket: string, prefix: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (p: string, depth: number) => {
      const res = await admin.storage.from(bucket).list(p, { limit: 1000 });
      if (res.error) throw new Error(`storage list failed (${res.error.message})`);
      for (const e of res.data ?? []) {
        if (e.id || depth >= 3) out.push(`${p}/${e.name}`);
        else await walk(`${p}/${e.name}`, depth + 1);
      }
    };
    await walk(prefix, 0);
    return out;
  };
  const runsOf = async () =>
    ((await admin.from("agent_runs").select("id, state, trigger, mode, error_code").eq("book_id", bookId).order("started_at")).data ?? []) as { id: string; state: string; trigger: string; mode: string; error_code: string | null }[];

  test.beforeAll(async ({ browser }, info) => {
    if (!process.env.SUPABASE_SECRET_KEY) process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    email = `e2e+task8-${randomBytes(6).toString("hex")}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
    uid = data.user.id;
    ctx = await browser.newContext({ viewport: { width: W, height: 812 }, baseURL: String(info.project.use.baseURL ?? ""), hasTouch: true, isMobile: true });
    page = await ctx.newPage();
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/ai/story-runs") startPosts.push("start");
    });
    await page.route(/\/api\/ai\/story-runs\/[0-9a-f-]{36}\/advance$/, async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue().catch(() => {});
    });
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error || !link.data.properties?.hashed_token) throw new Error("generateLink failed");
    await page.goto(`/auth/confirm?token_hash=${link.data.properties.hashed_token}&type=magiclink&next=/books/new`);
    await expect(page).toHaveURL(/\/books\/new(\?step=1)?$/, { timeout: 30_000 });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    if (!uid) return;
    await ctx?.close().catch(() => {});
    const runIds = ((await admin.from("agent_runs").select("id").eq("user_id", uid)).data ?? []).map((r) => (r as { id: string }).id);
    let removed = 0;
    for (const bucket of ["photos", "exports"]) {
      const paths = await listAll(bucket, uid);
      for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      removed += paths.length;
    }
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (runIds.length) await admin.from("agent_runs").delete().in("id", runIds);
    let left = 0;
    for (const bucket of ["photos", "exports"]) left += (await listAll(bucket, uid)).length;
    const books = (await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid)).count ?? 0;
    const runsLeft = runIds.length ? ((await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", runIds)).count ?? 0) : 0;
    console.log(`[task8 cleanup] objects removed=${removed} left=${left} books=${books} runs=${runIds.length} runsLeft=${runsLeft} userDeleted=${!error}`);
    expect(error).toBeNull();
    expect(left + books + runsLeft).toBe(0);
  });

  test("Design → step 6 → stages advance → refresh re-attaches → Stop / Continue my story → the editor opens (no step 7)", async () => {
    test.setTimeout(600_000);
    bookId = await createBookViaWizard(page, { title: "Task eight live", occasion: "family", goto: false });
    await page.getByTestId("upload-input").setInputFiles(await syntheticJpegs(6));
    await finishBookSetup(page);
    await page.waitForURL(wizardStepUrl(bookId, "6"), { timeout: 240_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your memories are becoming a story.");
    await expect(page.getByTestId("story-stages").locator("li")).toHaveCount(4);
    // "N photos" (+ " · k similar set aside · j blurry" when the filters set photos aside)
    await expect(page.getByTestId("story-stage-discovering-detail")).toHaveText(/^\d+ photos?(?: · \d+ similar set aside)?(?: · \d+ blurry)?$/, { timeout: 60_000 });
    const [first] = await runsOf();
    expect(first).toMatchObject({ trigger: "storybook", mode: "replay" });
    expect(startPosts).toHaveLength(1);

    // refresh mid-run → the same run continues (no second start)
    await page.reload();
    await expect(page.getByTestId("wizard-step-story-generation")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("story-progress")).toHaveAttribute("data-phase", "running", { timeout: 30_000 });
    expect(startPosts).toHaveLength(1);
    expect((await runsOf()).map((r) => r.id)).toEqual([first.id]);

    // Stop → "You stopped this"; Continue my story → a new run continues and finishes in the editor
    await page.getByTestId("story-stop").click();
    await expect(page.getByTestId("story-stopped")).toHaveAttribute("data-code", "cancelled", { timeout: 30_000 });
    await expect(page.getByTestId("story-stopped-reason")).toContainText("You stopped this");
    await expect(page.getByTestId("story-try-again")).toHaveText("Continue my story");
    await page.screenshot({ path: test.info().outputPath("task8-live-stopped.png"), fullPage: true });
    const stopped = await runsOf();
    expect(stopped[0]).toMatchObject({ id: first.id, state: "failed", error_code: "cancelled" });
    await page.getByTestId("story-try-again").click();
    await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: 420_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    const runs = await runsOf();
    console.log(`[task8 live] runs=${runs.map((r) => `${r.trigger}:${r.state}`).join(",")} starts=${startPosts.length}`);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ trigger: "storybook", state: "done" });
    const doc = (await admin.from("books").select("doc").eq("id", bookId).single()).data as { doc: { pages?: unknown[] } };
    expect(doc.doc.pages?.length ?? 0).toBeGreaterThan(0);
    // the editor's Story tool is there on a real storybook
    await expect(page.getByTestId("editor-tool-story")).toBeVisible({ timeout: 30_000 });
  });
});

/** `n` distinct noisy JPEGs made in node (no canvas): sharp is a dependency of the app. */
function syntheticJpegs(n: number) {
  return Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const w = 900;
      const h = 1200;
      const raw = Buffer.alloc(w * h * 3);
      let s = (i + 1) * 2654435761;
      for (let p = 0; p < raw.length; p += 3) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const block = ((Math.floor(p / 3 / w / 100) * 9 + Math.floor(((p / 3) % w) / 100)) * 37 + i * 101) % 255;
        raw[p] = (block + (s & 31)) % 255;
        raw[p + 1] = (block * 3 + ((s >> 5) & 31)) % 255;
        raw[p + 2] = (block * 7 + ((s >> 10) & 31)) % 255;
      }
      const buffer = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
      return { name: `task8-${i + 1}.jpg`, mimeType: "image/jpeg", buffer };
    }),
  );
}

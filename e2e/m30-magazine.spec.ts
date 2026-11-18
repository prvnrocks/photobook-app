/**
 * Milestone 30 — Magazine + Editorial styles (D-090).
 *
 * 1. DEV (no auth; `next dev` only — the dev fixtures 404 under `next start`):
 *    /dev-editor?style=magazine|editorial (+ &format=landscape, &ar=1, &desc=0, &ai=replay)
 *      - chapter description: tap the area → "About this chapter" → edit → word counter → one undo;
 *        clear → the edit-only placeholder (the description panel is gone from the page) → undo;
 *      - a chapter without a description and a whole book without any (`&desc=0`, what a rule /
 *        AI-off album looks like): placeholder only, no description text anywhere;
 *      - AI help with POST /api/ai/rewrite MOCKED (page.route — never reaches the server): body is
 *        `{ target: "description", chapterId }` without a pageId → preview → Use this → undo;
 *      - Accent colour (behind More on phones): six swatches, a tap recolours the page, one undo;
 *      - Cover style lists the style's 4 covers (auto + 3), a tap changes the cover, one undo;
 *      - Arabic (`&ar=1`): dir=auto field resolves to RTL, Arabic faces, no overflow;
 *      - 375 px: no horizontal overflow at any step.
 *      Locators are scoped to the current `editor-page` by `data-position` (the carousel keeps the
 *      neighbours mounted off-screen, and Playwright's :visible matches them).
 *    /dev-book-page?sheet=magazine|editorial-portrait|landscape (+ &ar=1, &desc=0): every text panel
 *      fits its box (same method as scripts/sheet-probe.mjs: distinct line tops × line-height vs the
 *      box, never scrollHeight), book faces only, and `&desc=0` draws no description panel and fewer
 *      blocks (the `when` blocks collapse with it).
 *    /dev-style: the wizard's style step (StepStyle) — six cards in order, 2 per row at 375 px and 3
 *      from `sm`, Magazine + Editorial selectable, no overflow (the signed-in wizard is in m20-wizard).
 *    /dev-print?m30=magazine|editorial (+ &format=landscape, &ar=1) &sheets=0-9: the same small book
 *      through <PrintDocument> (what /print/[bookId] renders) → page.pdf with the production options
 *      → scripts/pdf-inspect.mjs + pdf-analyze.mjs: 10 sheets with bleed, fonts embedded, no Type3,
 *      no soft masks, the description is real text.
 *
 * 2. LIVE (opt-in E2E_AUTH=1, hosted Supabase WITH migration 20261118002100_design_styles_m30 —
 *    probed, the test skips with a clear message when it is missing). Server: production build,
 *    `next start` with AI_MODE=replay (or AI_MODE=off) and an EMPTY ANTHROPIC_API_KEY — never calls
 *    Anthropic. One throwaway user `e2e+m30-<random>@example.com` (admin createUser + generateLink,
 *    no email). The same test runs in both modes and branches on the wizard API's `aiOn`:
 *      replay: travel → Magazine preselected → 12 photos → build → editor shows a chapter
 *              description (source ai) → edit it (source user) → accent colour (source user) →
 *              publish → anonymous viewer: masthead cover + the edited description, no `source` in
 *              the snapshot → paid (service-role is_paid, as the webhook writes it) → Download PDF →
 *              scripts/pdf-inspect.mjs: fonts embedded, no Type3 (skipped when the exports migration
 *              is missing);
 *      off:    rule album → no chapter has a description, no page uses a description layout (no
 *              empty dark panels), the viewer draws no description text.
 *    afterAll (always, like e2e/ai-auth.spec.ts): storage under `<uid>/` removed, user deleted
 *    (books / photos cascade), nothing left; the agent_runs it created stay detached (D-027).
 *    Logs: counts / booleans / layout ids only — never photo or description text.
 *
 * Example (scratch copy of HEAD, see .agentos/runs/m30.md → T14a):
 *   dev:   AI_MODE=replay npx next dev -p 3930 ; npx playwright test -c <config baseURL :3930> e2e/m30-magazine.spec.ts
 *   live:  NEXT_PUBLIC_APP_URL=http://localhost:3931 AI_MODE=replay ANTHROPIC_API_KEY= next build && … next start -p 3931
 *          E2E_AUTH=1 npx playwright test -c <config baseURL :3931, no webServer> e2e/m30-magazine.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { colourwaysFor } from "../src/lib/design/colourways";
import { getLayout } from "../src/lib/layouts";
import { chaptersShowingDescription, layoutIdShowsDescription } from "../src/lib/layouts/description";
import { cardRadio, createBookViaWizard, finishWizardToEditor, waitForSortingOrReview, WIZARD_STYLES } from "./helpers/create-book";

type M30Style = "magazine" | "editorial";

const PHONE = { width: 375, height: 812 };
const PLACEHOLDER = "Add a few lines about this chapter";
const DESCRIPTION = '[data-text-panel="chapterDescription"]';

const carousel = (page: Page) => page.getByTestId("page-carousel");
const cur = (page: Page) => page.locator('[data-testid="carousel-item"][aria-hidden="false"]');
const counter = (page: Page) => page.getByTestId("page-counter");
/** The editor page at doc position `pos` ("cover" | 0-based page index) — never a carousel neighbour. */
const editorPage = (page: Page, pos: number | "cover") => page.locator(`[data-testid="editor-page"][data-position="${pos}"]`);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function expectNoOverflow(page: Page, label: string) {
  expect(await overflow(page), `horizontal overflow: ${label}`).toBeLessThanOrEqual(0);
}

/**
 * Wait until the scroll-snap carousel rests on the current slide: it no longer moves and lies inside
 * the carousel (phones: flush with its left edge; desktop: the slide is narrower and centred).
 */
async function settle(page: Page) {
  await expect
    .poll(
      async () => {
        const c = await carousel(page).boundingBox();
        const b1 = await cur(page).boundingBox();
        await page.waitForTimeout(100);
        const b2 = await cur(page).boundingBox();
        if (!c || !b1 || !b2) return false;
        return Math.abs(b1.x - b2.x) < 1 && b2.x >= c.x - 2 && b2.x + b2.width <= c.x + c.width + 2;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
}

/** Carousel item number: 0 = cover, n = the item whose counter reads "n / total". */
async function itemOf(page: Page): Promise<number> {
  const t = (await counter(page).innerText()).trim();
  return t.startsWith("Cover") ? 0 : Number(t.split("/")[0].trim());
}

async function goToItem(page: Page, n: number) {
  for (let i = 0; i < 40 && (await itemOf(page)) !== n; i++) {
    const at = await itemOf(page);
    await page.getByTestId(at < n ? "carousel-next" : "carousel-prev").click();
    await expect.poll(() => itemOf(page)).not.toBe(at);
    await settle(page);
  }
  expect(await itemOf(page)).toBe(n);
}

/** Step the carousel until the editor page at doc position `pos` is in the current item. */
async function goToPosition(page: Page, pos: number) {
  for (let i = 0; i < 60; i++) {
    if ((await cur(page).locator(`[data-testid="editor-page"][data-position="${pos}"]`).count()) > 0) return;
    // Desktop shows two pages per item ("1–2 / 9"): compare the counter text, not a number.
    const at = await counter(page).innerText();
    await page.getByTestId("carousel-next").click();
    await expect.poll(() => counter(page).innerText()).not.toBe(at);
    await settle(page);
  }
  throw new Error(`page position ${pos} not reached`);
}

/**
 * Doc position of the editor page that DRAWS the description panel of the layout owned by position
 * `owner`: the owner itself, or — for a spread whose panel sits on the right half — `owner + 1`.
 * Leaves the carousel on that page.
 */
async function descriptionPosition(page: Page, owner: number, spread: boolean): Promise<number> {
  for (const pos of spread ? [owner, owner + 1] : [owner]) {
    await goToPosition(page, pos);
    if ((await editorPage(page, pos).locator(DESCRIPTION).count()) > 0) return pos;
  }
  throw new Error(`no description panel drawn for the layout at position ${owner}`);
}

/** Open a tool that sits behind More on phones (desktop: the sidebar rail has every tool). */
async function viaMore(page: Page, id: string) {
  if ((await page.getByTestId("editor-tool-rail").count()) > 0) {
    await page.getByTestId(`editor-tool-${id}`).click();
    return;
  }
  await page.getByTestId("editor-more").click();
  await expect(page.getByTestId("editor-more-sheet")).toBeVisible();
  await page.getByTestId(`editor-tool-${id}`).click();
}

async function waitSaved(page: Page, timeout = 10_000) {
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout });
}

/** Every colour the page draws with: block fills + text colours, in DOM order (accent recolours them). */
function paint(scope: Locator): Promise<string> {
  return scope.evaluate((el) =>
    [...el.querySelectorAll("[data-block], [data-text-panel] p")]
      .map((n) => {
        const s = getComputedStyle(n);
        return n.hasAttribute("data-block") ? `b:${s.backgroundColor}|${s.fill}` : `t:${s.color}`;
      })
      .join(";"),
  );
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// =================================================================================================
// 1. DEV
// =================================================================================================

test.describe("M30 editor tools on /dev-editor", () => {
  const errors: string[] = [];
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/dev-editor?style=magazine");
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
  test.afterEach(() => expect(errors, "no page errors").toEqual([]));

  async function open(page: Page, query: string) {
    await page.goto(`/dev-editor?${query}`);
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    await expect(counter(page)).toContainText("Cover");
    await settle(page);
  }

  /** Page 1 (doc position 0) carries chapter 1's description in every fixture. */
  async function openDescription(page: Page, query: string) {
    await open(page, query);
    await goToPosition(page, 0);
    const pg = editorPage(page, 0);
    await expect(pg).toHaveCount(1);
    const target = pg.getByTestId("description-target");
    await expect(target).toHaveCount(1);
    await expect(target).not.toHaveAttribute("data-empty", "true");
    await target.click();
    await expect(page.getByTestId("description-editor")).toBeVisible();
    await expect(target).toHaveAttribute("data-selected", "true");
    return { pg, target };
  }

  const BOOKS: Array<{ name: string; query: string; style: M30Style; landscape: boolean }> = [
    { name: "magazine portrait", query: "style=magazine", style: "magazine", landscape: false },
    { name: "magazine landscape", query: "style=magazine&format=landscape", style: "magazine", landscape: true },
    { name: "editorial portrait", query: "style=editorial", style: "editorial", landscape: false },
    { name: "editorial landscape", query: "style=editorial&format=landscape", style: "editorial", landscape: true },
  ];

  test.describe("375 px", () => {
    test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

    for (const b of BOOKS) {
      test(`${b.name}: description edit → counter → undo; clear → placeholder → undo`, async ({ page }) => {
        const { pg, target } = await openDescription(page, b.query);
        const input = page.getByTestId("description-input");
        const original = await input.inputValue();
        expect(words(original)).toBe(45);
        await expect(input).toHaveAttribute("dir", "auto");
        await expect(input).toHaveAttribute("maxlength", "400");
        await expect(page.getByTestId("description-count")).toHaveText(`45 of 45 words · ${original.length}/400`);
        await expect(page.getByTestId("description-long-hint")).toHaveCount(0);
        await expect(pg.locator(DESCRIPTION)).toContainText(original.slice(0, 40));
        await expectNoOverflow(page, "description panel open");

        // Edit: the page follows the field, the counter counts words and characters.
        const mine = "Two slow days by the sea, and nobody looked at a clock.";
        await input.fill(mine);
        await expect(page.getByTestId("description-count")).toHaveText(`12 of 45 words · ${mine.length}/400`);
        await expect(pg.locator(DESCRIPTION)).toHaveText(mine);
        await waitSaved(page);
        await expectNoOverflow(page, "description edited");

        // Past 45 words: the soft hint (never a block).
        const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
        await input.fill(long);
        await expect(page.getByTestId("description-count")).toContainText("50 of 45 words");
        await expect(page.getByTestId("description-long-hint")).toBeVisible();
        await expectNoOverflow(page, "long description");

        // The whole typing session is ONE undo step back to the AI text.
        await page.getByTestId("editor-undo").click();
        await expect(pg.locator(DESCRIPTION)).toContainText(original.slice(0, 40));
        await expect(page.getByTestId("editor-undo")).toBeDisabled();

        // Clear → the description is removed: no panel text on the page, the edit-only hint instead.
        if (!(await page.getByTestId("description-input").isVisible())) await target.click();
        await expect(page.getByTestId("description-input")).toBeVisible();
        await page.getByTestId("description-input").fill("");
        await expect(pg.locator(DESCRIPTION)).toHaveCount(0);
        await expect(pg.getByTestId("description-target")).toHaveAttribute("data-empty", "true");
        await expect(pg.getByTestId("description-placeholder")).toHaveText(PLACEHOLDER);
        await expect(pg.locator('[data-description-area="empty"]')).toHaveCount(1);
        await expect(page.getByTestId("description-count")).toHaveText("0 of 45 words · 0/400");
        await waitSaved(page);
        await expectNoOverflow(page, "description cleared");

        await page.getByTestId("editor-undo").click();
        await expect(pg.locator(DESCRIPTION)).toContainText(original.slice(0, 40));
        await expect(pg.getByTestId("description-placeholder")).toHaveCount(0);
      });
    }

    test("a chapter without a description shows the placeholder; typing there adds one", async ({ page }) => {
      await open(page, "style=magazine");
      // Page 3 (position 2): a description layout whose chapter (2) has no description.
      await goToItem(page, 3);
      const pg = editorPage(page, 2);
      await expect(pg.getByTestId("description-placeholder")).toHaveText(PLACEHOLDER);
      await expect(pg.locator(DESCRIPTION)).toHaveCount(0);
      const box = (await pg.getByTestId("description-target").boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      await pg.getByTestId("description-target").click();
      await expect(page.getByTestId("description-input")).toHaveValue("");
      await page.getByTestId("description-input").fill("A quiet road and a long lunch.");
      await expect(pg.locator(DESCRIPTION)).toHaveText("A quiet road and a long lunch.");
      await expect(pg.getByTestId("description-placeholder")).toHaveCount(0);
      await expectNoOverflow(page, "description added");
      await page.getByTestId("editor-undo").click();
      await expect(pg.getByTestId("description-placeholder")).toHaveText(PLACEHOLDER);
    });

    for (const style of ["magazine", "editorial"] as const) {
      test(`${style} &desc=0 (rule / AI-off album): placeholders only, no description text on any page`, async ({ page }) => {
        await open(page, `style=${style}&desc=0`);
        const total = Number(/(\d+) pages/.exec(await counter(page).innerText())?.[1] ?? 0);
        expect(total).toBeGreaterThan(0);
        let placeholders = 0;
        // Each carousel item is a page or a spread: walk until the last position was seen.
        for (let item = 1; item <= total; item++) {
          await page.getByTestId("carousel-next").click();
          await settle(page);
          const here = cur(page);
          await expect(here.locator(DESCRIPTION)).toHaveCount(0);
          await expect(here.locator('[data-description-area="filled"]')).toHaveCount(0);
          placeholders += await here.getByTestId("description-placeholder").count();
          await expectNoOverflow(page, `desc=0 item ${item}`);
          if ((await here.locator(`[data-testid="editor-page"][data-position="${total - 1}"]`).count()) > 0) break;
        }
        expect(placeholders).toBeGreaterThanOrEqual(2);
      });
    }

    test("read-only: the description is not a tap target and Accent colour is absent", async ({ page }) => {
      await open(page, "style=magazine&state=readOnly");
      await expect(page.getByTestId("editor-tool-cover-style")).toHaveCount(0);
      await page.getByTestId("editor-more").click();
      await expect(page.getByTestId("editor-more-sheet")).toBeVisible();
      await expect(page.getByTestId("editor-tool-accent")).toHaveCount(0);
      await page.getByTestId("editor-more-close").click();
      await expect(page.getByTestId("editor-more-sheet")).toBeHidden();
      await goToItem(page, 1);
      await expect(editorPage(page, 0).locator(DESCRIPTION)).toHaveCount(1);
      await expect(editorPage(page, 0).getByTestId("description-target")).toHaveCount(0);
      await goToItem(page, 3);
      await expect(editorPage(page, 2).getByTestId("description-placeholder")).toHaveCount(0);
    });

    for (const style of ["magazine", "editorial"] as const) {
      test(`${style}: AI help (mocked rewrite) → preview → Use this → page + Saved ✓ → undo`, async ({ page }) => {
        let posted: Record<string, unknown> | null = null;
        let calls = 0;
        const rewritten = "Up before the sun, tea in the valley, home in gold light.";
        await page.route("**/api/ai/rewrite", async (route) => {
          calls++;
          posted = route.request().postDataJSON() as Record<string, unknown>;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: rewritten, lang: "en", remaining: 17 }) });
        });
        const { pg } = await openDescription(page, `style=${style}&ai=replay`);
        const original = await page.getByTestId("description-input").inputValue();
        await page.getByTestId("description-open-ai").click();
        await expect(page.getByTestId("ai-description-menu")).toBeVisible();
        // A description has no tone options (those belong to captions).
        await expect(page.locator('[data-testid^="ai-option-tone-"]')).toHaveCount(0);
        await expectNoOverflow(page, "AI menu");
        await page.getByTestId("ai-option-shorter").click();
        await expect(page.getByTestId("ai-preview")).toHaveText(rewritten);
        await expect(page.getByTestId("ai-rewrites-left")).toContainText("17");
        expect(calls).toBe(1);
        expect(posted).toMatchObject({ target: "description", chapterId: "c1", instruction: "shorter", text: original });
        expect(posted).not.toHaveProperty("pageId");
        expect(posted).not.toHaveProperty("targetLang");
        // Nothing changed yet: only "Use this" writes the doc.
        await expect(pg.locator(DESCRIPTION)).toContainText(original.slice(0, 40));
        await expectNoOverflow(page, "AI preview");
        await page.getByTestId("ai-use-this").click();
        await expect(pg.locator(DESCRIPTION)).toHaveText(rewritten);
        await waitSaved(page);
        await page.getByTestId("editor-undo").click();
        await expect(pg.locator(DESCRIPTION)).toContainText(original.slice(0, 40));
        expect(calls).toBe(1);
      });
    }

    test("AI help, Keep mine: the description stays; AI off: options disabled with the description wording", async ({ page }) => {
      await page.route("**/api/ai/rewrite", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Short and sweet.", lang: "en", remaining: 3 }) }),
      );
      const { pg } = await openDescription(page, "style=editorial&ai=replay");
      const original = await page.getByTestId("description-input").inputValue();
      await page.getByTestId("description-open-ai").click();
      await page.getByTestId("ai-option-rewrite").click();
      await expect(page.getByTestId("ai-preview")).toHaveText("Short and sweet.");
      await page.getByTestId("ai-keep-mine").click();
      await expect(pg.locator(DESCRIPTION)).toContainText(original.slice(0, 40));
      await expect(page.getByTestId("editor-undo")).toBeDisabled();

      await openDescription(page, "style=editorial&ai=off");
      await page.getByTestId("description-open-ai").click();
      await expect(page.getByTestId("ai-description-blocked")).toContainText("AI writing isn't switched on yet");
      await expect(page.getByTestId("ai-option-rewrite")).toBeDisabled();
      await expectNoOverflow(page, "AI off");
    });

    for (const b of BOOKS) {
      test(`${b.name}: Accent colour via More → six swatches → the page recolours → one undo`, async ({ page }) => {
        await open(page, b.query);
        const cover = editorPage(page, "cover");
        const ids = colourwaysFor(b.style).map((c) => c.id);
        expect(ids).toHaveLength(6);
        const before = await paint(cover);
        expect(before.length).toBeGreaterThan(0);

        await viaMore(page, "accent");
        await expect(page.getByTestId("accent-picker")).toBeVisible();
        const options = page.getByTestId("accent-option");
        await expect(options).toHaveCount(6);
        expect(await options.evaluateAll((els) => els.map((e) => e.getAttribute("data-colourway")))).toEqual(ids);
        // The fixture's colourway (the style's second one, as a build would stamp it) is current.
        await expect(page.locator('[data-testid="accent-option"][aria-pressed="true"]')).toHaveCount(1);
        await expect(page.locator('[data-testid="accent-option"][aria-pressed="true"]')).toHaveAttribute("data-colourway", ids[1]);
        for (let i = 0; i < 6; i++) {
          const box = (await options.nth(i).boundingBox())!;
          expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
        }
        await expectNoOverflow(page, "accent picker");

        // Tapping the current one is a no-op (no undo step).
        await page.locator(`[data-testid="accent-option"][data-colourway="${ids[1]}"]`).click();
        await expect(page.getByTestId("editor-undo")).toBeDisabled();

        const pick = ids[3];
        await page.locator(`[data-testid="accent-option"][data-colourway="${pick}"]`).click();
        await expect(page.locator('[data-testid="accent-option"][aria-pressed="true"]')).toHaveAttribute("data-colourway", pick);
        await expect.poll(() => paint(cover), { message: "cover colours follow the accent" }).not.toBe(before);
        await waitSaved(page);
        // The docked panel stays open and the page stays on screen.
        await expect(page.getByTestId("accent-picker")).toBeVisible();
        await expectNoOverflow(page, "accent picked");

        await page.getByTestId("editor-undo").click();
        await expect.poll(() => paint(cover)).toBe(before);
        await expect(page.locator('[data-testid="accent-option"][aria-pressed="true"]')).toHaveAttribute("data-colourway", ids[1]);
        await expect(page.getByTestId("editor-undo")).toBeDisabled();
      });

      test(`${b.name}: Cover style lists the 4 ${b.style} covers; a tap changes the cover; one undo`, async ({ page }) => {
        await open(page, b.query);
        const cover = editorPage(page, "cover").locator('[data-page="cover"]');
        const before = (await cover.getAttribute("data-layout"))!;
        await page.getByTestId("editor-tool-cover-style").click();
        await expect(page.getByTestId("cover-style-picker")).toBeVisible();
        const options = page.getByTestId("cover-style-option");
        await expect(options).toHaveCount(4);
        const ids = await options.evaluateAll((els) => els.map((e) => e.getAttribute("data-layout-id") ?? ""));
        expect(new Set(ids).size).toBe(4);
        for (const id of ids) {
          const l = getLayout(id);
          expect(l, id).toBeTruthy();
          expect({ role: l!.role, style: l!.style, format: l!.format }, id).toEqual({
            role: "cover",
            style: b.style,
            format: b.landscape ? "A5_LANDSCAPE" : "A5_PORTRAIT",
          });
        }
        // One auto cover (the build's) + three user-only styles.
        expect(ids.filter((id) => getLayout(id)?.autoPick !== false)).toEqual([before]);
        await expect(page.locator('[data-testid="cover-style-option"][aria-pressed="true"]')).toHaveAttribute("data-layout-id", before);
        await expectNoOverflow(page, "cover styles");

        for (const id of ids.filter((x) => x !== before)) {
          await page.locator(`[data-testid="cover-style-option"][data-layout-id="${id}"]`).click();
          await expect(cover).toHaveAttribute("data-layout", id);
          await expectNoOverflow(page, `cover ${id}`);
        }
        await waitSaved(page);
        for (let i = 0; i < 3; i++) await page.getByTestId("editor-undo").click();
        await expect(cover).toHaveAttribute("data-layout", before);
        await expect(page.getByTestId("editor-undo")).toBeDisabled();
      });
    }

    for (const b of BOOKS) {
      test(`${b.name} Arabic (&ar=1): RTL field, Arabic faces on the page, no overflow on any page`, async ({ page }) => {
        const { pg } = await openDescription(page, `${b.query}&ar=1`);
        const input = page.getByTestId("description-input");
        await expect(input).toHaveAttribute("dir", "auto");
        await expect(input).toHaveAttribute("lang", "ar");
        expect(await input.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
        expect(await input.inputValue()).toMatch(/[؀-ۿ]/);
        const p = pg.locator(`${DESCRIPTION} p`).first();
        await expect(p).toHaveAttribute("dir", "auto");
        const face = await p.evaluate((el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim());
        expect(face).toMatch(/Tajawal|Cairo|Lalezar/);
        await expectNoOverflow(page, "arabic description");
        await page.getByTestId("editor-panel-close").click();
        const total = Number(/(\d+)\s*$/.exec((await counter(page).innerText()).trim())?.[1] ?? 0);
        for (let i = 0; i < 12; i++) {
          if (await page.getByTestId("carousel-next").isDisabled()) break;
          await page.getByTestId("carousel-next").click();
          await settle(page);
          await expectNoOverflow(page, `arabic item ${await itemOf(page)} of ${total}`);
        }
      });
    }

    test("older styles: no Accent colour tool, no description targets", async ({ page }) => {
      await open(page, "sample=geometric-portrait");
      await page.getByTestId("editor-more").click();
      await expect(page.getByTestId("editor-more-sheet")).toBeVisible();
      await expect(page.getByTestId("editor-tool-accent")).toHaveCount(0);
      await expect(page.getByTestId("description-target")).toHaveCount(0);
    });
  });

  test.describe("desktop 1280", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    for (const style of ["magazine", "editorial"] as const) {
      test(`${style}: description + accent from the rail, no overflow`, async ({ page }) => {
        const { pg } = await openDescription(page, `style=${style}`);
        const input = page.getByTestId("description-input");
        const original = await input.inputValue();
        await input.fill("Desktop edit of the chapter text.");
        await expect(pg.locator(DESCRIPTION)).toHaveText("Desktop edit of the chapter text.");
        await expect(page.getByTestId("description-count")).toHaveText("6 of 45 words · 33/400");
        await expectNoOverflow(page, "desktop description");
        await page.getByTestId("editor-undo").click();
        await expect(pg.locator(DESCRIPTION)).toContainText(original.slice(0, 40));

        // Deselect (a second tap on the selected area) → the rail offers the book tools, Accent colour among them.
        if ((await pg.getByTestId("description-target").getAttribute("data-selected")) === "true") await pg.getByTestId("description-target").click();
        await expect(pg.getByTestId("description-target")).not.toHaveAttribute("data-selected", "true");
        const before = await paint(pg);
        await viaMore(page, "accent");
        await expect(page.getByTestId("accent-option")).toHaveCount(6);
        const ids = colourwaysFor(style).map((c) => c.id);
        await page.locator(`[data-testid="accent-option"][data-colourway="${ids[4]}"]`).click();
        await expect.poll(() => paint(pg), { message: "page colours follow the accent" }).not.toBe(before);
        await expectNoOverflow(page, "desktop accent");
        await page.getByTestId("editor-undo").click();
        await expect.poll(() => paint(pg)).toBe(before);
      });
    }
  });
});

// ---- contact sheets ------------------------------------------------------------------------------

type PanelRow = { layout: string; bind: string; font: string; lines: number; need: number; have: number; over: boolean };

/** scripts/sheet-probe.mjs, in the page: distinct line tops × line-height (+ ink padding) vs the box. */
function probeSheet(page: Page): Promise<PanelRow[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-text-panel] p, [data-caption-area] p")].map((p) => {
      const box = p.parentElement!;
      const cs = getComputedStyle(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      const rects = [...range.getClientRects()];
      const turned = !!p.closest("[data-text-turn]");
      const lines = new Set(rects.map((r) => Math.round(turned ? r.left : r.top))).size;
      const need = lines * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const have = box.clientHeight;
      const panel = p.closest<HTMLElement>("[data-text-panel]");
      return {
        layout: p.closest<HTMLElement>("[data-layout]")?.dataset.layout ?? "?",
        bind: panel ? (panel.dataset.textPanel ?? "?") : "pageCaption",
        font: cs.fontFamily.split(",")[0].replace(/"/g, ""),
        lines,
        need: Math.round(need * 10) / 10,
        have,
        over: need > have + 0.5 || p.scrollWidth > box.clientWidth + 1,
      };
    }),
  );
}

test.describe("M30 contact sheets on /dev-book-page", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/dev-book-page?sheet=magazine-portrait");
    test.skip(res.status() === 404, "/dev-book-page is dev-only (404 under next start)");
  });

  const SHEETS = ["magazine-portrait", "magazine-landscape", "editorial-portrait", "editorial-landscape"] as const;
  /** First family of the computed font: the book faces of the two styles (CSS names; Latin + Arabic partners). */
  const FACES = /^(bookArchivoBlack|bookPoppins|bookLalezar|Tajawal)$/;

  async function openSheet(page: Page, query: string) {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const res = await page.goto(`/dev-book-page?${query}`, { waitUntil: "networkidle" });
    expect(res?.status()).toBe(200);
    await page.evaluate(async () => {
      document.querySelectorAll("nextjs-portal").forEach((e) => e.remove());
      await document.fonts.ready;
    });
    await page.waitForTimeout(500);
    return errors;
  }

  for (const sheet of SHEETS) {
    const [style, shape] = sheet.split("-") as [M30Style, "portrait" | "landscape"];
    for (const variant of [
      { name: "EN 1300", extra: "", viewport: { width: 1300, height: 900 } },
      { name: "AR 1300", extra: "&ar=1", viewport: { width: 1300, height: 900 } },
      { name: "EN 375", extra: "", viewport: PHONE },
      { name: "AR 375", extra: "&ar=1", viewport: PHONE },
    ]) {
      test(`${sheet} ${variant.name}: every layout renders, 0 overflowing text panels, book faces only`, async ({ page }) => {
        await page.setViewportSize(variant.viewport);
        const errors = await openSheet(page, `sheet=${sheet}${variant.extra}`);
        const rows = await probeSheet(page);
        const over = rows.filter((r) => r.over);
        console.log(`[sheet] ${sheet} ${variant.name}: panels=${rows.length} over=${over.length}`);
        expect(rows.length).toBeGreaterThan(30);
        expect(over.map((r) => `${r.layout} ${r.bind} need=${r.need} have=${r.have}`)).toEqual([]);
        expect([...new Set(rows.map((r) => r.font))].filter((f) => !FACES.test(f))).toEqual([]);
        // Every layout of the sheet is this style + shape, covers and spreads included.
        const layouts = [...new Set(await page.locator("[data-layout]").evaluateAll((els) => els.map((e) => e.getAttribute("data-layout") ?? "")))];
        expect(layouts.length).toBeGreaterThanOrEqual(16);
        for (const id of layouts) {
          const l = getLayout(id);
          expect(l, id).toBeTruthy();
          expect({ style: l!.style, format: l!.format }, id).toEqual({ style, format: shape === "portrait" ? "A5_PORTRAIT" : "A5_LANDSCAPE" });
        }
        expect(layouts.filter((id) => getLayout(id)?.role === "cover")).toHaveLength(4);
        expect(layouts.filter((id) => getLayout(id)?.role === "spread").length).toBeGreaterThanOrEqual(2);
        expect(await page.locator(DESCRIPTION).count()).toBeGreaterThan(0);
        if (variant.viewport.width === 375) expect(await overflow(page), "sheet horizontal overflow at 375").toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      });
    }

    test(`${sheet} &desc=0: no description panel anywhere, the 'when' blocks collapse, 0 overflowing`, async ({ page }) => {
      await page.setViewportSize({ width: 1300, height: 900 });
      await openSheet(page, `sheet=${sheet}`);
      const withBlocks = await page.locator("[data-block]").count();
      const errors = await openSheet(page, `sheet=${sheet}&desc=0`);
      const rows = await probeSheet(page);
      expect(rows.filter((r) => r.over).map((r) => `${r.layout} ${r.bind}`)).toEqual([]);
      await expect(page.locator(DESCRIPTION)).toHaveCount(0);
      // View mode: nothing is drawn where a description would go (the hint is editor-only).
      await expect(page.locator("[data-description-area]")).toHaveCount(0);
      const without = await page.locator("[data-block]").count();
      console.log(`[sheet] ${sheet} desc=0: blocks ${withBlocks} → ${without}`);
      expect(without).toBeLessThan(withBlocks);
      expect(errors).toEqual([]);
    });
  }
});

// ---- style step (wizard step 4) on the style board ------------------------------------------------

test.describe("M30 style step on /dev-style (the wizard's StepStyle, static)", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/dev-style");
    test.skip(res.status() === 404, "/dev-style is dev-only (404 under next start)");
  });

  for (const vp of [
    { name: "375 px", viewport: PHONE, perRow: 2 },
    { name: "1280 px", viewport: { width: 1280, height: 800 }, perRow: 3 },
  ]) {
    test(`${vp.name}: six style cards in order, ${vp.perRow} per row, Magazine + Editorial selectable, no overflow`, async ({ page }) => {
      await page.setViewportSize(vp.viewport);
      await page.goto("/dev-style");
      for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"]) {
        const step = page.getByTestId(`dev-style-step-${format}`);
        await step.scrollIntoViewIfNeeded();
        const cards = step.locator('[data-testid^="style-"]:not([data-testid^="style-spread-"])');
        expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(WIZARD_STYLES.map((s) => `style-${s}`));
        const boxes = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
        expect(new Set(boxes.map((b) => Math.round(b.y))).size, `${format}: rows`).toBe(6 / vp.perRow);
        for (const b of boxes) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w).toBeLessThanOrEqual(vp.viewport.width + 0.5);
          expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(44);
        }
        // Each card draws its own two-page spread (the new styles have their own preview art).
        for (const s of WIZARD_STYLES) await expect(step.getByTestId(`style-spread-${s}`)).toHaveCount(1);
        await expect(step.locator('input[type="radio"]:checked')).toHaveCount(1);
        for (const s of ["magazine", "editorial"] as const) {
          await step.getByTestId(`style-${s}`).click();
          await expect(step.getByTestId(`style-${s}`).locator('input[type="radio"]')).toBeChecked();
          await expect(step.locator('input[type="radio"]:checked')).toHaveCount(1);
        }
      }
      expect(await overflow(page), "style board horizontal overflow").toBeLessThanOrEqual(0);
    });
  }
});

// ---- print: <PrintDocument> → PDF ------------------------------------------------------------------

type PdfInspect = {
  pageCount: number;
  fonts: { baseFont: string | null; family: string | null; subtype: string | null; embedded: boolean; type3: boolean }[];
  imageStreams: { count: number; dct: number; filters: string[] };
  pages: { n: number; mediaBox: { wMm: number; hMm: number } | null; trimBox: { wMm: number; hMm: number } | null; text: string }[];
};
type PdfAnalyzePage = { page: number; images: { smask: string }[]; forms: number; tgroups: number; patterns: unknown[]; gstates: { smask: string; ca?: number; CA?: number; BM?: string | null }[] };

const SCRIPTS = path.join(__dirname, "..", "scripts");
function inspectPdf(file: string): PdfInspect {
  return JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, "pdf-inspect.mjs"), file], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }).toString()) as PdfInspect;
}
function analyzePdf(file: string): PdfAnalyzePage[] {
  const out = execFileSync(process.execPath, [path.join(SCRIPTS, "pdf-analyze.mjs"), file], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }).toString();
  return out
    .split("\n")
    .filter((l) => l.startsWith('{"page"'))
    .map((l) => JSON.parse(l) as PdfAnalyzePage);
}

test.describe("M30 print on /dev-print (<PrintDocument>, the markup /print/[bookId] renders)", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/dev-print?m30=magazine&sheets=0-0");
    test.skip(res.status() === 404, "/dev-print is dev-only (404 under next start)");
  });

  for (const style of ["magazine", "editorial"] as const) {
    for (const landscape of [false, true]) {
      for (const arabic of [false, true]) {
        const name = `${style} ${landscape ? "landscape" : "portrait"} ${arabic ? "AR" : "EN"}`;
        test(`${name}: cover + 9 pages → PDF with bleed boxes, embedded fonts, no Type3, no soft masks`, async ({ page }, info) => {
          test.setTimeout(120_000);
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(String(e)));
          const q = `m30=${style}${landscape ? "&format=landscape" : ""}${arabic ? "&ar=1" : ""}&sheets=0-9`;
          const res = await page.goto(`/dev-print?${q}`);
          expect(res?.status()).toBe(200);
          await page.waitForFunction(() => (window as { __PRINT_READY__?: boolean }).__PRINT_READY__ === true, null, { timeout: 60_000 });
          await expect(page.locator("[data-print-document] > [data-print-sheet]")).toHaveCount(10);
          // The description pages draw their paragraph in print; nothing editor-only is printed.
          expect(await page.locator(DESCRIPTION).count()).toBeGreaterThanOrEqual(2);
          await expect(page.locator("[data-description-area]")).toHaveCount(0);

          // Same options as src/lib/pdf/render-pdf.ts.
          const file = info.outputPath(`m30-${style}-${landscape ? "landscape" : "portrait"}-${arabic ? "ar" : "en"}.pdf`);
          await page.pdf({ path: file, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
          const r = inspectPdf(file);
          const families = [...new Set(r.fonts.map((f) => `${f.baseFont}:${f.subtype}:${f.embedded ? "emb" : "NOT-emb"}`))];
          console.log(`[print] ${name}: pages=${r.pageCount} images=${r.imageStreams.count} fonts=${JSON.stringify(families)}`);
          expect(r.pageCount).toBe(10);
          const [w, h] = landscape ? [216, 154] : [154, 216];
          for (const p of r.pages) {
            expect(Math.abs((p.mediaBox?.wMm ?? 0) - w), `page ${p.n} width`).toBeLessThanOrEqual(0.5);
            expect(Math.abs((p.mediaBox?.hMm ?? 0) - h), `page ${p.n} height`).toBeLessThanOrEqual(0.5);
          }
          expect(r.fonts.length).toBeGreaterThan(0);
          expect(r.fonts.filter((f) => f.type3).map((f) => f.baseFont)).toEqual([]);
          expect(r.fonts.filter((f) => !f.embedded).map((f) => f.baseFont)).toEqual([]);
          const names = r.fonts.map((f) => String(f.baseFont)).join(" ");
          // The style's own faces reach the PDF (heavy display face + the body face; Arabic partners).
          if (arabic) expect(names).toMatch(/Tajawal/);
          else expect(names).toMatch(/Poppins/);
          if (style === "magazine") expect(names).toMatch(arabic ? /Lalezar/ : /ArchivoBlack|Archivo/);
          // Text is real text (selectable), incl. the chapter description on page 2 (sheet 1).
          const text = r.pages.map((p) => p.text).join(" ");
          if (arabic) expect(text).toMatch(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/);
          else expect(text.replace(/\s+/g, " ")).toContain("followed the old road");

          const pages = analyzePdf(file);
          expect(pages).toHaveLength(10);
          const softMasks = pages.flatMap((p) => [...p.images.filter((i) => i.smask).map(() => `page ${p.page} image smask`), ...p.gstates.filter((g) => g.smask).map(() => `page ${p.page} gstate smask`)]);
          const alpha = pages.reduce((n, p) => n + p.gstates.filter((g) => !g.smask).length, 0);
          const forms = pages.reduce((n, p) => n + p.forms, 0);
          const tgroups = pages.reduce((n, p) => n + p.tgroups, 0);
          const patterns = pages.reduce((n, p) => n + p.patterns.length, 0);
          console.log(`[print] ${name}: softMasks=${softMasks.length} constAlphaGstates=${alpha} forms=${forms} tgroups=${tgroups} patterns=${patterns}`);
          expect(softMasks).toEqual([]);
          expect(patterns).toBe(0);
          expect(errors).toEqual([]);
        });
      }
    }
  }
});

// =================================================================================================
// 2. LIVE (E2E_AUTH=1)
// =================================================================================================

const LIVE = process.env.E2E_AUTH === "1";
if (LIVE && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

type LiveDoc = {
  version: number;
  format: string;
  cover: { layout: string; photoId: string | null; title: string };
  chapters: { id: string; title: string; description?: { text: string; source: "ai" | "user" } }[];
  pages: { id: string; chapterId: string | null; layout: string; side?: "left" | "right" }[];
  style: { designStyle?: string; colourway?: { id: string; source: "ai" | "user" } };
};
type LiveRow = { doc: LiveDoc; design_style: string; occasion: string; format: string; slug: string | null; is_paid: boolean; published_doc: unknown };

test.describe("M30 magazine book end to end (live, E2E_AUTH=1)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 to run the live signed-in magazine flow (needs migration 2100 on the DB)");
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  const BUCKETS = ["photos", "exports"];
  const REPO = path.join(__dirname, "..");
  let admin: SupabaseClient;
  let uid = "";
  const runIds = new Set<string>();

  async function userObjects(bucket: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (prefix: string, depth: number) => {
      const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
      for (const e of data ?? []) {
        if (e.id) out.push(`${prefix}/${e.name}`);
        else if (depth < 4) await walk(`${prefix}/${e.name}`, depth + 1);
      }
    };
    await walk(uid, 0);
    return out;
  }

  test.afterAll(async () => {
    if (!uid) return;
    // Every run this user created (collected before the user delete nulls user_id).
    const mine = await admin.from("agent_runs").select("id").eq("user_id", uid);
    for (const r of mine.data ?? []) runIds.add(r.id as string);
    let removed = 0;
    for (const bucket of BUCKETS) {
      for (let round = 0; round < 3; round++) {
        const paths = await userObjects(bucket);
        if (!paths.length) break;
        for (let i = 0; i < paths.length; i += 100) {
          const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
          if (error) console.log(`[cleanup] storage remove error (${error.message})`);
        }
        removed += paths.length;
      }
    }
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) console.log(`[cleanup] deleteUser error (${error.code})`);
    let left = 0;
    for (const bucket of BUCKETS) left += (await userObjects(bucket)).length;
    const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
    const photos = await admin.from("photos").select("id", { count: "exact", head: true }).eq("user_id", uid);
    const runsByUser = await admin.from("agent_runs").select("id", { count: "exact", head: true }).eq("user_id", uid);
    const ids = [...runIds];
    let runsLeft = 0;
    let runsWithUser = 0;
    let runsWithBook = 0;
    let stepsWithOutput = 0;
    if (ids.length) {
      const r = await admin.from("agent_runs").select("id, user_id, book_id").in("id", ids);
      runsLeft = r.data?.length ?? 0;
      runsWithUser = (r.data ?? []).filter((x) => x.user_id !== null).length;
      runsWithBook = (r.data ?? []).filter((x) => x.book_id !== null).length;
      const s = await admin.from("agent_steps").select("output").in("run_id", ids);
      stepsWithOutput = (s.data ?? []).filter((x) => x.output !== null).length;
    }
    console.log(
      `[cleanup] objects removed=${removed} left=${left} books left=${books.count} photos left=${photos.count} runsByUser=${runsByUser.count} userDeleted=${!error}; runs created=${ids.length} remaining=${runsLeft} withUser=${runsWithUser} withBook=${runsWithBook} stepsWithOutput=${stepsWithOutput}`,
    );
    expect(left).toBe(0);
    expect(books.count).toBe(0);
    expect(photos.count).toBe(0);
    expect(runsByUser.count).toBe(0);
    expect(error).toBeNull();
    // D-027: runs stay (costs kept) but are detached and step outputs scrubbed.
    expect(runsWithUser).toBe(0);
    expect(runsWithBook).toBe(0);
    expect(stepsWithOutput).toBe(0);
  });

  test("travel → Magazine preselected → build → description + accent → publish → viewer (→ PDF when paid)", async ({ browser }, info) => {
    test.setTimeout(900_000);
    admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const baseURL = String(info.project.use.baseURL ?? "");

    const email = `e2e+m30-${randomBytes(6).toString("hex")}@example.com`;
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser failed (${created.error?.code ?? "no user"})`);
    uid = created.data.user.id;

    // Migration 20261118002100 (books.design_style check allows magazine / editorial): probed with a
    // throwaway row of this user — without it every magazine create fails with a check violation.
    const probe = await admin.from("books").insert({ user_id: uid, title: "m30 probe", occasion: "other", tone: "fun", design_style: "editorial" }).select("id").single();
    console.log(`[setup] migration 2100 probe=${probe.error?.code ?? "ok"}`);
    if (probe.data?.id) await admin.from("books").delete().eq("id", probe.data.id);
    test.skip(probe.error?.code === "23514", "migration 20261118002100_design_styles_m30 is NOT applied to the live project — run `npx supabase db push`, then re-run");
    expect(probe.error).toBeNull();

    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error || !link.data.properties?.hashed_token) throw new Error("generateLink failed");
    const context = await browser.newContext({ viewport: PHONE, baseURL, hasTouch: true, isMobile: true, acceptDownloads: true });
    const page = await context.newPage();
    page.on("dialog", (d) => void d.accept());
    await page.goto(`/auth/confirm?token_hash=${link.data.properties.hashed_token}&type=magiclink&next=/books/new`);
    await expect(page).toHaveURL(/\/books\/new(\?step=1)?$/);

    const row = async (): Promise<LiveRow> => {
      const { data, error } = await admin.from("books").select("doc, design_style, occasion, format, slug, is_paid, published_doc").eq("id", bookId).single();
      if (error) throw new Error(`books select failed (${error.code})`);
      return data as unknown as LiveRow;
    };

    // 1. Wizard: six style cards, travel → Magazine preselected (D-090) — nothing is clicked on step 4.
    const bookId = await createBookViaWizard(page, {
      title: "Hajar week",
      occasion: "travel",
      format: "A5_PORTRAIT",
      expectStyle: "magazine",
      goto: false,
      beforeContinue: async (step) => {
        if (step !== 5) return; // the Design step (after the upload — Task 5 order)
        for (const s of WIZARD_STYLES) await expect(page.getByTestId(`style-${s}`)).toBeVisible();
        await expect(cardRadio(page, "style-magazine")).toBeChecked();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      },
    });
    expect(await row()).toMatchObject({ design_style: "magazine", occasion: "travel", format: "A5_PORTRAIT" });
    const wizard = await page.context().request.get(`/api/books/${bookId}/wizard?step=3`);
    expect(wizard.status()).toBe(200);
    const aiOn = ((await wizard.json()) as { aiOn?: boolean }).aiOn === true;
    console.log(`[a] server aiOn=${aiOn}`);

    // 2. Photos → build (replay or rule) → review → Generate album → editor.
    await page.getByTestId("upload-input").setInputFiles(await synthetic(page, 12));
    await waitForSortingOrReview(page, bookId, 240_000);
    await finishWizardToEditor(page, bookId, { timeout: 420_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible();
    for (const r of (await admin.from("agent_runs").select("id").eq("user_id", uid)).data ?? []) runIds.add(r.id as string);

    const built = (await row()).doc;
    const described = built.chapters.filter((c) => c.description);
    const descPages = built.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.side !== "right" && layoutIdShowsDescription(p.layout));
    console.log(
      `[a] built version=${built.version} style=${built.style.designStyle} cover=${built.cover.layout} pages=${built.pages.length} chapters=${built.chapters.length} described=${described.length} sources=${JSON.stringify(described.map((c) => c.description!.source))} descPages=${descPages.length} colourway=${built.style.colourway?.id ?? "-"}:${built.style.colourway?.source ?? "-"}`,
    );
    expect(built.version).toBe(2);
    expect(built.style.designStyle).toBe("magazine");
    expect(getLayout(built.cover.layout)).toMatchObject({ role: "cover", style: "magazine", format: "A5_PORTRAIT" });
    for (const p of built.pages) expect(getLayout(p.layout)?.style, p.layout).toBe("magazine");
    if (built.style.colourway) expect(colourwaysFor("magazine").map((c) => c.id)).toContain(built.style.colourway.id);
    // The cover is the masthead cover in the editor.
    await expect(editorPage(page, "cover").locator('[data-page="cover"]')).toHaveAttribute("data-layout", built.cover.layout);
    await expect(editorPage(page, "cover").locator('[data-text-panel="coverTitle"]')).toContainText(/hajar week/i);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    if (!aiOn) {
      // ---- AI off: a rule album has no descriptions and never uses a description layout ----------
      expect(described).toHaveLength(0);
      expect(descPages.map(({ p }) => p.layout), "rule albums avoid description layouts (no empty dark panels)").toEqual([]);
      const total = Number(/(\d+) pages/.exec(await counter(page).innerText())?.[1] ?? 0);
      for (let i = 0; i < total + 2; i++) {
        await expect(cur(page).locator(DESCRIPTION)).toHaveCount(0);
        await expect(cur(page).locator('[data-description-area="filled"]')).toHaveCount(0);
        if (await page.getByTestId("carousel-next").isDisabled()) break;
        await page.getByTestId("carousel-next").click();
        await settle(page);
      }
      // Accent colour still works on a rule album.
      await goToItem(page, 0);
    } else {
      // ---- replay: the Caption Writer wrote chapter descriptions (source ai) -----------------------
      expect(described.length).toBeGreaterThan(0);
      for (const c of described) {
        expect(c.description!.source).toBe("ai");
        expect(words(c.description!.text)).toBeLessThanOrEqual(45);
        expect(c.description!.text.length).toBeLessThanOrEqual(400);
      }
      // Exactly one description page per described chapter.
      for (const c of described) expect(descPages.filter(({ p }) => p.chapterId === c.id), `chapter ${c.id}`).toHaveLength(1);
      const first = descPages.find(({ p }) => described.some((c) => c.id === p.chapterId))!;
      const chapter = described.find((c) => c.id === first.p.chapterId)!;
      // A spread layout is owned by its LEFT half (first.i) but may draw the description panel on
      // the right half (mg-p-spread-feature): on a phone that is the next carousel item.
      const descPos = await descriptionPosition(page, first.i, first.p.side === "left");
      console.log(`[a] description layout=${first.p.layout} owner position=${first.i} drawn at=${descPos}`);
      const pg = editorPage(page, descPos);
      await expect(pg.locator(DESCRIPTION)).toHaveText(chapter.description!.text);
      await pg.getByTestId("description-target").click();
      const input = page.getByTestId("description-input");
      await expect(input).toHaveValue(chapter.description!.text);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      // Edit by hand → saved as the user's text (never overwritten by AI afterwards).
      const mine = "Edited by hand: the road, the tea, the long way home.";
      await input.fill(mine);
      await expect(pg.locator(DESCRIPTION)).toHaveText(mine);
      await waitSaved(page, 20_000);
      await expect.poll(async () => (await row()).doc.chapters.find((c) => c.id === chapter.id)?.description, { timeout: 15_000 }).toEqual({ text: mine, source: "user" });
      await page.getByTestId("editor-panel-close").click();
      await goToItem(page, 0);
    }

    // 3. Accent colour → stored as the user's choice.
    const ids = colourwaysFor("magazine").map((c) => c.id);
    const current = (await row()).doc.style.colourway?.id ?? ids[0];
    const pick = ids.find((id) => id !== current)!;
    const coverPaint = await paint(editorPage(page, "cover"));
    await viaMore(page, "accent");
    await expect(page.getByTestId("accent-option")).toHaveCount(6);
    await expect(page.locator('[data-testid="accent-option"][aria-pressed="true"]')).toHaveAttribute("data-colourway", current);
    await page.locator(`[data-testid="accent-option"][data-colourway="${pick}"]`).click();
    await expect.poll(() => paint(editorPage(page, "cover"))).not.toBe(coverPaint);
    await waitSaved(page, 20_000);
    await expect.poll(async () => (await row()).doc.style.colourway, { timeout: 15_000 }).toEqual({ id: pick, source: "user" });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByTestId("editor-panel-close").click();

    // 4. Publish (free) → the snapshot carries the description text and the colourway id, no `source`.
    await page.getByTestId("editor-done").click();
    await expect(page).toHaveURL(new RegExp(`/books/${bookId}/publish(\\?shared=live)?$`), { timeout: 30_000 });
    await expect(page.getByTestId("publish-message")).toHaveText("Your book is live", { timeout: 30_000 });
    const published = await row();
    const slug = published.slug ?? "";
    expect(slug).not.toBe("");
    const pub = JSON.stringify(published.published_doc);
    expect(pub).not.toContain('"source"');
    expect(pub).toContain(`"colourway":{"id":"${pick}"}`);
    if (aiOn) expect(pub).toContain("Edited by hand: the road, the tea, the long way home.");
    else expect(pub).not.toContain('"description"');

    // 5. Anonymous phone: masthead cover, the description on its page, no editor hints.
    const anon = await browser.newContext({ viewport: PHONE, baseURL, hasTouch: true, isMobile: true });
    try {
      const v = await anon.newPage();
      const errors: string[] = [];
      v.on("pageerror", (e) => errors.push(String(e)));
      const resp = await v.goto(`/b/${slug}`);
      expect(resp?.status()).toBe(200);
      await expect(v.getByTestId("flipbook")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      const cover = v.locator(`[data-page="cover"][data-layout="${published.doc.cover.layout}"]`).first();
      await expect(cover).toBeAttached();
      await expect(cover.locator('[data-text-panel="coverTitle"]').first()).toContainText(/hajar week/i);
      const mastheadFace = await cover.locator('[data-text-panel="coverTitle"] p').first().evaluate((el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim());
      console.log(`[c] viewer cover=${published.doc.cover.layout} masthead face=${mastheadFace}`);
      expect(mastheadFace).toBe("bookArchivoBlack");
      await expect(v.getByTestId("description-target")).toHaveCount(0);
      await expect(v.getByTestId("description-placeholder")).toHaveCount(0);
      expect(await overflow(v)).toBeLessThanOrEqual(0);
      const text = v.locator(DESCRIPTION).filter({ hasText: "Edited by hand" });
      if (aiOn) {
        // The flipbook may mount pages as they come near: turn until the description page exists.
        for (let i = 0; i < 40 && (await text.count()) === 0; i++) {
          if (await v.getByTestId("next-page").isDisabled()) break;
          await v.getByTestId("next-page").click();
          await v.waitForTimeout(700);
        }
        expect(await text.count()).toBeGreaterThan(0);
      } else {
        for (let i = 0; i < 40; i++) {
          await expect(v.locator(DESCRIPTION)).toHaveCount(0);
          if (await v.getByTestId("next-page").isDisabled()) break;
          await v.getByTestId("next-page").click();
          await v.waitForTimeout(500);
        }
      }
      expect(await overflow(v)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally {
      await anon.close();
    }

    // 6. PDF (paid path only, pattern of e2e/pdf.spec.ts): entitlement written as the webhook does.
    const t = await admin.from("exports").select("id").limit(1);
    const exportsReady = !t.error;
    console.log(`[d] exports table=${t.error?.code ?? "ok"}`);
    if (exportsReady) {
      const up = await admin.from("books").update({ is_paid: true, max_pages: 100, expires_at: null }).eq("id", bookId).select("is_paid");
      expect(up.error).toBeNull();
      await page.goto(`/books/${bookId}/publish`);
      const btn = page.getByTestId("pdf-download");
      await expect(btn).toBeVisible({ timeout: 30_000 });
      const download = page.waitForEvent("download", { timeout: 180_000 });
      await btn.click();
      const d = await download;
      const pdfPath = info.outputPath("m30-magazine.pdf");
      await d.saveAs(pdfPath);
      const out = execFileSync(process.execPath, [path.join(REPO, "scripts", "pdf-inspect.mjs"), pdfPath], { cwd: REPO, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 }).toString();
      const r = JSON.parse(out) as {
        pageCount: number;
        fonts: { baseFont: string | null; family: string | null; subtype: string | null; embedded: boolean; type3: boolean }[];
        pages: { n: number; mediaBox: { wMm: number; hMm: number } | null; text: string }[];
      };
      console.log(`[d] pdf pages=${r.pageCount} fonts=${JSON.stringify(r.fonts.map((f) => `${f.baseFont}:${f.subtype}:${f.embedded ? "emb" : "NOT-emb"}`))}`);
      expect(r.pageCount).toBe((await row()).doc.pages.length + 1);
      expect(r.fonts.filter((f) => f.type3)).toEqual([]);
      expect(r.fonts.filter((f) => !f.embedded)).toEqual([]);
      expect(r.fonts.some((f) => /Archivo/i.test(`${f.baseFont}${f.family}`))).toBe(true);
      for (const p of r.pages) {
        expect(Math.abs((p.mediaBox?.wMm ?? 0) - 154), `page ${p.n} width`).toBeLessThanOrEqual(0.5);
        expect(Math.abs((p.mediaBox?.hMm ?? 0) - 216), `page ${p.n} height`).toBeLessThanOrEqual(0.5);
      }
      if (aiOn) expect(r.pages.some((p) => p.text.replace(/\s+/g, " ").includes("Edited by hand"))).toBe(true);
      // pdf-analyze (same checks as the /dev-print part): no soft masks on images or graphics states.
      const analysed = analyzePdf(pdfPath);
      expect(analysed).toHaveLength(r.pageCount);
      const softMasks = analysed.flatMap((p) => [...p.images.filter((i) => i.smask).map(() => `page ${p.page} image smask`), ...p.gstates.filter((g) => g.smask).map(() => `page ${p.page} gstate smask`)]);
      const imageFilters = [...new Set(analysed.flatMap((p) => p.images.map((i) => String((i as { filter?: unknown }).filter))))];
      console.log(
        `[d] pdf-analyze softMasks=${softMasks.length} constAlphaGstates=${analysed.reduce((n, p) => n + p.gstates.filter((g) => !g.smask).length, 0)} forms=${analysed.reduce((n, p) => n + p.forms, 0)} tgroups=${analysed.reduce((n, p) => n + p.tgroups, 0)} patterns=${analysed.reduce((n, p) => n + p.patterns.length, 0)} imageFilters=${JSON.stringify(imageFilters)}`,
      );
      expect(softMasks).toEqual([]);
    }

    // 7. Review round 1 blocker (dcc89bc), through the real publish path: swap the description page
    //    to a layout WITHOUT a description panel → Publish changes → the description stays in the
    //    owner's doc but is neither in the snapshot nor in the public /b/[slug] payload.
    if (aiOn) {
      const mine = "Edited by hand: the road, the tea, the long way home.";
      const before = await row();
      const owner = before.doc.pages.findIndex((p) => p.side !== "right" && layoutIdShowsDescription(p.layout));
      expect(owner).toBeGreaterThanOrEqual(0);
      const chapterId = before.doc.pages[owner].chapterId!;
      const anonReq = await browser.newContext({ baseURL });
      try {
        const live = await anonReq.request.get(`/b/${slug}`);
        expect(live.status()).toBe(200);
        expect(await live.text(), "published description is in the public payload before the swap").toContain(mine);

        await page.goto(`/books/${bookId}/edit`);
        await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 30_000 });
        // Splitting a spread re-fits its right half, and a re-fit keeps a description layout while the
        // chapter has a description (mg-p-spread-feature → mg-p-full + mg-p-three-feature): swap every
        // page that still shows it, one Layout pick each.
        for (let round = 0; round < 4; round++) {
          const pages = (await row()).doc.pages;
          const at = pages.findIndex((p) => p.chapterId === chapterId && p.side !== "right" && layoutIdShowsDescription(p.layout));
          if (at < 0) break;
          await goToPosition(page, at);
          if ((await page.getByTestId("layout-picker").count()) === 0) await page.getByTestId("editor-tool-layout").click();
          const picker = page.getByTestId("layout-picker");
          await expect(picker).toBeVisible();
          const optionIds = await picker
            .locator('[data-testid="layout-option"][data-role="page"]:not([data-disabled]):not([aria-pressed="true"])')
            .evaluateAll((els) => els.map((e) => e.getAttribute("data-layout-id") ?? ""));
          const plain = optionIds.find((id) => !layoutIdShowsDescription(id));
          console.log(`[e] swap ${round + 1}: position=${at} from=${pages[at].layout} options=${optionIds.length} to=${plain ?? "-"}`);
          expect(plain, "an enabled one-page layout without a description panel").toBeTruthy();
          await picker.locator(`[data-testid="layout-option"][data-layout-id="${plain}"]`).click();
          await expect.poll(async () => (await row()).doc.pages[at]?.layout, { timeout: 20_000 }).toBe(plain);
          await waitSaved(page, 20_000);
        }
        expect(chaptersShowingDescription((await row()).doc.pages).has(chapterId)).toBe(false);
        // The owner's doc keeps the text (swap back → it is shown again).
        expect((await row()).doc.chapters.find((c) => c.id === chapterId)?.description).toEqual({ text: mine, source: "user" });
        // Not published yet: viewers still get the old snapshot.
        expect(await (await anonReq.request.get(`/b/${slug}`)).text()).toContain(mine);

        await expect(page.getByTestId("editor-publish-changes")).toHaveText("Publish changes", { timeout: 30_000 });
        await page.getByTestId("editor-done").click();
        await expect(page.getByTestId("publish-message")).toHaveText("Changes published", { timeout: 30_000 });
        const after = await row();
        expect(after.slug).toBe(slug);
        const snap = JSON.stringify(after.published_doc);
        expect(snap).not.toContain("Edited by hand");
        expect(snap).not.toContain('"description"');
        const res = await anonReq.request.get(`/b/${slug}`);
        expect(res.status()).toBe(200);
        const html = await res.text();
        console.log(`[e] after republish: snapshot has description=${snap.includes('"description"')} public payload has text=${html.includes("Edited by hand")} bytes=${html.length}`);
        expect(html).not.toContain("Edited by hand");
        expect(html).not.toContain("the long way home");
      } finally {
        await anonReq.close();
      }
    }
    await context.close();
  });
});

/** `n` distinct, sharp JPEGs drawn in the browser (same recipe as e2e/m29-cover-style.spec.ts). */
async function synthetic(p: Page, n: number) {
  const list = await p.evaluate(async (count) => {
    const out: string[] = [];
    for (let k = 0; k < count; k++) {
      let s = ((k + 701) * 7919 + 17) >>> 0;
      const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const c = document.createElement("canvas");
      const tall = k % 3 !== 1;
      c.width = tall ? 900 : 1200;
      c.height = tall ? 1200 : 900;
      const g = c.getContext("2d")!;
      for (let y = 0; y < c.height / 100; y++)
        for (let x = 0; x < c.width / 100; x++) {
          g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
          g.fillRect(x * 100, y * 100, 100, 100);
        }
      const img = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const d = Math.floor((r() - 0.5) * 60);
        img.data[i] += d;
        img.data[i + 1] += d;
        img.data[i + 2] += d;
      }
      g.putImageData(img, 0, 0);
      out.push(
        await new Promise<string>((resolve) =>
          c.toBlob((b) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(",")[1]);
            fr.readAsDataURL(b!);
          }, "image/jpeg", 0.92),
        ),
      );
    }
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `m30-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

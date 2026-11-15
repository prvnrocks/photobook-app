/**
 * Milestone 20 T10 — the one continuous 7-step creation wizard (D-072; supersedes m19-wizard.spec.ts,
 * whose checks are folded in here).
 *
 * Flow: /books/new steps 1–4 (title + suggestion chips · purpose tiles, no caption-language control ·
 * shape · style) → step-4 Continue creates the book and stays on the SAME document → step 5 photos
 * (upload stage) → step 6 sorting (by itself) → step 7 review (toggle photos, "Generate album") →
 * editor. URLs /books/new?book=<id>&step=5|6|7. /books/<id>/upload|build send fresh books into the
 * wizard; rebuild / AI off / edited stay classic.
 *
 * Signed out (any server): /books/start → /books/new; /books/new and a step-5 URL need sign-in.
 *
 * LIVE (E2E_AUTH=1, hosted Supabase; server: next start with AI_MODE=replay, empty ANTHROPIC_API_KEY,
 * dummy Stripe / CRON, NEXT_PUBLIC_APP_URL = its own origin). ONE throwaway user
 * `e2e+m20-<random>@example.com` (admin createUser + generateLink, no email). Serial:
 *   a. 375 continuous run (book A, Arabic title on an en-US browser): steps 1–7 audited + shot, no
 *      document navigation from step 1 to step 7 (window marker, performance.timeOrigin, document /
 *      RSC requests) with the band / stepper / wizard the same DOM nodes; books row (title, occasion,
 *      format, design_style, caption_lang 'ar'); step 7 toggle (DB, no remount, no reload); Generate
 *      → editor as a soft navigation; locked stepper on 6/7; ?trigger=rebuild stays classic.
 *   b. 375 history rules (book B): Back before any pick → step 4 edit, 1 book; M19 BUG-3 double /
 *      triple Back (same document, after a hard leave, after a soft leave) never shows a create wizard
 *      holding the old answers, still exactly 1 book; edit + save returns to 5; tone follows occasion.
 *   c. 375 (book B continued): refresh restores 5; Back while uploading stays on 5; refresh on 6
 *      resumes (no 2nd run); Back after the run stays on 6/7; refresh on 7; Generate from the
 *      hard-loaded step 7 → editor (soft navigation).
 *   d. 375 create-mode details: step-1 Arabic dir=auto, suggestion chip, back / forward 1–4, refresh on
 *      3, deep link bounce, stepper clicks on done steps 1–3, Start over (≥ 44 px), entry redirects
 *      (/books/<fresh>/upload → step 5, /build → step 6, no loops).
 *   e. 1280 continuous run (book D): steps 1–7 audited + shot, layout jump 6 → 7 measured.
 *   f. reduced motion (375, book E): no running CSS animation / transition on steps 1–7, static
 *      review count, no view transition.
 *   g. (E2E_ANALYTICS=1, server built with NEXT_PUBLIC_POSTHOG_KEY=phc_e2e_fake +
 *      NEXT_PUBLIC_POSTHOG_HOST=https://ph.e2e.invalid, intercepted) book_created exactly once for a
 *      wizard create, not again after step-5 Back + save.
 *   i. (M20b, only when the server runs AI_MODE=off — probed via the wizard API's aiOn; prod-like) step 5
 *      upload only (no sorting / auto-start text) → step 6 rule checklist (data-sort-phase progresses,
 *      ≥ 2.7 s) → step 7 ai_off banner → toggle → refresh stays 7 → Generate → editor (soft); 0
 *      document navigations 5 → 7; exactly 1 agent run (mode rule); fresh /build → wizard step 6;
 *      ?trigger=rebuild stays classic.
 *   z. audit summary (no horizontal scroll, ≥ 44 px targets, one h1, visible focus, AA contrast incl.
 *      the leather band measured against its lightest point).
 * Screenshots: docs/design/m20-step{1..7}-{375,1280}.png (dir override: M20_SHOT_DIR).
 * afterAll (always): storage under `<uid>/`, the user (books/photos cascade), then the replay
 * agent_runs this user created (ids captured first). Per-test timeouts only. Logs: counts only.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cardRadio,
  createBookViaWizard,
  expectWizardStep,
  generateAlbum,
  waitForReview,
  waitForWizardHydrated,
  walkWizardToStyle,
  wizardContinue,
  WIZARD_STEP5_URL,
  wizardStepUrl,
} from "./helpers/create-book";

const LIVE = process.env.E2E_AUTH === "1";
const ANALYTICS = process.env.E2E_ANALYTICS === "1";

if (LIVE && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const SHOT_DIR = process.env.M20_SHOT_DIR || path.join(__dirname, "..", "docs", "design");
const BUCKETS = ["photos", "exports"];
const UUID = "[0-9a-f-]{36}";
const ARABIC_TITLE = "رحلتنا إلى العين";
const TAB_STOPS = 6;
const PH_HOST = process.env.E2E_POSTHOG_HOST ?? "https://ph.e2e.invalid";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
/** The leather band's lightest point (T2: #0e3b2e + the top glow ≈ #1f5443 — conservative). */
const LEATHER_LIGHTEST: [number, number, number] = [0x1f, 0x54, 0x43];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// ---- signed out ----------------------------------------------------------------------------------

test.describe("m20 wizard (signed out)", () => {
  test("/books/start → /books/new; /books/new and a step-5 URL ask for sign-in", async ({ request }) => {
    const start = await request.get("/books/start", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(start.status());
    expect(start.headers()["location"] ?? "").toMatch(/^\/(books\/new|login\?next=%2Fbooks%2F(new|start))/);
    const nb = await request.get("/books/new?step=3", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(nb.status());
    expect(nb.headers()["location"] ?? "").toMatch(/^\/login\?next=%2Fbooks%2Fnew/);
    const id = "00000000-0000-4000-8000-000000000000";
    const s5 = await request.get(`/books/new?book=${id}&step=5`, { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(s5.status());
    expect(decodeURIComponent(s5.headers()["location"] ?? "")).toContain(`/login?next=/books/new?book=${id}&step=5`);
  });
});

// ---- live ----------------------------------------------------------------------------------------

test.describe("m20 wizard (live)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 to run the live M20 wizard walkthrough");
  test.describe.configure({ mode: "serial" });

  let admin: SupabaseClient;
  let baseURL = "";
  let uid = "";
  let email = "";
  const bookIds = new Set<string>();
  const runIds = new Set<string>();
  let phone: { context: BrowserContext; page: Page; nav: NavLog };
  let bookA = "";
  let bookB = "";
  /** The step shown ≠ the step in the URL (cosmetic; reported, not failed). */
  const urlDesync: string[] = [];

  type NavLog = { docs: string[]; rsc: string[]; actions: number; frameNav: number; reset(): void };

  function trackNavigation(page: Page): NavLog {
    const log: NavLog = {
      docs: [],
      rsc: [],
      actions: 0,
      frameNav: 0,
      reset() {
        this.docs = [];
        this.rsc = [];
        this.actions = 0;
        this.frameNav = 0;
      },
    };
    page.on("request", (r) => {
      if (r.frame() !== page.mainFrame()) return;
      const h = r.headers();
      if (r.isNavigationRequest()) log.docs.push(new URL(r.url()).pathname + new URL(r.url()).search);
      else if (h["next-action"]) log.actions++;
      else if (h["rsc"] === "1") log.rsc.push(new URL(r.url()).pathname + new URL(r.url()).search);
    });
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) log.frameNav++;
    });
    return log;
  }

  async function signInHash(): Promise<string> {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
    return data.properties.hashed_token;
  }

  async function newContext(
    browser: Browser,
    viewport: { width: number; height: number },
    opts: { analytics?: boolean; reducedMotion?: boolean } = {},
  ) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({
      viewport,
      baseURL,
      locale: "en-US",
      ...(mobile ? { hasTouch: true, isMobile: true } : {}),
      ...(opts.analytics ? { userAgent: PHONE_UA } : {}),
      ...(opts.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
    });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("pb.editor.coach.v1", "1");
      } catch {
        /* ignore */
      }
    });
    const page = await context.newPage();
    page.on("dialog", (d) => void d.accept());
    const nav = trackNavigation(page);
    await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/dashboard`);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    return { context, page, nav };
  }

  async function bookRow(id: string) {
    const { data, error } = await admin
      .from("books")
      .select("title, occasion, format, design_style, caption_lang, tone")
      .eq("id", id)
      .single();
    if (error) throw new Error(`books select failed (${error.code})`);
    return data as { title: string | null; occasion: string; format: string; design_style: string; caption_lang: string; tone: string };
  }

  async function ownedBooks(): Promise<string[]> {
    const owned = await admin.from("books").select("id").eq("user_id", uid);
    if (owned.error) throw new Error(`books select failed (${owned.error.code})`);
    const ids = (owned.data ?? []).map((b) => (b as { id: string }).id);
    for (const id of ids) bookIds.add(id);
    return ids.sort();
  }

  async function runsOf(bookId: string) {
    const { data, error } = await admin.from("agent_runs").select("id, state, trigger").eq("book_id", bookId);
    if (error) throw new Error(`agent_runs select failed (${error.code})`);
    for (const r of data ?? []) runIds.add((r as { id: string }).id);
    return (data ?? []) as { id: string; state: string; trigger: string }[];
  }

  async function shot(p: Page, step: number, width: number) {
    mkdirSync(SHOT_DIR, { recursive: true });
    await p.mouse.move(0, 0).catch(() => {});
    const loaded = await expect
      .poll(
        () =>
          p.evaluate(() =>
            Array.from(document.images).every((img) => {
              const r = img.getBoundingClientRect();
              const inView = r.width > 0 && r.bottom > 0 && r.top < innerHeight;
              return !inView || (img.complete && img.naturalWidth > 0);
            }),
          ),
        { timeout: 15_000 },
      )
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    if (!loaded) console.log(`[shot step ${step} ${width}] some in-view images still not loaded`);
    await p.evaluate(() => {
      document.querySelectorAll("nextjs-portal").forEach((n) => n.remove());
      window.scrollTo(0, 0);
      (document.activeElement as HTMLElement | null)?.blur?.();
    });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(SHOT_DIR, `m20-step${step}-${width}.png`), fullPage: true, animations: "disabled" });
  }

  async function listUserObjects(bucket: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (prefix: string, depth: number) => {
      const res = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
      if (res.error) throw new Error(`storage list failed (${res.error.message})`);
      for (const e of res.data ?? []) {
        if (e.id || depth >= 3) out.push(`${prefix}/${e.name}`);
        else await walk(`${prefix}/${e.name}`, depth + 1);
      }
    };
    await walk(uid, 0);
    return out;
  }

  /** Replay ticks take ~0 ms: hold every run API response so step 6 stays on screen. Records run ids. */
  async function holdRunResponses(p: Page, delayMs: number) {
    await p.route(/\/api\/ai\/runs(\/|\?|$)/, async (route) => {
      let res;
      try {
        res = await route.fetch();
      } catch {
        return; // page gone
      }
      const body = await res.text().catch(() => "");
      try {
        const j = JSON.parse(body) as { run?: { id?: string }; id?: string; runId?: string };
        const id = j.runId ?? j.run?.id ?? j.id;
        if (typeof id === "string" && new RegExp(`^${UUID}$`).test(id)) runIds.add(id);
      } catch {
        /* not json */
      }
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        await route.fulfill({ response: res, body });
      } catch {
        /* the page navigated away */
      }
    });
  }

  /** Slow every storage upload so the upload phase of step 5 lasts long enough to press Back. */
  async function slowUploads(p: Page, delayMs: number) {
    await p.route(/\/storage\/v1\/object\//, async (route) => {
      if (route.request().method() === "GET") return route.continue();
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        await route.continue();
      } catch {
        /* page gone */
      }
    });
  }

  /** Tags the document + the band / stepper / wizard nodes; docState() proves they are the same later. */
  async function markDocument(p: Page) {
    return p.evaluate(() => {
      const w = window as unknown as { __m20doc?: string };
      w.__m20doc = Math.random().toString(36).slice(2);
      for (const id of ["wizard-band", "wizard-stepper", "new-book-wizard"]) {
        const el = document.querySelector(`[data-testid="${id}"]`) as (Element & { __m20?: string }) | null;
        if (el) el.__m20 = w.__m20doc;
      }
      return { doc: w.__m20doc, timeOrigin: performance.timeOrigin };
    });
  }

  async function docState(p: Page) {
    return p.evaluate(() => {
      const w = window as unknown as { __m20doc?: string };
      const same = (id: string) => {
        const el = document.querySelector(`[data-testid="${id}"]`) as (Element & { __m20?: string }) | null;
        return el !== null && w.__m20doc !== undefined && el.__m20 === w.__m20doc;
      };
      return {
        doc: w.__m20doc ?? null,
        timeOrigin: performance.timeOrigin,
        navEntries: performance.getEntriesByType("navigation").length,
        band: same("wizard-band"),
        stepper: same("wizard-stepper"),
        wizard: same("new-book-wizard"),
      };
    });
  }

  async function pickPhotos(p: Page, n: number, seed: number) {
    await expect(p.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
    await p.getByTestId("upload-input").setInputFiles(await makeSynthetic(p, n, seed));
  }

  async function runningAnimations(p: Page): Promise<{ n: number; names: string[] }> {
    return p.evaluate(() => {
      const list = document.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const t = a.effect?.getComputedTiming();
        return !t || Number(t.duration) > 1 || t.iterations === Infinity;
      });
      return {
        n: list.length,
        names: list
          .slice(0, 8)
          .map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? "anim"}@${((a.effect as KeyframeEffect | null)?.target as Element | null)?.className?.toString().slice(0, 30) ?? "?"}`),
      };
    });
  }

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(120_000);
    baseURL = String(info.project.use.baseURL ?? "");
    admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    email = `e2e+m20-${randomBytes(6).toString("hex")}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
    uid = data.user.id;
    phone = await newContext(browser, PHONE);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    if (!uid) return;
    await phone?.context.close().catch(() => {});
    for (const r of (await admin.from("agent_runs").select("id").eq("user_id", uid)).data ?? []) runIds.add((r as { id: string }).id);
    for (const b of bookIds) {
      for (const r of (await admin.from("agent_runs").select("id").eq("book_id", b)).data ?? []) runIds.add((r as { id: string }).id);
    }
    let removed = 0;
    for (const bucket of BUCKETS) {
      for (let round = 0; round < 3; round++) {
        const paths = await listUserObjects(bucket).catch(() => [] as string[]);
        if (paths.length === 0) break;
        for (let i = 0; i < paths.length; i += 100) await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
        removed += paths.length;
      }
    }
    for (const b of bookIds) await admin.from("exports").delete().eq("book_id", b);
    await admin.from("orders").delete().eq("user_id", uid);
    const { error } = await admin.auth.admin.deleteUser(uid);
    let left = 0;
    for (const bucket of BUCKETS) left += (await listUserObjects(bucket).catch(() => [] as string[])).length;
    const books = await admin.from("books").select("id", { count: "exact", head: true }).eq("user_id", uid);
    const ids = [...runIds];
    let runsDeleted = 0;
    let runsLeft = 0;
    if (ids.length) {
      runsDeleted = (await admin.from("agent_runs").delete().in("id", ids).select("id")).data?.length ?? 0;
      runsLeft = (await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", ids)).count ?? 0;
    }
    console.log(
      `[cleanup] objects removed=${removed} left=${left} books=${books.count} runsFound=${ids.length} runsDeleted=${runsDeleted} runsLeft=${runsLeft} userDeleted=${!error}`,
    );
    expect(error).toBeNull();
    expect(left).toBe(0);
    expect(books.count ?? 0).toBe(0);
    expect(runsLeft).toBe(0);
  });

  test("a. 375 continuous: steps 1–7 on one document, row + caption_lang ar, review toggle, Generate → editor (soft)", async () => {
    test.setTimeout(600_000);
    const { page, nav } = phone;

    // Empty dashboard: "Make your first book" → the wizard (soft or hard — counted from step 1 on).
    await page.getByTestId("create-first-book").click();
    await page.waitForURL(/\/books\/new/, { timeout: 30_000 });
    await expectWizardStep(page, 1, 30_000);
    await waitForWizardHydrated(page);
    const mark = await markDocument(page);
    nav.reset();

    // Step 1: suggestion chips, Arabic title with dir=auto (input + band), audit, shot.
    await expect(page.getByTestId("title-suggestions")).toBeVisible();
    const chip = page.getByTestId("title-suggestion-0");
    const chipText = ((await chip.textContent()) ?? "").trim();
    await chip.click();
    await expect(page.getByTestId("book-title")).toHaveValue(chipText);
    await expect(page.getByTestId("wizard-band-title")).toContainText(chipText);
    const title = page.getByTestId("book-title");
    await title.fill(ARABIC_TITLE);
    await expect(title).toHaveAttribute("dir", "auto");
    expect(await title.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    const bandSpan = page.getByTestId("wizard-band-title").locator('[dir="auto"]');
    await expect(bandSpan).toHaveText(ARABIC_TITLE);
    expect(await bandSpan.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    await audit(page, "step 1 (375)");
    await shot(page, 1, 375);
    await wizardContinue(page, 1);

    // Step 2: purpose tiles, NO caption-language control (D-072).
    await expect(page.locator('[data-testid^="lang-"]')).toHaveCount(0);
    await expect(page.locator('input[name="captionLang"]')).toHaveCount(0);
    await page.getByTestId("occasion-graduation").click();
    await expect(cardRadio(page, "occasion-graduation")).toBeChecked();
    await audit(page, "step 2 (375)");
    await shot(page, 2, 375);
    await wizardContinue(page, 2);

    // Step 3: Continue disabled until a shape is picked.
    await expect(page.getByTestId("wizard-continue")).toBeDisabled();
    await page.getByTestId("format-A5_LANDSCAPE").click();
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    await expect(page.getByTestId("wizard-continue")).toBeEnabled();
    await audit(page, "step 3 (375)");
    await shot(page, 3, 375);
    await wizardContinue(page, 3);

    // Step 4: graduation → Geometric preselected; pick Scrapbook.
    await expect(cardRadio(page, "style-geometric")).toBeChecked();
    await page.getByTestId("style-scrapbook").click();
    await expect(cardRadio(page, "style-scrapbook")).toBeChecked();
    await audit(page, "step 4 (375)");
    await shot(page, 4, 375);
    // Done steps 1–3 are stepper buttons; 5–7 are not.
    for (const n of [1, 2, 3]) await expect(page.getByTestId(`wizard-step-${n}-button`)).toBeVisible();
    for (const n of [4, 5, 6, 7]) await expect(page.getByTestId(`wizard-step-${n}-button`)).toHaveCount(0);

    // Create → step 5 on the same document.
    await page.getByTestId("create-book").click();
    await page.waitForURL(WIZARD_STEP5_URL, { timeout: 30_000 });
    bookA = new URL(page.url()).searchParams.get("book") ?? "";
    bookIds.add(bookA);
    await expectWizardStep(page, 5, 30_000);
    await expect(page.getByTestId("wizard-step-photos")).toBeVisible({ timeout: 30_000 });
    expect(await bookRow(bookA)).toMatchObject({
      title: ARABIC_TITLE,
      occasion: "graduation",
      format: "A5_LANDSCAPE",
      design_style: "scrapbook",
      caption_lang: "ar", // Arabic-script title wins over the en-US browser (D-072)
    });
    expect(await ownedBooks()).toEqual([bookA]);
    await expect(page.getByTestId("upload-book-title")).toHaveText(ARABIC_TITLE);
    await expect(page.getByTestId("upload-book-title")).toHaveAttribute("dir", "auto");
    await expect(page.getByTestId("upload-wizard-back")).toBeVisible();
    // Edit mode now: done steps 1–4 are still reachable from the stepper before any pick.
    await expect(page.getByTestId("wizard-step-4-button")).toBeVisible();
    await audit(page, "step 5 (375)");
    await shot(page, 5, 375);
    expect(await docState(page)).toMatchObject({ doc: mark.doc, timeOrigin: mark.timeOrigin, band: true, stepper: true, wizard: true });

    // Photos → step 6 (responses held so it can be audited) → step 7.
    await holdRunResponses(page, 2_500);
    await pickPhotos(page, 6, 100);
    await expect(page.getByTestId("upload-wizard-back")).toHaveCount(0);
    await expect(page.getByTestId("upload-progress")).toBeVisible({ timeout: 60_000 });
    for (const n of [1, 2, 3, 4]) await expect(page.getByTestId(`wizard-step-${n}-button`)).toHaveCount(0); // G2 lock
    await audit(page, "step 5 uploading (375)", { tab: false });

    await page.waitForURL(wizardStepUrl(bookA, "6"), { timeout: 240_000 });
    await expectWizardStep(page, 6, 30_000);
    await expect(page.getByTestId("build-photo-fan")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("build-progress")).toHaveAttribute("data-variant", "wizard");
    await expect(page.getByTestId("build-checklist")).toBeVisible();
    await expect(page.getByTestId("build-keep-open")).toBeVisible();
    for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`wizard-step-${n}-button`)).toHaveCount(0);
    await audit(page, "step 6 (375)", { tab: false });
    await shot(page, 6, 375);
    const fan = await page
      .getByTestId("build-photo-fan")
      .evaluate((el) => {
        const imgs = Array.from(el.querySelectorAll("img"));
        return { imgs: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length };
      })
      .catch(() => null);
    console.log(`[a] step-6 fan ${JSON.stringify(fan)}`);
    expect(fan?.loaded ?? 0).toBeGreaterThan(0);

    await page.waitForURL(wizardStepUrl(bookA, "7"), { timeout: 420_000 });
    await expectWizardStep(page, 7, 60_000);
    await expect(page.getByTestId("wizard-generate")).toBeEnabled({ timeout: 60_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const n of [1, 2, 3, 4, 5, 6]) await expect(page.getByTestId(`wizard-step-${n}-button`)).toHaveCount(0);
    await expect(page.getByTestId("review-kept")).toHaveText(/\d+/);
    await audit(page, "step 7 (375)");
    await shot(page, 7, 375);

    // NO document navigation from step 1 to step 7; the band / stepper / wizard are the same nodes.
    const s7 = await docState(page);
    console.log(`[a] rsc requests: ${nav.rsc.map((u) => u.replace(/[0-9a-f-]{36}/g, ":id")).join(" ")}`);
    console.log(`[a] step1→7 docs=${nav.docs.length} rsc=${nav.rsc.length} actions=${nav.actions} frameNav=${nav.frameNav} state=${JSON.stringify(s7)}`);
    expect(nav.docs).toEqual([]);
    expect(s7).toMatchObject({ doc: mark.doc, timeOrigin: mark.timeOrigin, navEntries: 1, band: true, stepper: true, wizard: true });

    // Toggle a photo on step 7: persisted, no wizard remount, no reload (revalidatePath re-render).
    const tile = page.getByTestId("review-panel").getByTestId("review-tile").first();
    const photoId = (await tile.getAttribute("data-photo-id")) ?? "";
    const before = (await tile.getAttribute("data-state")) ?? "";
    expect(photoId).toMatch(new RegExp(`^${UUID}$`));
    const actionsBefore = nav.actions;
    const rscBefore = nav.rsc.length;
    await tile.click();
    await expect
      .poll(async () => {
        const { data } = await admin.from("photos").select("status, user_override").eq("id", photoId).single();
        return data as { status: string; user_override: boolean } | null;
      }, { timeout: 30_000 })
      .toEqual({ status: before === "kept" ? "dropped" : "kept", user_override: true });
    await page.waitForTimeout(2_000); // let the action's re-render land
    const afterToggle = await docState(page);
    console.log(`[a] toggle actions=${nav.actions - actionsBefore} docs=${nav.docs.length} rsc=${nav.rsc.length} state=${JSON.stringify(afterToggle)}`);
    expect(nav.actions - actionsBefore).toBeGreaterThanOrEqual(1);
    // 910fb34: toggles pass { revalidate: false } — no RSC request for /books/new per tap.
    const toggleRsc = nav.rsc.slice(rscBefore).filter((u) => u.startsWith("/books/new"));
    console.log(`[a] toggle rsc requests to /books/new: ${toggleRsc.length}`);
    expect(toggleRsc).toEqual([]);
    expect(nav.docs).toEqual([]);
    expect(afterToggle).toMatchObject({ doc: mark.doc, band: true, stepper: true, wizard: true });
    await expectWizardStep(page, 7);
    await expect(page.locator(`[data-testid="review-tile"][data-photo-id="${photoId}"]`)).toHaveAttribute(
      "data-state",
      before === "kept" ? "dropped" : "kept",
    );

    // Generate → editor: a soft navigation (same document).
    await page.getByTestId("wizard-generate").click();
    await page.waitForURL(new RegExp(`/books/${bookA}/edit$`), { timeout: 120_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    const atEditor = await page.evaluate(() => ({ doc: (window as unknown as { __m20doc?: string }).__m20doc ?? null, timeOrigin: performance.timeOrigin }));
    console.log(`[a] generate → editor docs=${JSON.stringify(nav.docs)} sameDoc=${atEditor.doc === mark.doc}`);
    expect(nav.docs).toEqual([]);
    expect(atEditor).toEqual({ doc: mark.doc, timeOrigin: mark.timeOrigin });
    expect(await bookRow(bookA)).toMatchObject({ occasion: "graduation", format: "A5_LANDSCAPE", design_style: "scrapbook", caption_lang: "ar" });
    expect((await runsOf(bookA)).length).toBe(1);
  });

  test("a2. built book: wizard URLs leave the wizard, ?trigger=rebuild stays classic with no redirect loop", async () => {
    test.setTimeout(300_000);
    test.skip(!bookA, "needs book A");
    const { page } = phone;
    const req = page.context().request;
    // Upload of a built book = classic (no redirect into the wizard); ?trigger=rebuild = classic.
    const up = await redirectOf(req, `/books/${bookA}/upload`);
    expect(up).toMatchObject({ status: 200, to: null });
    const rb = await redirectOf(req, `/books/${bookA}/build?trigger=rebuild`);
    expect(rb).toMatchObject({ status: 200, to: null });
    // The wizard's step URLs + /build for this built book never loop: each chain ends within 4 hops.
    for (const u of [`/books/new?book=${bookA}&step=5`, `/books/new?book=${bookA}&step=6`, `/books/new?book=${bookA}&step=2`, `/books/${bookA}/build`]) {
      let url = u;
      const hops: string[] = [];
      let ended = false;
      for (let i = 0; i < 6; i++) {
        const r = await redirectOf(req, url);
        hops.push(`${r.status}${r.streamed ? "(streamed)" : ""} ${url.replace(bookA, ":id")}`);
        if (!r.to) {
          ended = true;
          break;
        }
        const next = new URL(r.to, baseURL);
        url = next.pathname + next.search;
      }
      console.log(`[a2] ${u.replace(bookA, ":id")} → ${hops.join(" → ")}`);
      expect(ended, `no redirect loop from ${u}`).toBe(true);
      expect(hops.length).toBeLessThan(5);
    }
    // In the browser: the rebuild screen is the classic one (no wizard shell) and stays put.
    await page.goto(`/books/${bookA}/build?trigger=rebuild`);
    await expect(page.getByTestId("build-progress")).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe(`/books/${bookA}/build`);
    await expect(page.getByTestId("wizard-shell")).toHaveCount(0);
    await expect(page.getByTestId("new-book-wizard")).toHaveCount(0);
    await expect(page.getByTestId("build-progress")).not.toHaveAttribute("data-variant", "wizard");
    // The rebuild finishes in the editor (not the wizard).
    await page.waitForURL(new RegExp(`/books/${bookA}/edit$`), { timeout: 300_000 });
    const runs = await runsOf(bookA);
    console.log(`[a2] runs=${runs.map((r) => `${r.trigger}:${r.state}`).join(",")}`);
    expect(runs.some((r) => r.trigger === "rebuild")).toBe(true);
  });

  test("b. 375 history: Back before pick → step 4 edit; BUG-3 double/triple Back never a prefilled create wizard; 1 book", async () => {
    test.setTimeout(300_000);
    const { page } = phone;
    const urlFindings: string[] = [];
    const before = (await ownedBooks()).length;
    bookB = await createBookViaWizard(page, { title: "Back rules", occasion: "wedding", format: "A5_PORTRAIT", style: "classic" });
    bookIds.add(bookB);
    expect((await ownedBooks()).length).toBe(before + 1);
    const countAfterCreate = before + 1;

    /** Whatever the screen shows: never a create-mode wizard holding the old answers. */
    const noPrefilledCreate = async (label: string) => {
      await page.waitForTimeout(1_500);
      await page.locator('[data-testid="new-book-wizard"]:not([data-reopening])').first().waitFor({ timeout: 30_000 }).catch(() => {});
      const st = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="new-book-wizard"]');
        const t = document.querySelector<HTMLInputElement>('[data-testid="book-title"]');
        const checked = Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="new-book-wizard"] input[type="radio"]:checked')).map((r) => r.value);
        return {
          url: location.pathname + location.search,
          step: w?.getAttribute("data-step") ?? null,
          mode: w?.getAttribute("data-mode") ?? null,
          title: t ? t.value : null,
          checked,
          create: document.querySelector('[data-testid="create-book"]') !== null,
          save: document.querySelector('[data-testid="wizard-save"]') !== null,
        };
      });
      console.log(`[b] ${label} → ${JSON.stringify(st)}`);
      if (st.mode === "create") {
        expect(st.title === null || st.title === "", `${label}: create wizard prefilled title`).toBe(true);
        expect(st.checked, `${label}: create wizard prefilled choices`).toEqual([]);
      }
      if (st.mode === "edit") {
        // Edit mode must hold book B. The URL should name it too (the flow replaces an old create-mode
        // entry with the edit URL) — a stale create URL is recorded as a finding, not a duplicate risk.
        if (!st.url.includes(`book=${bookB}`)) urlFindings.push(`${label}: edit mode (book B) shown at ${st.url}`);
        // Its draft is book B's (wedding / portrait / classic), never another book's.
        expect(st.checked.every((v) => ["wedding", "A5_PORTRAIT", "classic"].includes(v)), `${label}: book B answers`).toBe(true);
      }
      expect((await ownedBooks()).length, `${label}: book count`).toBe(countAfterCreate);
      return st;
    };

    // 1. Same document: Back from step 5 (before any pick) → step 4 of THIS book (edit), Forward → 5.
    await page.goBack({ waitUntil: "commit" });
    await page.waitForURL(new RegExp(`/books/new\\?book=${bookB}&step=4$`), { timeout: 30_000 });
    await expect(page.getByTestId("new-book-wizard")).toHaveAttribute("data-mode", "edit", { timeout: 30_000 });
    await expectWizardStep(page, 4, 30_000);
    await expect(cardRadio(page, "style-classic")).toBeChecked();
    await expect(page.getByTestId("wizard-save")).toBeVisible();
    await expect(page.getByTestId("create-book")).toHaveCount(0);
    expect((await ownedBooks()).length).toBe(countAfterCreate);
    await page.goForward({ waitUntil: "commit" });
    await page.waitForURL(new RegExp(`/books/new\\?book=${bookB}&step=5$`), { timeout: 30_000 });
    await expectWizardStep(page, 5, 30_000);

    // 2. BUG-3 (same document): Back twice / three times → steps 3 / 2 of book B or an empty create.
    await page.goBack({ waitUntil: "commit" });
    await expectWizardStep(page, 4, 30_000);
    await page.goBack({ waitUntil: "commit" });
    const s3 = await noPrefilledCreate("same-doc Back×2");
    await page.goBack({ waitUntil: "commit" });
    await noPrefilledCreate("same-doc Back×3");
    if (s3.mode === "edit") {
      // Continue through the edit steps: Save (never create) → step 5 of book B.
      await page.goto(`/books/new?book=${bookB}&step=4`);
      await expectWizardStep(page, 4, 30_000);
      await expect(page.getByTestId("create-book")).toHaveCount(0);
      await page.getByTestId("wizard-save").click();
      await page.waitForURL(new RegExp(`/books/new\\?book=${bookB}&step=5$`), { timeout: 30_000 });
      expect((await ownedBooks()).length).toBe(countAfterCreate);
    }

    // 3. BUG-3 after a HARD leave: a fresh create (book B2), step 5 → hard goto dashboard → Back ×N.
    const b2 = await createBookViaWizard(page, { title: "Hard leave", occasion: "baby", format: "A5_PORTRAIT" });
    bookIds.add(b2);
    const n2 = countAfterCreate + 1;
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
    for (let i = 1; i <= 5; i++) {
      await page.goBack({ waitUntil: "commit" }).catch(() => null);
      await page.waitForTimeout(1_500);
      const st = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="new-book-wizard"]');
        const t = document.querySelector<HTMLInputElement>('[data-testid="book-title"]');
        const checked = Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="new-book-wizard"] input[type="radio"]:checked')).map((r) => r.value);
        return { url: location.pathname + location.search, step: w?.getAttribute("data-step") ?? null, mode: w?.getAttribute("data-mode") ?? null, title: t ? t.value : null, checked };
      });
      console.log(`[b] hard-leave Back×${i} → ${JSON.stringify(st)}`);
      if (st.step && /[?&]step=\d/.test(st.url) && !st.url.includes(`step=${st.step}`)) urlFindings.push(`hard-leave Back×${i}: step ${st.step} shown at ${st.url}`);
      if (st.mode === "create") {
        expect(st.title === null || st.title === "", `hard-leave Back×${i}: prefilled title`).toBe(true);
        expect(st.checked, `hard-leave Back×${i}: prefilled choices`).toEqual([]);
      }
      if (st.mode === "edit" && !st.url.includes(`book=${b2}`)) urlFindings.push(`hard-leave Back×${i}: edit mode shown at ${st.url}`);
      expect((await ownedBooks()).length).toBe(n2);
    }

    // 4. BUG-3 after a SOFT leave (a client Link out of the wizard), Back ×3.
    const b3 = await createBookViaWizard(page, { title: "Soft leave", occasion: "family", format: "A5_PORTRAIT" });
    bookIds.add(b3);
    const n3 = n2 + 1;
    const homeLink = page.getByTestId("wizard-footer-home");
    if (await homeLink.isVisible().catch(() => false)) {
      await homeLink.click();
      await page.waitForURL((u) => !u.pathname.startsWith("/books/new"), { timeout: 30_000 });
      for (let i = 1; i <= 4; i++) {
        await page.goBack({ waitUntil: "commit" }).catch(() => null);
        await page.waitForTimeout(1_500);
        const st = await page.evaluate(() => {
          const w = document.querySelector('[data-testid="new-book-wizard"]');
          const t = document.querySelector<HTMLInputElement>('[data-testid="book-title"]');
          const checked = Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="new-book-wizard"] input[type="radio"]:checked')).map((r) => r.value);
          return { url: location.pathname + location.search, step: w?.getAttribute("data-step") ?? null, mode: w?.getAttribute("data-mode") ?? null, title: t ? t.value : null, checked };
        });
        console.log(`[b] soft-leave Back×${i} → ${JSON.stringify(st)}`);
      if (st.step && /[?&]step=\d/.test(st.url) && !st.url.includes(`step=${st.step}`)) urlFindings.push(`soft-leave Back×${i}: step ${st.step} shown at ${st.url}`);
        if (st.mode === "create") {
          expect(st.title === null || st.title === "", `soft-leave Back×${i}: prefilled title`).toBe(true);
          expect(st.checked, `soft-leave Back×${i}: prefilled choices`).toEqual([]);
        }
        if (st.mode === "edit" && !st.url.includes(`book=${b3}`)) urlFindings.push(`soft-leave Back×${i}: edit mode shown at ${st.url}`);
        expect((await ownedBooks()).length).toBe(n3);
      }
    } else console.log("[b] wizard-footer-home not visible at 375 — soft-leave scenario skipped");

    // 5. Edit + save returns to step 5; tone follows the occasion (wedding romantic → graduation fun).
    await page.goto(`/books/new?book=${bookB}&step=5`);
    await expectWizardStep(page, 5, 30_000);
    await page.getByTestId("upload-wizard-back").getByTestId("wizard-back").click();
    await expectWizardStep(page, 4, 30_000);
    await expect(page.getByTestId("wizard-start-over")).toHaveCount(0); // edit mode never offers it
    await page.getByTestId("wizard-back").click();
    await expectWizardStep(page, 3);
    await page.getByTestId("wizard-back").click();
    await expectWizardStep(page, 2);
    expect((await bookRow(bookB)).tone).toBe("romantic");
    await page.getByTestId("occasion-graduation").click();
    await wizardContinue(page, 2);
    await wizardContinue(page, 3);
    await expect(cardRadio(page, "style-classic")).toBeChecked(); // an explicit style is kept
    await page.getByTestId("wizard-save").click();
    await page.waitForURL(new RegExp(`/books/new\\?book=${bookB}&step=5$`), { timeout: 30_000 });
    await expectWizardStep(page, 5, 30_000);
    expect(await bookRow(bookB)).toMatchObject({ occasion: "graduation", tone: "fun", design_style: "classic", format: "A5_PORTRAIT", title: "Back rules" });
    console.log(`[b] URL findings (${urlFindings.length}): ${urlFindings.join(" | ")}`);
    urlDesync.push(...urlFindings);
  });

  test("c. 375: refresh at 5/6/7 restores; Back while uploading stays on 5; after the run stays 6/7; Generate from hard-loaded 7", async () => {
    test.setTimeout(600_000);
    test.skip(!bookB, "needs book B");
    const { page, nav } = phone;
    await page.goto(`/books/new?book=${bookB}&step=5`);
    await expectWizardStep(page, 5, 30_000);
    // Refresh on 5 → 5.
    await page.reload();
    await expectWizardStep(page, 5, 30_000);
    await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });

    // Back while uploading → stays on 5 (URL too).
    await slowUploads(page, 2_000);
    await holdRunResponses(page, 3_000);
    await pickPhotos(page, 6, 200);
    await expect(page.getByTestId("upload-progress")).toBeVisible({ timeout: 60_000 });
    await page.goBack({ waitUntil: "commit" }).catch(() => null);
    await page.waitForTimeout(1_000);
    await expectWizardStep(page, 5);
    expect(new URL(page.url()).searchParams.get("step")).toBe("5");
    expect(new URL(page.url()).searchParams.get("book")).toBe(bookB);
    await expect(page.getByTestId("upload-progress")).toBeVisible();
    console.log(`[c] Back while uploading → step ${await page.getByTestId("new-book-wizard").getAttribute("data-step")}`);

    // Step 6 → refresh resumes the same run (never a second one).
    await page.waitForURL(wizardStepUrl(bookB, "6"), { timeout: 240_000 });
    await expectWizardStep(page, 6, 30_000);
    await page.reload();
    await expectWizardStep(page, 6, 30_000);
    expect(new URL(page.url()).searchParams.get("step")).toBe("6");
    await expect(page.getByTestId("build-progress")).toBeVisible({ timeout: 30_000 });

    await page.waitForURL(wizardStepUrl(bookB, "7"), { timeout: 420_000 });
    await expectWizardStep(page, 7, 60_000);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const runs = await runsOf(bookB);
    console.log(`[c] runs after refresh on 6: ${runs.map((r) => `${r.trigger}:${r.state}`).join(",")}`);
    expect(runs.length).toBe(1);

    // Back after the run → stays on 6/7 (sorting was replaced; ≤ 5 locked).
    await page.goBack({ waitUntil: "commit" }).catch(() => null);
    await page.waitForTimeout(1_500);
    const afterBack = await page.evaluate(() => ({
      url: location.pathname + location.search,
      step: document.querySelector('[data-testid="new-book-wizard"]')?.getAttribute("data-step") ?? null,
    }));
    console.log(`[c] Back after run → ${JSON.stringify(afterBack)}`);
    expect(["6", "7"]).toContain(afterBack.step);
    if (!new RegExp(`^/books/new\\?book=${bookB}&step=${afterBack.step}$`).test(afterBack.url)) {
      urlDesync.push(`c Back after run: step ${afterBack.step} shown at ${afterBack.url}`);
    }
    expect((await runsOf(bookB)).length).toBe(1);

    // Refresh on 7 → 7, then Generate from this hard-loaded step 7 → editor (soft navigation).
    await page.goto(`/books/new?book=${bookB}&step=7`);
    await expectWizardStep(page, 7, 60_000);
    await page.reload();
    await expectWizardStep(page, 7, 60_000);
    await expect(page.getByTestId("wizard-generate")).toBeEnabled({ timeout: 60_000 });
    const mark = await markDocument(page);
    nav.reset();
    await page.getByTestId("wizard-generate").click();
    await page.waitForURL(new RegExp(`/books/${bookB}/edit$`), { timeout: 120_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    const at = await page.evaluate(() => ({ doc: (window as unknown as { __m20doc?: string }).__m20doc ?? null, timeOrigin: performance.timeOrigin }));
    console.log(`[c] hard-loaded 7 → editor docs=${JSON.stringify(nav.docs)} sameDoc=${at.doc === mark.doc}`);
    expect(nav.docs).toEqual([]);
    expect(at).toEqual({ doc: mark.doc, timeOrigin: mark.timeOrigin });
    expect((await runsOf(bookB)).length).toBe(1);
  });

  test("d. 375 create details: back/forward 1–4, refresh on 3, deep link, stepper clicks, Start over, entry redirects", async () => {
    test.setTimeout(300_000);
    const { page } = phone;
    const before = (await ownedBooks()).length;
    await page.goto("/books/new");
    await expectWizardStep(page, 1, 30_000);
    await waitForWizardHydrated(page);
    // Two wizard-preview elements (aside ≥ lg + inline mini) — exactly one visible at 375.
    await expect(page.getByTestId("wizard-preview")).toHaveCount(2);
    await expect(page.getByTestId("wizard-preview").filter({ visible: true })).toHaveCount(1);
    await page.getByTestId("book-title").fill("Half done");
    await wizardContinue(page, 1);
    await page.getByTestId("occasion-baby").click();
    await wizardContinue(page, 2);
    await page.getByTestId("format-A5_LANDSCAPE").click();
    // Refresh on 3 keeps every choice (sessionStorage mirror).
    await page.reload();
    await expectWizardStep(page, 3, 30_000);
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    // Browser back / forward across steps.
    await page.goBack();
    await expectWizardStep(page, 2);
    await expect(cardRadio(page, "occasion-baby")).toBeChecked();
    await page.goBack();
    await expectWizardStep(page, 1);
    await expect(page.getByTestId("book-title")).toHaveValue("Half done");
    await page.goForward();
    await expectWizardStep(page, 2);
    await page.goForward();
    await expectWizardStep(page, 3);
    await wizardContinue(page, 3);
    // Stepper: done steps 1–3 are buttons; click 1 → step 1 with the title; then 3 → step 3.
    await page.getByTestId("wizard-step-1-button").click();
    await expectWizardStep(page, 1);
    await expect(page.getByTestId("book-title")).toHaveValue("Half done");
    const three = page.getByTestId("wizard-step-3-button");
    const forwardJump = await three.isVisible().catch(() => false);
    console.log(`[d] stepper forward jump to 3 offered=${forwardJump}`);
    if (forwardJump) {
      await three.click();
      await expectWizardStep(page, 3);
      await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    }
    await page.getByTestId(forwardJump ? "wizard-step-2-button" : "wizard-continue").click();
    await expectWizardStep(page, 2);
    await expect(cardRadio(page, "occasion-baby")).toBeChecked();
    // Leave mid-wizard, revisit → Start over (≥ 44 px) → empty step 1; nothing created.
    await page.goto("/dashboard");
    await page.goto("/books/new");
    await expect(page.getByTestId("new-book-wizard")).toHaveAttribute("data-mode", "create", { timeout: 30_000 });
    const so = page.getByTestId("wizard-start-over");
    await expect(so).toBeVisible({ timeout: 30_000 });
    const box = await so.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await audit(page, "restored draft with Start over (375)");
    await so.click();
    await expectWizardStep(page, 1);
    await expect(page.getByTestId("book-title")).toHaveValue("");
    await expect(so).toHaveCount(0);
    await wizardContinue(page, 1);
    await expect(page.locator('[data-testid^="occasion-"] input[type="radio"]:checked')).toHaveCount(0);
    // A deep link to a later step with nothing stored bounces to step 1.
    await page.goto("/books/new?step=3");
    await expectWizardStep(page, 1, 30_000);
    await expect(page.getByTestId("book-title")).toHaveValue("");
    expect((await ownedBooks()).length).toBe(before);

    // Entry redirects for a fresh book (no photos, no run): /upload → step 5, /build → step 6.
    const fresh = await createBookViaWizard(page, { occasion: "travel", format: "A5_PORTRAIT" });
    bookIds.add(fresh);
    const req = page.context().request;
    const up = await redirectOf(req, `/books/${fresh}/upload`);
    console.log(`[d] /books/fresh/upload → ${up.status}${up.streamed ? " (streamed)" : ""} ${up.to?.replace(fresh, ":id")}`);
    expect(up.to).toBe(`/books/new?book=${fresh}&step=5`);
    const bd = await redirectOf(req, `/books/${fresh}/build`);
    console.log(`[d] /books/fresh/build → ${bd.status}${bd.streamed ? " (streamed)" : ""} ${bd.to?.replace(fresh, ":id")}`);
    expect(bd.to).toBe(`/books/new?book=${fresh}&step=6`);
    // The wizard URLs render there (no loop back to /upload or /build). Server render only, no JS — no run.
    for (const step of [5, 6]) {
      const r = await redirectOf(req, `/books/new?book=${fresh}&step=${step}`);
      console.log(`[d] /books/new?book=fresh&step=${step} → ${r.status} ${r.to ?? "(renders)"}`);
      expect(r).toMatchObject({ status: 200, to: null });
    }
    // In the browser: /upload lands on wizard step 5.
    await page.goto(`/books/${fresh}/upload`);
    await page.waitForURL(new RegExp(`/books/new\\?book=${fresh}&step=5$`), { timeout: 30_000 });
    await expectWizardStep(page, 5, 30_000);
    expect((await runsOf(fresh)).length).toBe(0);
  });

  test("e. 1280: steps 1–7 audited + screenshots, one document, layout jump 6 → 7 measured", async ({ browser }) => {
    test.setTimeout(600_000);
    const desk = await newContext(browser, DESKTOP);
    const { page, nav } = desk;
    try {
      await page.getByTestId("new-book").click();
      await page.waitForURL(/\/books\/new/, { timeout: 30_000 });
      await expectWizardStep(page, 1, 30_000);
      await waitForWizardHydrated(page);
      await expect(page.getByTestId("wizard-preview").filter({ visible: true })).toHaveCount(1);
      const mark = await markDocument(page);
      nav.reset();
      await walkWizardToStyle(page, {
        goto: false,
        title: "Desert weekend",
        occasion: "travel",
        format: "A5_PORTRAIT",
        expectStyle: "geometric",
        onStep: async (n) => {
          if (n > 1) await audit(page, `step ${n} (1280)`);
        },
        beforeContinue: async (n) => {
          if (n === 1) await audit(page, "step 1 (1280)");
          await shot(page, n, 1280);
        },
      });
      await page.getByTestId("create-book").click();
      await page.waitForURL(WIZARD_STEP5_URL, { timeout: 30_000 });
      const id = new URL(page.url()).searchParams.get("book") ?? "";
      bookIds.add(id);
      const rowD = await bookRow(id);
      // caption_lang: Latin title → memory (book A was Arabic) → Accept-Language — logged, not asserted.
      console.log(`[e] Latin-title book caption_lang=${rowD.caption_lang} (user memory from Arabic book A)`);
      expect(rowD).toMatchObject({ title: "Desert weekend", occasion: "travel", format: "A5_PORTRAIT", design_style: "geometric" });
      await expectWizardStep(page, 5, 30_000);
      await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
      await audit(page, "step 5 (1280)");
      await shot(page, 5, 1280);

      await holdRunResponses(page, 2_500);
      await pickPhotos(page, 6, 300);
      await page.waitForURL(wizardStepUrl(id, "6"), { timeout: 240_000 });
      await expect(page.getByTestId("build-photo-fan")).toBeVisible({ timeout: 30_000 });
      await audit(page, "step 6 (1280)", { tab: false });
      await shot(page, 6, 1280);
      const geo6 = await layoutGeometry(page);
      await page.waitForURL(wizardStepUrl(id, "7"), { timeout: 420_000 });
      await expectWizardStep(page, 7, 60_000);
      await expect(page.getByTestId("wizard-generate")).toBeEnabled({ timeout: 60_000 });
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const geo7 = await layoutGeometry(page);
      console.log(`[e] layout 6→7 step6=${JSON.stringify(geo6)} step7=${JSON.stringify(geo7)}`);
      await audit(page, "step 7 (1280)");
      await shot(page, 7, 1280);
      const s7 = await docState(page);
      console.log(`[e] step1→7 docs=${nav.docs.length} rsc=${nav.rsc.length} actions=${nav.actions} state=${JSON.stringify(s7)}`);
      expect(nav.docs).toEqual([]);
      expect(s7).toMatchObject({ doc: mark.doc, timeOrigin: mark.timeOrigin, band: true, stepper: true, wizard: true });
      await page.getByTestId("wizard-generate").click();
      await page.waitForURL(new RegExp(`/books/${id}/edit$`), { timeout: 120_000 });
      await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
      expect(nav.docs).toEqual([]);
    } finally {
      await desk.context.close();
    }
  });

  test("f. reduced motion (375): no running animation on steps 1–7, static review count, no view transition", async ({ browser }) => {
    test.setTimeout(600_000);
    const rm = await newContext(browser, PHONE, { reducedMotion: true });
    const { page } = rm;
    const samples: string[] = [];
    const sample = async (label: string) => {
      await page.waitForTimeout(400);
      const a = await runningAnimations(page);
      const vt = await page.evaluate(() => document.querySelector('[data-step-anim="vt"]') !== null);
      samples.push(`${label}:${a.n}${a.n ? `(${a.names.join(" ")})` : ""}${vt ? " vt!" : ""}`);
      expect.soft(a.n, `${label}: running animations ${a.names.join(", ")}`).toBe(0);
      expect.soft(vt, `${label}: view transition used`).toBe(false);
    };
    try {
      await walkWizardToStyle(page, {
        occasion: "family",
        format: "A5_PORTRAIT",
        onStep: async (n) => sample(`step ${n}`),
      });
      await page.getByTestId("create-book").click();
      await page.waitForURL(WIZARD_STEP5_URL, { timeout: 30_000 });
      const id = new URL(page.url()).searchParams.get("book") ?? "";
      bookIds.add(id);
      await expectWizardStep(page, 5, 30_000);
      await sample("step 5");
      await slowUploads(page, 1_500);
      await holdRunResponses(page, 2_500);
      await pickPhotos(page, 6, 400);
      await expect(page.getByTestId("upload-progress")).toBeVisible({ timeout: 60_000 });
      await sample("step 5 uploading");
      await page.waitForURL(wizardStepUrl(id, "6"), { timeout: 240_000 });
      await expect(page.getByTestId("build-photo-fan")).toBeVisible({ timeout: 30_000 });
      await sample("step 6");
      await page.waitForURL(wizardStepUrl(id, "7"), { timeout: 420_000 });
      await expect(page.getByTestId("wizard-generate")).toBeEnabled({ timeout: 60_000 });
      await page.unrouteAll({ behavior: "ignoreErrors" });
      // The count-up shows the final number straight away.
      const kept = await page.getByTestId("review-kept").textContent();
      const visual = await page.getByTestId("review-kept-visual").textContent();
      const n = /(\d+)/.exec(kept ?? "")?.[1];
      console.log(`[f] review kept sr="${(kept ?? "").replace(/\d+/g, "N")}" visualHasFinal=${(visual ?? "").includes(n ?? "§")}`);
      expect(visual ?? "").toContain(n ?? "§");
      await sample("step 7");
      console.log(`[f] samples ${samples.join(" | ")}`);
    } finally {
      await rm.context.close();
    }
  });

  test("h. 375: double-tap / Enter twice on step-4 Continue → 1 book; 'Make my book now' then Back / stepper stays on 6", async () => {
    test.setTimeout(600_000);
    const { page } = phone;
    // (b) double submit.
    const before = (await ownedBooks()).length;
    await walkWizardToStyle(page, { title: "Double tap", occasion: "travel", format: "A5_PORTRAIT" });
    await page.getByTestId("create-book").dblclick();
    await page.waitForURL(WIZARD_STEP5_URL, { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    expect((await ownedBooks()).length, "dblclick on step-4 Continue").toBe(before + 1);
    await walkWizardToStyle(page, { title: "Enter twice", occasion: "travel", format: "A5_PORTRAIT" });
    await page.getByTestId("create-book").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForURL(WIZARD_STEP5_URL, { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    expect((await ownedBooks()).length, "Enter twice on step-4 Continue").toBe(before + 2);
    const id = new URL(page.url()).searchParams.get("book") ?? "";

    // (a) 4 photos (below the automatic-build threshold) → "Make my book now" → step 6, locked.
    await holdRunResponses(page, 3_000);
    await pickPhotos(page, 4, 500);
    await expect(page.getByTestId("build-album")).toBeVisible({ timeout: 180_000 });
    await page.getByTestId("build-album").click();
    await page.waitForURL(wizardStepUrl(id, "6"), { timeout: 30_000 });
    await expectWizardStep(page, 6, 30_000);
    for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`wizard-step-${n}-button`)).toHaveCount(0);
    await page.goBack({ waitUntil: "commit" }).catch(() => null);
    await page.waitForTimeout(1_500);
    const st = await page.evaluate(() => ({
      url: location.pathname + location.search,
      step: document.querySelector('[data-testid="new-book-wizard"]')?.getAttribute("data-step") ?? null,
    }));
    console.log(`[h] Back after Make my book now → ${JSON.stringify(st)}`);
    expect(["6", "7"]).toContain(st.step);
    expect(st.url).toMatch(new RegExp(`step=[67]$`));
    await page.waitForURL(wizardStepUrl(id, "7"), { timeout: 420_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect((await runsOf(id)).length).toBe(1);
  });

  test("i. AI off (prod-like): step 5 upload only → step 6 rule sorting → step 7 ai_off review → Generate → editor; 1 rule run", async ({ browser }) => {
    // M20b. Runs only against a server in AI_MODE=off (probed via the wizard API's aiOn; E2E_AI_MODE
    // set to anything else skips before creating a book).
    test.skip(!!process.env.E2E_AI_MODE && process.env.E2E_AI_MODE !== "off", "server is not AI_MODE=off");
    test.setTimeout(600_000);
    const { context, page, nav } = await newContext(browser, PHONE, { analytics: ANALYTICS });
    // With E2E_ANALYTICS=1 (fake PostHog build): ai_build_done must fire exactly once, mode "rules".
    const events: { event: string; properties: Record<string, unknown> }[] = [];
    if (ANALYTICS) {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
        Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
      });
      await context.route(`${PH_HOST}/**`, async (route) => {
        try {
          for (const e of decodeBody(route.request())) {
            const ev = e as { event?: unknown; properties?: Record<string, unknown> };
            if (ev && typeof ev.event === "string") events.push({ event: ev.event, properties: ev.properties ?? {} });
          }
        } catch {
          /* undecodable batch */
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
      });
      await context.route(/posthog\.com/, (r) => r.abort());
    }
    try {
      const id = await createBookViaWizard(page, { title: "Rule album", occasion: "family", format: "A5_PORTRAIT" });
      bookIds.add(id);
      const probe = await page.context().request.get(`/api/books/${id}/wizard?step=5`);
      expect(probe.status()).toBe(200);
      const aiOn = ((await probe.json()) as { aiOn?: boolean }).aiOn;
      test.skip(aiOn !== false, "server has AI on (run with AI_MODE=off)");

      // Same document from here to the editor; record what the DOM ever shows (step 5 never shows
      // sorting / auto-start text; step 6 phases + rule rows; timing of 6 → 7).
      const mark = await markDocument(page);
      nav.reset();
      await page.evaluate(() => {
        type Rec = {
          sortingNext: boolean;
          autoStarting: boolean;
          photosSortingText: string[];
          doneHint: string | null;
          phases: string[];
          rules: string[];
          labels: string[];
          barDone: string[];
          t6: number | null;
          t7: number | null;
        };
        const rec: Rec = {
          sortingNext: false,
          autoStarting: false,
          photosSortingText: [],
          doneHint: null,
          phases: [],
          rules: [],
          labels: [],
          barDone: [],
          t6: null,
          t7: null,
        };
        (window as unknown as { __m20bRec: Rec }).__m20bRec = rec;
        const q = (s: string) => document.querySelector(s);
        const pushNew = (arr: string[], v: string | null | undefined) => {
          if (v != null && arr[arr.length - 1] !== v) arr.push(v);
        };
        const check = () => {
          if (q('[data-testid="upload-sorting-next"]')) rec.sortingNext = true;
          if (q('[data-testid="upload-auto-starting"]')) rec.autoStarting = true;
          const photos = q('[data-testid="wizard-step-photos"]');
          const txt = photos?.textContent ?? "";
          for (const re of [/sorting/i, /starting your book/i, /making your book/i]) {
            const m = re.exec(txt);
            if (!m) continue;
            const snip = txt.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, " ");
            if (!rec.photosSortingText.includes(snip)) rec.photosSortingText.push(snip);
          }
          const hint = q('[data-testid="upload-done-hint"]');
          if (hint) rec.doneHint = (hint.textContent ?? "").trim();
          if (rec.t6 === null && q('[data-testid="wizard-step-sorting"]')) rec.t6 = performance.now();
          if (rec.t7 === null && q('[data-testid="wizard-step-review"]')) rec.t7 = performance.now();
          const bp = q('[data-testid="build-progress"][data-variant="wizard"]');
          if (bp) {
            pushNew(rec.phases, bp.getAttribute("data-sort-phase"));
            pushNew(rec.rules, bp.getAttribute("data-rules") ?? "none");
            pushNew(rec.barDone, q('[data-testid="build-sort-bar"]')?.getAttribute("data-done"));
            for (const li of Array.from(bp.querySelectorAll('[data-testid^="build-step-"]'))) {
              const t = (li.textContent ?? "").trim();
              if (t && !rec.labels.includes(t)) rec.labels.push(t);
            }
          }
        };
        new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        check();
      });

      await pickPhotos(page, 6, 900);
      await expect(page.getByTestId("upload-settled")).toBeVisible({ timeout: 180_000 });
      await expect(page.getByTestId("upload-done-hint")).toBeVisible();
      await page.waitForURL(wizardStepUrl(id, "6"), { timeout: 60_000 });
      await expectWizardStep(page, 6, 30_000);
      await expect(page.getByTestId("build-progress")).toHaveAttribute("data-rules", "true");
      await waitForReview(page, id, 120_000);
      await expect(page.getByTestId("review-banner-ai_off")).toBeVisible();

      type Rec = { sortingNext: boolean; autoStarting: boolean; photosSortingText: string[]; doneHint: string | null; phases: string[]; rules: string[]; labels: string[]; barDone: string[]; t6: number | null; t7: number | null };
      const rec = await page.evaluate(() => (window as unknown as { __m20bRec: Rec }).__m20bRec);
      const sortingMs = rec.t6 !== null && rec.t7 !== null ? Math.round(rec.t7 - rec.t6) : null;
      console.log(`[i] rec ${JSON.stringify({ ...rec, t6: undefined, t7: undefined, sortingMs })}`);
      expect(rec.sortingNext, "upload-sorting-next never shown").toBe(false);
      expect(rec.autoStarting, "upload-auto-starting never shown").toBe(false);
      expect(rec.photosSortingText, "step 5 never shows sorting / starting text").toEqual([]);
      expect(rec.doneHint).toBeTruthy();
      expect(rec.rules).toEqual(["true"]);
      expect(rec.phases.length, `phases progressed: ${rec.phases.join("→")}`).toBeGreaterThanOrEqual(3);
      expect(rec.phases[rec.phases.length - 1]).toBe("ready");
      for (const label of ["Leaving out duplicates and very blurry photos", "Grouping your photos by date and place", "Laying out your pages"]) {
        expect(rec.labels.some((l) => l.includes(label)), `rule row "${label}"`).toBe(true);
      }
      expect(rec.labels.some((l) => /Finding places and moments|Checking for duplicates/.test(l)), "no AI wording").toBe(false);
      expect(sortingMs ?? 0, "step 6 shown ≥ 2.7 s").toBeGreaterThanOrEqual(2_700);

      // 0 document navigations step 5 → 7; same wizard nodes.
      expect(nav.docs).toEqual([]);
      expect(await docState(page)).toMatchObject({ doc: mark.doc, timeOrigin: mark.timeOrigin, navEntries: 1, band: true, stepper: true, wizard: true });

      // Toggle one photo (persisted).
      const tile = page.getByTestId("review-panel").getByTestId("review-tile").first();
      const photoId = (await tile.getAttribute("data-photo-id")) ?? "";
      const before = (await tile.getAttribute("data-state")) ?? "";
      const want = before === "kept" ? "dropped" : "kept";
      await tile.click();
      await expect
        .poll(async () => (await admin.from("photos").select("status, user_override").eq("id", photoId).single()).data, { timeout: 30_000 })
        .toEqual({ status: want, user_override: true });
      await expect(page.locator(`[data-testid="review-tile"][data-photo-id="${photoId}"]`)).toHaveAttribute("data-state", want);

      // Refresh on step 7 stays on 7 (no 2nd run), the toggle is kept.
      await page.reload();
      await expectWizardStep(page, 7, 60_000);
      expect(new URL(page.url()).searchParams.get("step")).toBe("7");
      await expect(page.getByTestId("review-banner-ai_off")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId(`review-tab-${want}`).first().click(); // the tile lives in its tab after a reload
      await expect(page.locator(`[data-testid="review-tile"][data-photo-id="${photoId}"]`)).toHaveAttribute("data-state", want);
      const reloaded = await page.evaluate(() => performance.timeOrigin);
      nav.reset();

      // Generate → editor (soft navigation from the hard-loaded step 7).
      await generateAlbum(page, id);
      expect(nav.docs).toEqual([]);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(reloaded);

      if (ANALYTICS) {
        await page.waitForTimeout(5_000); // posthog batches
        const done = events.filter((e) => e.event === "ai_build_done");
        console.log(`[i] ai_build_done ${JSON.stringify(done.map((e) => ({ mode: e.properties.mode, outcome: e.properties.outcome, auto: e.properties.auto })))}`);
        expect(done).toHaveLength(1);
        expect(done[0].properties).toMatchObject({ mode: "rules", outcome: "ok" });
      }

      const { data: runs, error } = await admin.from("agent_runs").select("id, mode, state, trigger").eq("book_id", id);
      if (error) throw new Error(`agent_runs select failed (${error.code})`);
      for (const r of runs ?? []) runIds.add((r as { id: string }).id);
      console.log(`[i] runs ${JSON.stringify((runs ?? []).map((r) => `${r.mode}:${r.trigger}:${r.state}`))}`);
      expect(runs ?? []).toHaveLength(1);
      expect(runs?.[0]).toMatchObject({ mode: "rule", trigger: "build", state: "done" });

      // Entry redirects with AI off: a fresh book's /build → the wizard (not classic); ?trigger=rebuild
      // of the built book stays classic. HTTP only (a browser visit would start a run).
      const req = page.context().request;
      const fresh = await createBookViaWizard(page, { title: "Fresh off", occasion: "travel", format: "A5_PORTRAIT" });
      bookIds.add(fresh);
      const freshBuild = await redirectOf(req, `/books/${fresh}/build`);
      console.log(`[i] /books/:fresh/build → ${String(freshBuild.to).replace(fresh, ":id")} (${freshBuild.status})`);
      expect(freshBuild.to ?? "").toMatch(new RegExp(`^/books/new\\?book=${fresh}&step=6`));
      const rb = await redirectOf(req, `/books/${id}/build?trigger=rebuild`);
      expect(rb).toMatchObject({ status: 200, to: null });
      expect(await req.get(`/books/${id}/build?trigger=rebuild`).then((r) => r.text())).not.toContain('data-testid="new-book-wizard"');
      const freshRuns = await admin.from("agent_runs").select("id", { count: "exact", head: true }).eq("book_id", fresh);
      expect(freshRuns.count ?? 0).toBe(0);
      expect((await admin.from("agent_runs").select("id", { count: "exact", head: true }).eq("book_id", id)).count).toBe(1);
    } finally {
      await context.close();
    }
  });

  test("g. analytics: book_created fires once for a wizard create, not again after step-5 Back + save", async ({ browser }) => {
    test.skip(!ANALYTICS, "set E2E_ANALYTICS=1 (server with fake NEXT_PUBLIC_POSTHOG_KEY/HOST)");
    test.setTimeout(240_000);
    const { context, page } = await newContext(browser, PHONE, { analytics: true });
    const events: { event: string; properties: Record<string, unknown> }[] = [];
    try {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
        Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
      });
      await context.route(`${PH_HOST}/**`, async (route) => {
        try {
          for (const e of decodeBody(route.request())) {
            const ev = e as { event?: unknown; properties?: Record<string, unknown> };
            if (ev && typeof ev.event === "string") events.push({ event: ev.event, properties: ev.properties ?? {} });
          }
        } catch {
          /* undecodable batch */
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
      });
      await context.route(/posthog\.com/, (r) => r.abort());
      const count = (e: string) => events.filter((x) => x.event === e).length;

      await walkWizardToStyle(page, { occasion: "family", format: "A5_PORTRAIT" });
      expect(count("book_created")).toBe(0);
      await page.getByTestId("create-book").click();
      await page.waitForURL(WIZARD_STEP5_URL, { timeout: 30_000 });
      const id = new URL(page.url()).searchParams.get("book") ?? "";
      bookIds.add(id);
      await expect.poll(() => count("book_created"), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      await expect(page).not.toHaveURL(/_ev=/);

      await page.getByTestId("upload-wizard-back").getByTestId("wizard-back").click();
      await expectWizardStep(page, 4, 30_000);
      await page.getByTestId("wizard-save").click();
      await page.waitForURL(new RegExp(`/books/new\\?book=${id}&step=5$`), { timeout: 30_000 });
      // A refresh of step 5 must not replay it either.
      await page.reload();
      await expectWizardStep(page, 5, 30_000);
      await page.waitForTimeout(5_000);
      console.log(`[g] events=${JSON.stringify([...new Set(events.map((e) => e.event))])} book_created=${count("book_created")}`);
      expect(count("book_created")).toBe(1);
      const props = events.find((e) => e.event === "book_created")?.properties ?? {};
      expect(JSON.stringify(props)).not.toContain(id);
    } finally {
      await context.close();
    }
  });

  test("z. audit summary: no horizontal scroll, ≥ 44 px targets, one h1, visible focus, AA text contrast", () => {
    console.log(`[url desync] ${urlDesync.length}: ${urlDesync.join(" | ")}`);
    console.log(`[audit summary] issues=${auditIssues.length}`);
    for (const i of auditIssues) console.log(`  ${i}`);
    expect(auditIssues).toEqual([]);
  });
});

// ---- helpers -------------------------------------------------------------------------------------

/**
 * Where a GET goes: a 3xx Location, or — on routes with a loading.tsx the redirect() is streamed —
 * a 200 whose HTML carries Next's meta refresh / NEXT_REDIRECT digest. null = renders here.
 */
async function redirectOf(req: APIRequestContext, url: string): Promise<{ status: number; to: string | null; streamed: boolean }> {
  const r = await req.get(url, { maxRedirects: 0 });
  const loc = r.headers()["location"];
  if (r.status() >= 300 && r.status() < 400) return { status: r.status(), to: loc ?? null, streamed: false };
  const html = await r.text();
  const meta = /http-equiv="refresh" content="\d+;\s*url=([^"]+)"/i.exec(html)?.[1];
  const digest = /NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/.exec(html)?.[1];
  const to = meta ? meta.replace(/&amp;/g, "&") : digest ?? null;
  return { status: r.status(), to, streamed: to !== null };
}

async function layoutGeometry(p: Page) {
  return p.evaluate(() => {
    const r = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y + scrollY), w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
      main: r("wizard-main"),
      headline: r("wizard-headline"),
      panel: r("wizard-step-panel"),
      aside: r("wizard-aside"),
      band: r("wizard-band"),
    };
  });
}

function decodeBody(req: Request): unknown[] {
  const buf = req.postDataBuffer();
  if (!buf || buf.length === 0) return [];
  const url = new URL(req.url());
  let text: string;
  if (url.searchParams.get("compression") === "gzip-js" || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    text = gunzipSync(buf).toString("utf8");
  } else {
    text = buf.toString("utf8");
    if (text.startsWith("data=")) text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
  }
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { batch?: unknown[] }).batch)) {
    return (parsed as { batch: unknown[] }).batch;
  }
  return [parsed];
}

async function makeSynthetic(p: Page, n: number, seedBase: number) {
  const list = await p.evaluate(
    async ({ count, seedBase }) => {
      function rng(seed: number) {
        let s = seed >>> 0;
        return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      }
      async function draw(seed: number): Promise<string> {
        const r = rng(seed * 7919 + 17);
        const c = document.createElement("canvas");
        c.width = 900;
        c.height = 1200;
        const g = c.getContext("2d")!;
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 9; x++) {
            g.fillStyle = `hsl(${Math.floor(r() * 360)}, ${40 + Math.floor(r() * 50)}%, ${15 + Math.floor(r() * 70)}%)`;
            g.fillRect(x * 100, y * 100, 100, 100);
          }
        }
        return new Promise((resolve) =>
          c.toBlob(
            (blob) => {
              const fr = new FileReader();
              fr.onload = () => resolve(String(fr.result).split(",")[1]);
              fr.readAsDataURL(blob!);
            },
            "image/jpeg",
            0.92,
          ),
        );
      }
      const out: string[] = [];
      for (let i = 0; i < count; i++) out.push(await draw(seedBase + i));
      return out;
    },
    { count: n, seedBase },
  );
  return list.map((b64, i) => ({ name: `m20-${seedBase + i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

// ---- a11y audit (rules of e2e/m11.spec.ts + computed text contrast) --------------------------------

type Target = { desc: string; w: number; h: number };
type LowContrast = { desc: string; ratio: number; need: number; fg: string; bg: string };

async function measure(p: Page, leather: [number, number, number]) {
  return p.evaluate((leatherRgb) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      return (el as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;
    };
    const desc = (el: Element) => {
      const tid = el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid");
      const label = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${label}"`;
    };
    const isInline = (el: Element) => {
      if (el.tagName !== "A") return false;
      if (getComputedStyle(el).display !== "inline") return false;
      let block = el.parentElement;
      while (block && getComputedStyle(block).display === "inline") block = block.parentElement;
      const own = ((el as HTMLElement).innerText ?? "").trim().length;
      const all = ((block as HTMLElement | null)?.innerText ?? "").trim().length;
      return all > own + 10;
    };
    const sel = "a[href],button,[role=button],[role=tab],[role=menuitem],[role=link],summary,select,textarea,input:not([type=hidden])";
    const small: Target[] = [];
    const inline: Target[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      let box: Element = el;
      if (el.tagName === "INPUT" && /^(radio|checkbox|file)$/.test((el as HTMLInputElement).type)) {
        const lab = el.closest("label");
        if (lab) box = lab;
        else if ((el as HTMLElement).getAttribute("aria-hidden") === "true") continue;
      }
      if (el.closest(".sr-only")) continue;
      if (!visible(box)) continue;
      const r = box.getBoundingClientRect();
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const t = { desc: desc(el), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
      if (isInline(el)) inline.push(t);
      else small.push(t);
    }
    const h1 = Array.from(document.querySelectorAll("h1")).filter((h) => (h as HTMLElement).checkVisibility?.() ?? true).length;

    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (top: number[], bottom: number[]) => {
      const a = top[3];
      return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
    };
    const band = document.querySelector('[data-testid="wizard-band"]');
    const bgOf = (el: Element): number[] | null => {
      // The leather band (noise url() + gradients): judged against its lightest point.
      if (band && band.contains(el)) {
        const layers: number[][] = [];
        for (let q: Element | null = el; q && q !== band; q = q.parentElement) {
          const c = parse(getComputedStyle(q).backgroundColor);
          if (c && c[3] > 0) {
            layers.push(c);
            if (c[3] >= 1) break;
          }
        }
        let out = [...leatherRgb, 1];
        for (let i = layers.length - 1; i >= 0; i--) out = blend(layers[i], out);
        return out;
      }
      const layers: number[][] = [];
      for (let q: Element | null = el; q; q = q.parentElement) {
        const s = getComputedStyle(q);
        const c = parse(s.backgroundColor);
        if (s.backgroundImage.includes("url(")) return null;
        if (s.backgroundImage !== "none" && !(c && c[3] >= 1)) return null;
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let out = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) out = blend(layers[i], out);
      return out;
    };
    const low: LowContrast[] = [];
    let checked = 0;
    let bandChecked = 0;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (el.closest('[aria-hidden="true"], [data-page], svg, .sr-only, nextjs-portal')) continue;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
      if (!own || !visible(el)) continue;
      const s = getComputedStyle(el);
      if (parseFloat(s.opacity) === 0) continue;
      const fg = parse(s.color);
      const bg = bgOf(el);
      if (!fg || !bg) continue;
      const f = fg[3] < 1 ? blend(fg, bg) : fg;
      const l1 = lum(f);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const disabled = (el as HTMLElement).closest("button:disabled, [aria-disabled=true], input:disabled");
      const need = large ? 3 : 4.5;
      checked++;
      if (band && band.contains(el)) bandChecked++;
      if (!disabled && ratio < need - 0.01) {
        low.push({ desc: desc(el), ratio: Math.round(ratio * 100) / 100, need, fg: s.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(",")})` });
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, h1, small, inline, low, checked, bandChecked };
  }, leather);
}

async function focusStops(p: Page) {
  await p.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.id = "m20-focus-start";
    document.body.prepend(start);
    start.focus({ preventScroll: true });
  });
  const out: { desc: string; visible: boolean }[] = [];
  for (let i = 0; i < TAB_STOPS; i++) {
    await p.keyboard.press("Tab");
    await p.waitForTimeout(120);
    const r = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const has = (e: Element) => {
        const s = getComputedStyle(e);
        return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow !== "none" && s.boxShadow !== "");
      };
      let ok = has(el);
      const label = el.closest("label");
      if (!ok && label) ok = has(label);
      let q = el.parentElement;
      for (let k = 0; !ok && q && k < 3; k++, q = q.parentElement) ok = has(q) && q.matches(":focus-within");
      const tid = el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid");
      const name = (el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      return { desc: `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${name}"`, visible: ok };
    });
    if (!r) break;
    out.push(r);
  }
  await p.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.getElementById("m20-focus-start")?.remove();
  });
  return out;
}

/** Every audit problem is collected here and asserted by "z. audit summary". */
const auditIssues: string[] = [];

/** `tab: false` on screens that move on by themselves. */
async function audit(p: Page, name: string, opts: { tab?: boolean } = {}) {
  await p.locator("h1").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()));
  const m = await measure(p, LEATHER_LIGHTEST);
  const focus = opts.tab === false ? [] : await focusStops(p);
  console.log(
    `[a11y ${name}] sw=${m.scrollWidth}/${m.innerWidth} h1=${m.h1} small=${m.small.length} inline=${m.inline.length} contrastChecked=${m.checked} band=${m.bandChecked} low=${m.low.length} focus=${focus.filter((f) => f.visible).length}/${focus.length}`,
  );
  for (const s of m.small) console.log(`  [small ${name}] ${s.desc} ${s.w}×${s.h}`);
  for (const l of m.low) console.log(`  [contrast ${name}] ${l.desc} ${l.ratio} < ${l.need} fg=${l.fg} bg=${l.bg}`);
  for (const f of focus.filter((x) => !x.visible)) console.log(`  [focus ${name}] no ring: ${f.desc}`);
  if (m.scrollWidth > m.innerWidth) auditIssues.push(`${name}: horizontal scroll ${m.scrollWidth}/${m.innerWidth}`);
  if (m.h1 !== 1) auditIssues.push(`${name}: ${m.h1} h1`);
  if (m.bandChecked === 0) auditIssues.push(`${name}: no band text checked`);
  for (const s of m.small) auditIssues.push(`${name}: target under 44×44 ${s.desc} ${s.w}×${s.h}`);
  for (const l of m.low) auditIssues.push(`${name}: contrast ${l.ratio} < ${l.need} ${l.desc}`);
  if (opts.tab !== false) {
    if (focus.length === 0) auditIssues.push(`${name}: Tab reaches no control`);
    for (const f of focus.filter((x) => !x.visible)) auditIssues.push(`${name}: focus without a visible ring ${f.desc}`);
  }
}

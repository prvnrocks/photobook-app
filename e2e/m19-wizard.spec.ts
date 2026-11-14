/**
 * Milestone 19 T9 — book creation wizard (D-071).
 *
 * Signed out (any server): /books/start redirects to /books/new; /books/new needs sign-in.
 *
 * LIVE part (E2E_AUTH=1, hosted Supabase; server with AI_MODE=replay, empty ANTHROPIC_API_KEY, dummy
 * Stripe key): ONE throwaway user `e2e+m19-<random>@example.com` (admin createUser + generateLink, no
 * email). Serial:
 *   a. 375 px: steps 1–4 — per step: no horizontal scroll, targets ≥ 44 px, visible focus on Tab, one
 *      h1, text contrast AA (computed colours); Arabic title with dir="auto" (input + cover art); browser
 *      back / forward across steps 1–4; refresh on step 3 keeps the choices; deep link to a later step
 *      bounces to the first missing one; create → the books row has the chosen title / occasion /
 *      format / design_style; step 5 in wizard chrome.
 *   b. step-5 Back (before any pick) re-opens step 4 prefilled (edit mode); walking back shows every
 *      answer; saving a change returns to step 5 and updates the row.
 *   c. step 5 → 6 photos → automatic first build (replay, responses held so step 6 renders) → step 6
 *      (photo fan, 3-row checklist, keep-open note) → editor. "Add more photos" on the built book =
 *      the normal (non-wizard) upload chrome.
 *   d. 1280 px pass: steps 1–6 audited + screenshotted on a second book (reaches the editor).
 *   e. (E2E_ANALYTICS=1 too: server built with NEXT_PUBLIC_POSTHOG_KEY=phc_e2e_fake +
 *      NEXT_PUBLIC_POSTHOG_HOST=https://ph.e2e.invalid, intercepted here) book_created fires exactly once
 *      for a wizard create, and not again after a step-5 Back + save.
 * Screenshots: docs/design/m19-step{1..6}-{375,1280}.png (dir override: M19_SHOT_DIR).
 * afterAll (always): storage under `<uid>/` (photos + exports), the user (books/photos cascade), then
 * the replay agent_runs this user created (ids captured before the delete). Per-test timeouts only.
 * Logs: counts / booleans only.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cardRadio, expectWizardStep, waitForWizardHydrated, walkWizardToStyle, wizardContinue } from "./helpers/create-book";

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
const SHOT_DIR = process.env.M19_SHOT_DIR || path.join(__dirname, "..", "docs", "design");
const BUCKETS = ["photos", "exports"];
const UUID = "[0-9a-f-]{36}";
const ARABIC_TITLE = "رحلتنا إلى العين";
const TAB_STOPS = 6;
const PH_HOST = process.env.E2E_POSTHOG_HOST ?? "https://ph.e2e.invalid";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// ---- signed out ----------------------------------------------------------------------------------

test.describe("m19 wizard (signed out)", () => {
  test("/books/start redirects to /books/new; /books/new asks for sign-in", async ({ request }) => {
    const start = await request.get("/books/start", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(start.status());
    const loc = start.headers()["location"] ?? "";
    // Either straight to /books/new or (signed out) via the login page back to /books/new.
    expect(loc).toMatch(/^\/(books\/new|login\?next=%2Fbooks%2F(new|start))/);
    const nb = await request.get("/books/new?step=3", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(nb.status());
    expect(nb.headers()["location"] ?? "").toMatch(/^\/login\?next=%2Fbooks%2Fnew/);
  });
});

// ---- live ----------------------------------------------------------------------------------------

test.describe("m19 wizard (live)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 to run the live M19 wizard walkthrough");
  test.describe.configure({ mode: "serial" });

  let admin: SupabaseClient;
  let baseURL = "";
  let uid = "";
  let email = "";
  const bookIds = new Set<string>();
  const runIds = new Set<string>();
  let phone: { context: BrowserContext; page: Page };
  let bookA = "";

  async function signInHash(): Promise<string> {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
    return data.properties.hashed_token;
  }

  async function newContext(browser: Browser, viewport: { width: number; height: number }, opts: { analytics?: boolean } = {}) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({
      viewport,
      baseURL,
      ...(mobile ? { hasTouch: true, isMobile: true } : {}),
      ...(opts.analytics ? { userAgent: PHONE_UA } : {}),
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
    await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/dashboard`);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    return { context, page };
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

  async function shot(p: Page, step: number, width: number) {
    mkdirSync(SHOT_DIR, { recursive: true });
    await p.mouse.move(0, 0).catch(() => {}); // no hover state in the picture
    // Wait (≤ 15 s) for in-view images (step 6's photo fan) so the shot shows what users see.
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
    await p.screenshot({ path: path.join(SHOT_DIR, `m19-step${step}-${width}.png`), fullPage: true, animations: "disabled" });
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

  /**
   * Replay ticks take ~0 ms: hold every run API response a little so step 6 stays on screen long
   * enough to audit + screenshot. Records run ids for cleanup.
   */
  async function holdRunResponses(p: Page, delayMs: number) {
    await p.route(/\/api\/ai\/runs(\/|\?|$)/, async (route) => {
      const res = await route.fetch();
      const body = await res.text();
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

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(120_000);
    baseURL = String(info.project.use.baseURL ?? "");
    admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    email = `e2e+m19-${randomBytes(6).toString("hex")}@example.com`;
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

  test("a. 375: steps 1–4 audited, Arabic title dir=auto, back/forward, refresh on step 3, create → row + step 5", async () => {
    test.setTimeout(240_000);
    const { page } = phone;

    // Empty dashboard: "Make your first book" → the wizard (test d uses "New book" with a book listed).
    await page.getByTestId("create-first-book").click();
    await page.waitForURL(/\/books\/new/, { timeout: 30_000 });
    await expectWizardStep(page, 1, 30_000);
    await waitForWizardHydrated(page);
    await audit(page, "step 1 (375)");
    await shot(page, 1, 375);

    // Arabic title: dir="auto" on the input and the cover preview; resolves right-to-left.
    const title = page.getByTestId("book-title");
    await title.fill(ARABIC_TITLE);
    await expect(title).toHaveAttribute("dir", "auto");
    expect(await title.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    const coverSpan = page.getByTestId("wizard-cover-title").locator('[dir="auto"]');
    await expect(coverSpan).toHaveText(ARABIC_TITLE);
    expect(await coverSpan.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    await wizardContinue(page, 1);

    // Step 2.
    await audit(page, "step 2 (375)");
    await expect(page.getByTestId("lang-en")).toBeChecked(); // en-US browser → English captions suggested
    await page.getByTestId("occasion-graduation").click();
    await expect(cardRadio(page, "occasion-graduation")).toBeChecked();
    await shot(page, 2, 375);
    await wizardContinue(page, 2);

    // Step 3: nothing chosen yet → Continue disabled until a shape is picked.
    await expect(page.getByTestId("wizard-continue")).toBeDisabled();
    await page.getByTestId("format-A5_LANDSCAPE").click();
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    await expect(page.getByTestId("wizard-continue")).toBeEnabled();
    await audit(page, "step 3 (375)");
    await shot(page, 3, 375);

    // Refresh on step 3 keeps every choice (sessionStorage mirror).
    await page.reload();
    await expectWizardStep(page, 3, 30_000);
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    expect(new URL(page.url()).searchParams.get("step")).toBe("3");

    // Browser back / forward across steps.
    await page.goBack();
    await expectWizardStep(page, 2);
    await expect(cardRadio(page, "occasion-graduation")).toBeChecked();
    await page.goBack();
    await expectWizardStep(page, 1);
    await expect(page.getByTestId("book-title")).toHaveValue(ARABIC_TITLE);
    await page.goForward();
    await expectWizardStep(page, 2);
    await page.goForward();
    await expectWizardStep(page, 3);
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    // In-app Back works like browser back.
    await page.getByTestId("wizard-back").click();
    await expectWizardStep(page, 2);
    await wizardContinue(page, 2);
    await wizardContinue(page, 3);

    // Step 4: graduation's default style (Geometric) is preselected; pick Scrapbook.
    await expect(cardRadio(page, "style-geometric")).toBeChecked();
    await page.getByTestId("style-scrapbook").click();
    await expect(cardRadio(page, "style-scrapbook")).toBeChecked();
    await expect(page.getByTestId("create-book")).toBeEnabled();
    await audit(page, "step 4 (375)");
    await shot(page, 4, 375);

    await page.getByTestId("create-book").click();
    await page.waitForURL(new RegExp(`/books/${UUID}/upload$`), { timeout: 30_000 });
    bookA = new URL(page.url()).pathname.split("/")[2];
    bookIds.add(bookA);
    expect(await bookRow(bookA)).toMatchObject({
      title: ARABIC_TITLE,
      occasion: "graduation",
      format: "A5_LANDSCAPE",
      design_style: "scrapbook",
      caption_lang: "en",
    });

    // Step 5 in wizard chrome: label, Back, the Arabic title with dir=auto.
    await expect(page.getByTestId("wizard-shell")).toBeVisible();
    await expect(page.getByTestId("wizard-step-label")).toHaveText("Step 5 of 6");
    await expect(page.getByTestId("upload-book-title")).toHaveText(ARABIC_TITLE);
    await expect(page.getByTestId("upload-book-title")).toHaveAttribute("dir", "auto");
    await expect(page.getByTestId("upload-wizard-back")).toBeVisible();
    await audit(page, "step 5 (375)");
    await shot(page, 5, 375);

    // A fresh deep link to step 3 (the draft was cleared on create) starts again at step 1.
    await page.goto("/books/new?step=3");
    await expectWizardStep(page, 1, 30_000);
    await expect(page.getByTestId("book-title")).toHaveValue("");

    // Observation (reported, not asserted): browser Back twice → the create-mode step-4 URL we
    // submitted from. What does the wizard show there — an empty new-book wizard (duplicate risk)?
    await page.goBack(); // → step 5 (upload)
    await page.waitForURL(new RegExp(`/books/${bookA}/upload$`), { timeout: 30_000 });
    await page.goBack(); // → /books/new?step=4 (create)
    await page.waitForURL(/\/books\/new\?step=4$|\/books\/new\?step=1$|\/books\/new$/, { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    const after = await page.evaluate(() => {
      const w = document.querySelector('[data-testid="new-book-wizard"]');
      const t = document.querySelector<HTMLInputElement>('[data-testid="book-title"]');
      return { url: location.pathname + location.search, step: w?.getAttribute("data-step") ?? null, mode: w?.getAttribute("data-mode") ?? null, titleEmpty: t ? t.value === "" : null };
    });
    console.log(`[a] browser Back from step 5 → ${JSON.stringify(after)}`);
    test.info().annotations.push({ type: "observation", description: `browser Back from step 5: ${JSON.stringify(after)}` });
    await page.goto(`/books/${bookA}/upload`);
  });

  test("b. step-5 Back re-opens step 4 prefilled; saving a change returns to step 5", async () => {
    test.setTimeout(180_000);
    test.skip(!bookA, "needs the book from test a");
    const { page } = phone;
    await page.goto(`/books/${bookA}/upload`);
    await expect(page.getByTestId("upload-wizard-back")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("upload-wizard-back").getByTestId("wizard-back").click();
    await page.waitForURL(new RegExp(`/books/new\\?book=${bookA}&step=4$`), { timeout: 30_000 });
    await expect(page.getByTestId("new-book-wizard")).toHaveAttribute("data-mode", "edit");
    await expectWizardStep(page, 4, 30_000);
    await expect(cardRadio(page, "style-scrapbook")).toBeChecked();
    await expect(page.getByTestId("wizard-save")).toBeVisible();

    // Walk back: every answer is there.
    await page.getByTestId("wizard-back").click();
    await expectWizardStep(page, 3);
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    await page.getByTestId("wizard-back").click();
    await expectWizardStep(page, 2);
    await expect(cardRadio(page, "occasion-graduation")).toBeChecked();
    await page.getByTestId("wizard-back").click();
    await expectWizardStep(page, 1);
    await expect(page.getByTestId("book-title")).toHaveValue(ARABIC_TITLE);

    // Change the style, save → back on step 5, row updated (title / occasion / format kept).
    await wizardContinue(page, 1);
    await wizardContinue(page, 2);
    await wizardContinue(page, 3);
    await page.getByTestId("style-classic").click();
    await expect(cardRadio(page, "style-classic")).toBeChecked();
    await page.getByTestId("wizard-save").click();
    await page.waitForURL(new RegExp(`/books/${bookA}/upload$`), { timeout: 30_000 });
    await expect(page.getByTestId("wizard-step-label")).toHaveText("Step 5 of 6");
    expect(await bookRow(bookA)).toMatchObject({
      title: ARABIC_TITLE,
      occasion: "graduation",
      format: "A5_LANDSCAPE",
      design_style: "classic",
    });
  });

  test("c. step 5 → photos → step 6 (replay) → editor; add more photos = normal chrome", async () => {
    test.setTimeout(600_000);
    test.skip(!bookA, "needs the book from test a");
    const { page } = phone;
    await holdRunResponses(page, 2_500);
    await page.goto(`/books/${bookA}/upload`);
    await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6, 100));
    await expect(page.getByTestId("upload-wizard-back")).toHaveCount(0); // Back hides once photos are picked
    await expect(page.getByTestId("upload-progress")).toBeVisible({ timeout: 60_000 });
    await audit(page, "step 5 uploading (375)", { tab: false });

    await page.waitForURL(new RegExp(`/books/${bookA}/build\\?auto=1$`), { timeout: 240_000 });
    await expect(page.getByTestId("wizard-step-label")).toHaveText("Step 6 of 6", { timeout: 30_000 });
    await expect(page.getByTestId("build-photo-fan")).toBeVisible();
    for (const id of ["sift", "moments", "book"]) await expect(page.getByTestId(`build-step-${id}`)).toBeVisible();
    await expect(page.getByTestId("build-keep-open")).toBeVisible();
    await expect(page.getByTestId("build-progress")).toHaveAttribute("data-variant", "wizard");
    await audit(page, "step 6 (375)", { tab: false });
    await shot(page, 6, 375);
    const fan = await page.getByTestId("build-photo-fan").evaluate((el) => {
      const imgs = Array.from(el.querySelectorAll("img"));
      return { count: el.getAttribute("data-count"), imgs: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length };
    }).catch(() => null);
    console.log(`[c] step-6 fan ${JSON.stringify(fan)}`);
    expect(fan?.loaded ?? 0, "step-6 fan shows the book's photos").toBeGreaterThan(0);

    await page.waitForURL(new RegExp(`/books/${bookA}/edit$`), { timeout: 420_000 });
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // Add more photos to the built book: classic chrome (no wizard shell / step label / wizard Back).
    await page.goto(`/books/${bookA}/upload`);
    await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("wizard-shell")).toHaveCount(0);
    await expect(page.getByTestId("wizard-step-label")).toHaveCount(0);
    await expect(page.getByTestId("upload-wizard-back")).toHaveCount(0);
    await expect(page.getByTestId("upload-occasion")).toHaveText("Graduation");
    await audit(page, "add more photos (375)");

    // The details are locked now → the wizard edit link goes to the editor.
    await page.goto(`/books/new?book=${bookA}&step=4`);
    await page.waitForURL(new RegExp(`/books/${bookA}/edit$`), { timeout: 30_000 });
  });

  test("d. 1280: steps 1–6 audited + screenshots (second book reaches the editor)", async ({ browser }) => {
    test.setTimeout(600_000);
    const desk = await newContext(browser, DESKTOP);
    const page = desk.page;
    try {
      // Dashboard with a book → header "New book" → the wizard.
      await page.getByTestId("new-book").click();
      await page.waitForURL(/\/books\/new/, { timeout: 30_000 });
      await walkWizardToStyle(page, {
        goto: false,
        title: "Desert weekend",
        occasion: "travel",
        format: "A5_PORTRAIT",
        expectStyle: "geometric",
        onStep: async (n) => {
          await audit(page, `step ${n} (1280)`);
        },
        beforeContinue: async (n) => {
          await shot(page, n, 1280);
        },
      });
      await page.getByTestId("create-book").click();
      await page.waitForURL(new RegExp(`/books/${UUID}/upload$`), { timeout: 30_000 });
      const id = new URL(page.url()).pathname.split("/")[2];
      bookIds.add(id);
      expect(await bookRow(id)).toMatchObject({ title: "Desert weekend", occasion: "travel", format: "A5_PORTRAIT", design_style: "geometric" });
      await audit(page, "step 5 (1280)");
      await shot(page, 5, 1280);

      await holdRunResponses(page, 2_500);
      await page.getByTestId("upload-input").setInputFiles(await makeSynthetic(page, 6, 300));
      await page.waitForURL(new RegExp(`/books/${id}/build\\?auto=1$`), { timeout: 240_000 });
      await expect(page.getByTestId("build-photo-fan")).toBeVisible({ timeout: 30_000 });
      await audit(page, "step 6 (1280)", { tab: false });
      await shot(page, 6, 1280);
      await page.waitForURL(new RegExp(`/books/${id}/edit$`), { timeout: 420_000 });
      await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    } finally {
      await desk.context.close();
    }
  });

  test("e. analytics: book_created fires once for a wizard create, not again after Back + save", async ({ browser }) => {
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
      await page.waitForURL(new RegExp(`/books/${UUID}/upload$`), { timeout: 30_000 });
      const id = new URL(page.url()).pathname.split("/")[2];
      bookIds.add(id);
      await expect.poll(() => count("book_created"), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

      // Back to step 4, save → step 5 again: no second book_created.
      await page.getByTestId("upload-wizard-back").getByTestId("wizard-back").click();
      await expectWizardStep(page, 4, 30_000);
      await page.getByTestId("wizard-save").click();
      await page.waitForURL(new RegExp(`/books/${id}/upload$`), { timeout: 30_000 });
      await page.waitForTimeout(5_000); // let any duplicate batch arrive
      console.log(`[e] events=${JSON.stringify([...new Set(events.map((e) => e.event))])} book_created=${count("book_created")}`);
      expect(count("book_created")).toBe(1);
      const props = events.find((e) => e.event === "book_created")?.properties ?? {};
      expect(JSON.stringify(props)).not.toContain(id);
    } finally {
      await context.close();
    }
  });

  test("z. audit summary: no horizontal scroll, ≥ 44 px targets, one h1, visible focus, AA text contrast", () => {
    console.log(`[audit summary] issues=${auditIssues.length}`);
    expect(auditIssues).toEqual([]);
  });
});

// ---- helpers -------------------------------------------------------------------------------------

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
  return list.map((b64, i) => ({ name: `m19-${seedBase + i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

// ---- a11y audit (rules of e2e/m11.spec.ts + computed text contrast) --------------------------------

type Target = { desc: string; w: number; h: number };
type LowContrast = { desc: string; ratio: number; need: number; fg: string; bg: string };

async function measure(p: Page) {
  return p.evaluate(() => {
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
      if (!visible(box)) continue;
      const r = box.getBoundingClientRect();
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const t = { desc: desc(el), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
      if (isInline(el)) inline.push(t);
      else small.push(t);
    }
    const h1 = Array.from(document.querySelectorAll("h1")).filter((h) => (h as HTMLElement).checkVisibility?.() ?? true).length;

    // Text contrast: every visible element with its own text, against the composited ancestor
    // background colour. Skips decorative (aria-hidden) art, images and gradient/photo backgrounds.
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
    const bgOf = (el: Element): number[] | null => {
      const layers: number[][] = [];
      for (let q: Element | null = el; q; q = q.parentElement) {
        const s = getComputedStyle(q);
        const c = parse(s.backgroundColor);
        // A photo / url() background: unknown colour under the text → skip. A gradient (the wizard
        // shell's faint radial tint) is judged on its base colour.
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
      if (!disabled && ratio < need - 0.01) {
        low.push({ desc: desc(el), ratio: Math.round(ratio * 100) / 100, need, fg: s.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(",")})` });
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, h1, small, inline, low, checked };
  });
}

async function focusStops(p: Page) {
  await p.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.id = "m19-focus-start";
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
    document.getElementById("m19-focus-start")?.remove();
  });
  return out;
}

/**
 * Every audit problem is collected here and asserted by the last live test ("z. audit summary"), so
 * one a11y finding doesn't stop the serial flow (a failed serial test skips the rest).
 */
const auditIssues: string[] = [];

/** `tab: false` on screens that move on by themselves. */
async function audit(p: Page, name: string, opts: { tab?: boolean } = {}) {
  await p.locator("h1").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()));
  const m = await measure(p);
  const focus = opts.tab === false ? [] : await focusStops(p);
  console.log(
    `[a11y ${name}] sw=${m.scrollWidth}/${m.innerWidth} h1=${m.h1} small=${m.small.length} inline=${m.inline.length} contrastChecked=${m.checked} low=${m.low.length} focus=${focus.filter((f) => f.visible).length}/${focus.length}`,
  );
  for (const s of m.small) console.log(`  [small ${name}] ${s.desc} ${s.w}×${s.h}`);
  for (const l of m.low) console.log(`  [contrast ${name}] ${l.desc} ${l.ratio} < ${l.need} fg=${l.fg} bg=${l.bg}`);
  for (const f of focus.filter((x) => !x.visible)) console.log(`  [focus ${name}] no ring: ${f.desc}`);
  if (m.scrollWidth > m.innerWidth) auditIssues.push(`${name}: horizontal scroll ${m.scrollWidth}/${m.innerWidth}`);
  if (m.h1 !== 1) auditIssues.push(`${name}: ${m.h1} h1`);
  for (const s of m.small) auditIssues.push(`${name}: target under 44×44 ${s.desc} ${s.w}×${s.h}`);
  for (const l of m.low) auditIssues.push(`${name}: contrast ${l.ratio} < ${l.need} ${l.desc}`);
  if (opts.tab !== false) {
    if (focus.length === 0) auditIssues.push(`${name}: Tab reaches no control`);
    for (const f of focus.filter((x) => !x.visible)) auditIssues.push(`${name}: focus without a visible ring ${f.desc}`);
  }
}

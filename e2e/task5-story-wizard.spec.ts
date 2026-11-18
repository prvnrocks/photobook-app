/**
 * Task 5 — the complete book-creation wizard with the Story and Design steps, at 375 px.
 * Order: 1 Title → 2 Occasion (book created) → 3 Photos (upload only) → 4 Story ("Every memory has a
 * story.") → 5 Design (shape + style, "Recommended") → 6 Create → 7 Preview → the editor.
 *
 * LIVE only (E2E_AUTH=1, hosted Supabase; server: next start with AI_MODE=replay and an empty
 * ANTHROPIC_API_KEY — never a live Anthropic call). ONE throwaway user
 * `e2e+task5-<random>@example.com` (admin createUser + generateLink, no email). Serial:
 *   a. Travel: both questions answered (one typed, one chip) + a tone; Back to Photos and forward
 *      keeps them; saved on Continue; a reload on step 4 shows them again; storybooks.context holds
 *      exactly those answers (source "user", the server's question text, skipped false, nothing
 *      else); Design shows "Recommended" on a shape and a style, both overridden by hand → the book
 *      row has the manual format / design_style; Create → Preview → editor; context unchanged.
 *   b. Baby: "Skip for now" → context skipped true, answers [], no invented text; flow completes.
 *   c. Birthday can be chosen and asks two questions (book left on step 4 for f).
 *   d. Wedding: the visible prompts mention the occasion and the important moments.
 *   e. Accessibility of Story and Design at 375 px: one h1, named fields / radios, the tone as a
 *      keyboard-operable radio group that can be cleared, ≥ 44 px targets, no horizontal scroll,
 *      focus on the headline (or first field) after a step change.
 *   f. A book left on step 4 / 5 opens in the wizard from its dashboard card (not the editor); an
 *      old-numbering URL ?book=<id>&step=5 of a book without photos lands on Photos, no error.
 *   g. AI off (E2E_OFF_URL = a second server with AI_MODE=off; skipped when unset): Story + Design
 *      → rule build → Preview → editor; the answers are stored all the same.
 *   s. Screenshots of Story and Design at 375 and 1280 (TASK5_SHOT_DIR, default the test output dir
 *      — never the repo).
 * afterAll (always): storage under `<uid>/`, the user (books / photos / storybooks cascade), then the
 * agent_runs this user created. Logs: counts and booleans only — never answers, ids or keys.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cardRadio,
  chooseDesign,
  continueFromPhotos,
  createBookViaWizard,
  expectWizardStep,
  generateAlbum,
  STORY_HEADLINE,
  storyFields,
  waitForReview,
  WIZARD_STORY_TONE_LABELS,
  type WizardOptions,
} from "./helpers/create-book";
import { storyQuestionsFor } from "../src/lib/story/questions";

const LIVE = process.env.E2E_AUTH === "1";
const OFF_URL = process.env.E2E_OFF_URL ?? "";

if (LIVE && !process.env.SUPABASE_SECRET_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env.local"));
  } catch {
    /* reported by env() below */
  }
}

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const BUCKETS = ["photos", "exports"];
const UUID = /^[0-9a-f-]{36}$/;
const TYPED_ANSWER = "My two cousins, for the first time";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

test.describe("task 5 story wizard (live)", () => {
  test.skip(!LIVE, "set E2E_AUTH=1 to run the live Task 5 wizard walkthrough");
  test.describe.configure({ mode: "serial" });

  let admin: SupabaseClient;
  let baseURL = "";
  let uid = "";
  let email = "";
  let shotDir = "";
  let phone: { context: BrowserContext; page: Page };
  const bookIds = new Set<string>();
  const runIds = new Set<string>();
  const pageErrors: string[] = [];
  let travelBook = "";
  let birthdayBook = "";
  let weddingBook = "";

  async function signInHash(): Promise<string> {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed (${error?.code ?? "no token"})`);
    return data.properties.hashed_token;
  }

  async function newContext(browser: Browser, viewport: { width: number; height: number }) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({
      viewport,
      baseURL,
      locale: "en-US",
      ...(mobile ? { hasTouch: true, isMobile: true } : {}),
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
    page.on("pageerror", (e) => pageErrors.push(e.name));
    await page.goto(`/auth/confirm?token_hash=${await signInHash()}&type=magiclink&next=/dashboard`);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    return { context, page };
  }

  async function bookRow(id: string) {
    const { data, error } = await admin
      .from("books")
      .select("title, occasion, format, design_style, page_count, ai_status, album_confirmed_at")
      .eq("id", id)
      .single();
    if (error) throw new Error(`books select failed (${error.code})`);
    return data as {
      title: string | null;
      occasion: string;
      format: string;
      design_style: string;
      page_count: number;
      ai_status: string | null;
      album_confirmed_at: string | null;
    };
  }

  /** storybooks.context of a book (null = no row). */
  async function storyContext(id: string): Promise<{ context: Record<string, unknown>; context_rev: number } | null> {
    const { data, error } = await admin.from("storybooks").select("context, context_rev, user_id").eq("book_id", id).maybeSingle();
    if (error) throw new Error(`storybooks select failed (${error.code})`);
    if (!data) return null;
    expect((data as { user_id: string }).user_id).toBe(uid);
    return data as { context: Record<string, unknown>; context_rev: number };
  }

  async function runsOf(bookId: string) {
    const { data, error } = await admin.from("agent_runs").select("id, state, trigger, mode").eq("book_id", bookId);
    if (error) throw new Error(`agent_runs select failed (${error.code})`);
    for (const r of data ?? []) runIds.add((r as { id: string }).id);
    return (data ?? []) as { id: string; state: string; trigger: string; mode: string }[];
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

  async function pickPhotos(p: Page, n: number, seed: number) {
    await expect(p.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
    await p.getByTestId("upload-input").setInputFiles(await makeSynthetic(p, n, seed));
  }

  /** Steps 1–3 with `n` photos uploaded, then Continue → the Story step. Returns the book id. */
  async function bookOnStory(p: Page, opts: WizardOptions, n: number, seed: number): Promise<string> {
    const id = await createBookViaWizard(p, opts);
    bookIds.add(id);
    await pickPhotos(p, n, seed);
    await continueFromPhotos(p);
    await expect(p.getByTestId("wizard-headline")).toHaveText(STORY_HEADLINE);
    return id;
  }

  async function shot(p: Page, name: string) {
    mkdirSync(shotDir, { recursive: true });
    await p.evaluate(() => {
      window.scrollTo(0, 0);
      (document.activeElement as HTMLElement | null)?.blur?.();
    });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true, animations: "disabled" });
  }

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(120_000);
    baseURL = String(info.project.use.baseURL ?? "");
    shotDir = process.env.TASK5_SHOT_DIR || path.join(info.project.outputDir, "task5-shots");
    admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    email = `e2e+task5-${randomBytes(6).toString("hex")}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser failed (${error?.code ?? "no user"})`);
    uid = data.user.id;
    phone = await newContext(browser, PHONE);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    if (!uid) return;
    await phone?.context.close().catch(() => {});
    for (const b of (await admin.from("books").select("id").eq("user_id", uid)).data ?? []) bookIds.add((b as { id: string }).id);
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
    const stories = await admin.from("storybooks").select("book_id", { count: "exact", head: true }).eq("user_id", uid);
    const ids = [...runIds];
    let runsDeleted = 0;
    let runsLeft = 0;
    if (ids.length) {
      runsDeleted = (await admin.from("agent_runs").delete().in("id", ids).select("id")).data?.length ?? 0;
      runsLeft = (await admin.from("agent_runs").select("id", { count: "exact", head: true }).in("id", ids)).count ?? 0;
    }
    console.log(
      `[cleanup] objects removed=${removed} left=${left} books=${books.count} storybooks=${stories.count} runsFound=${ids.length} runsDeleted=${runsDeleted} runsLeft=${runsLeft} userDeleted=${!error}`,
    );
    expect(error).toBeNull();
    expect(left).toBe(0);
    expect(books.count ?? 0).toBe(0);
    expect(stories.count ?? 0).toBe(0);
    expect(runsLeft).toBe(0);
  });

  test("a. Travel: typed answer + chip + tone survive Back / forward / reload; context = the user's words only; Recommended overridden by hand; → editor", async () => {
    test.setTimeout(600_000);
    const { page } = phone;
    const [q1, q2] = storyQuestionsFor("travel");
    const runPosts: string[] = [];
    const onRequest = (r: { method(): string; url(): string }) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/ai/runs") runPosts.push("run");
    };
    page.on("request", onRequest);

    travelBook = await bookOnStory(page, { title: "Task five travel", occasion: "travel" }, 6, 500);

    // Step 4: the two travel questions, nothing prefilled, no tone chosen; nothing stored yet.
    await expect(page.getByTestId(`story-question-${q1.id}`).locator("label")).toContainText(q1.prompt);
    await expect(page.getByTestId(`story-question-${q2.id}`).locator("label")).toContainText(q2.prompt);
    await expect(storyFields(page)).toHaveCount(2);
    for (const i of [0, 1]) await expect(storyFields(page).nth(i)).toHaveValue("");
    await expect(page.locator('input[name="story-tone"]:checked')).toHaveCount(0);
    expect(await storyContext(travelBook)).toBeNull();
    await shot(page, "story-375-empty");

    // One typed, one via a chip (the chip fills the field with exactly its words), tone "Joyful & playful".
    await page.getByTestId(`story-answer-${q1.id}`).fill(TYPED_ANSWER);
    const chip = page.getByTestId(`story-question-${q2.id}`).getByTestId("story-chip").nth(2);
    const chipWords = ((await chip.textContent()) ?? "").trim();
    expect(q2.suggestions).toContain(chipWords);
    await chip.tap();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`story-answer-${q2.id}`)).toHaveValue(chipWords);
    await expect(page.getByTestId("story-tone-joyful")).toHaveText(WIZARD_STORY_TONE_LABELS.joyful);
    await page.getByTestId("story-tone-joyful").tap();
    await expect(cardRadio(page, "story-tone-joyful")).toBeChecked();
    await shot(page, "story-375-filled");

    // Back to Photos and forward again: still there (nothing was saved yet — the client keeps it).
    await page.getByTestId("wizard-back").tap();
    await expectWizardStep(page, 3);
    expect(await storyContext(travelBook)).toBeNull();
    await continueFromPhotos(page);
    await expect(page.getByTestId(`story-answer-${q1.id}`)).toHaveValue(TYPED_ANSWER);
    await expect(page.getByTestId(`story-answer-${q2.id}`)).toHaveValue(chipWords);
    await expect(cardRadio(page, "story-tone-joyful")).toBeChecked();

    // Continue saves; back on step 4 a RELOAD shows the stored answers and tone.
    await page.getByTestId("story-continue").tap();
    await expectWizardStep(page, 5, 30_000);
    await page.getByTestId("wizard-back").tap();
    await expectWizardStep(page, 4);
    await page.reload();
    await expectWizardStep(page, 4, 30_000);
    expect(new URL(page.url()).searchParams.get("step")).toBe("4");
    await expect(storyFields(page)).toHaveCount(2, { timeout: 30_000 }); // one settled set after the reload
    await expect(page.getByTestId(`story-answer-${q1.id}`)).toHaveValue(TYPED_ANSWER, { timeout: 30_000 });
    await expect(page.getByTestId(`story-answer-${q2.id}`)).toHaveValue(chipWords);
    await expect(cardRadio(page, "story-tone-joyful")).toBeChecked();
    await expect(page.locator('input[name="story-tone"]:checked')).toHaveCount(1);

    // The stored context: exactly the two answers, in the user's words, with the SERVER's prompts.
    const expectedAnswers = [
      { questionId: q1.id, question: "Who did you travel with?", text: TYPED_ANSWER, source: "user" },
      { questionId: q2.id, question: "What made this trip special?", text: chipWords, source: "user" },
    ];
    const stored = await storyContext(travelBook);
    expect(stored).not.toBeNull();
    const ctx = stored!.context;
    expect(ctx.answers).toEqual(expectedAnswers);
    expect(ctx).toMatchObject({ occasion: "travel", storyTone: "joyful", skipped: false, lang: "en" });
    // Nothing invented: every free-text field of the memory context is still empty.
    expect({ note: ctx.note, people: ctx.people, places: ctx.places, facts: ctx.facts, avoid: ctx.avoid, dateRange: ctx.dateRange }).toEqual({
      note: null,
      people: [],
      places: [],
      facts: [],
      avoid: [],
      dateRange: null,
    });
    expect(Object.keys(ctx).sort()).toEqual(
      ["answers", "avoid", "dateRange", "facts", "lang", "narrator", "note", "occasion", "people", "places", "rev", "skipped", "storyTone", "tone", "updatedAt", "v"].sort(),
    );
    expect(ctx.rev).toBe(stored!.context_rev);
    expect(runPosts).toEqual([]); // no build was asked for on Photos or Story
    expect((await runsOf(travelBook)).length).toBe(0);

    // Design: "Recommended" on one shape and on one style (travel → Magazine; the 900 × 1200
    // fixtures → Portrait), both preselected; the provisional row is the same pair.
    await page.getByTestId("story-continue").tap();
    await expectWizardStep(page, 5, 30_000);
    await expect(page.getByTestId("design-shape").getByTestId("choice-badge")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("format-A5_PORTRAIT").getByTestId("choice-badge")).toHaveText("Recommended");
    await expect(page.getByTestId("design-style").getByTestId("choice-badge")).toHaveCount(1);
    await expect(page.getByTestId("style-magazine").getByTestId("choice-badge")).toHaveText("Recommended");
    await expect(cardRadio(page, "format-A5_PORTRAIT")).toBeChecked();
    await expect(cardRadio(page, "style-magazine")).toBeChecked();
    await expect(page.getByTestId("format-reason")).toBeVisible();
    await expect(page.getByTestId("style-reason")).toBeVisible();
    expect(await bookRow(travelBook)).toMatchObject({ format: "A5_PORTRAIT", design_style: "magazine" });
    await shot(page, "design-375-recommended");

    // Override both by hand: the badges stay where they were, the choice is the user's.
    await page.getByTestId("format-A5_LANDSCAPE").tap();
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    await page.getByTestId("style-classic").tap();
    await expect(cardRadio(page, "style-classic")).toBeChecked();
    await expect(page.getByTestId("format-A5_PORTRAIT").getByTestId("choice-badge")).toHaveText("Recommended");
    await expect(page.getByTestId("style-magazine").getByTestId("choice-badge")).toHaveText("Recommended");
    await shot(page, "design-375-manual");
    await page.getByTestId("wizard-design-continue").tap();

    // Create → Preview → editor; the row ends with the manual design; one build request, one run.
    await waitForReview(page, travelBook);
    expect(await bookRow(travelBook)).toMatchObject({ format: "A5_LANDSCAPE", design_style: "classic", occasion: "travel" });
    await generateAlbum(page, travelBook);
    const row = await bookRow(travelBook);
    expect(row).toMatchObject({ format: "A5_LANDSCAPE", design_style: "classic" });
    expect(row.album_confirmed_at).not.toBeNull();
    expect(row.page_count).toBeGreaterThan(0);
    expect(runPosts).toHaveLength(1);
    const runs = await runsOf(travelBook);
    expect(runs.length).toBe(1);
    // The build read the context, it never wrote into it.
    const after = await storyContext(travelBook);
    expect(after!.context).toEqual(ctx);
    console.log(`[a] answers=${(ctx.answers as unknown[]).length} rev=${String(ctx.rev)} runs=${runs.length} mode=${runs[0]?.mode} pages=${row.page_count}`);
    page.off("request", onRequest);
  });

  test("b. Baby: Skip for now → context skipped true, answers [], nothing invented; the flow completes", async () => {
    test.setTimeout(600_000);
    const { page } = phone;
    const id = await bookOnStory(page, { title: "Task five baby", occasion: "baby" }, 6, 520);
    const [q1, q2] = storyQuestionsFor("baby");
    await expect(page.getByTestId(`story-question-${q1.id}`)).toBeVisible();
    await expect(page.getByTestId(`story-question-${q2.id}`)).toBeVisible();
    for (const i of [0, 1]) await expect(storyFields(page).nth(i)).toHaveValue("");
    await expect(page.getByTestId("story-skip")).toHaveText("Skip for now");
    await page.getByTestId("story-skip").tap();
    await expectWizardStep(page, 5, 30_000);

    const stored = await storyContext(id);
    expect(stored).not.toBeNull();
    const ctx = stored!.context;
    expect(ctx).toMatchObject({ occasion: "baby", skipped: true, answers: [], storyTone: null, note: null, people: [], places: [], facts: [], avoid: [], dateRange: null });

    // Back on the step after a skip: still empty (a skip never fills anything in).
    await page.getByTestId("wizard-back").tap();
    await expectWizardStep(page, 4);
    for (const i of [0, 1]) await expect(storyFields(page).nth(i)).toHaveValue("");
    await expect(page.locator('[data-testid="story-chip"][aria-pressed="true"]')).toHaveCount(0);
    await page.getByTestId("story-skip").tap();
    await expectWizardStep(page, 5, 30_000);

    await chooseDesign(page, { format: "A5_PORTRAIT" });
    await waitForReview(page, id);
    await generateAlbum(page, id);
    const after = await storyContext(id);
    expect(after!.context).toMatchObject({ skipped: true, answers: [], storyTone: null, note: null, people: [], places: [], facts: [] });
    const runs = await runsOf(id);
    console.log(`[b] skipped=${String(after!.context.skipped)} answers=${(after!.context.answers as unknown[]).length} runs=${runs.length}`);
    expect(runs.length).toBe(1);
  });

  test("c. Birthday can be chosen on step 2 and asks two questions", async () => {
    test.setTimeout(300_000);
    const { page } = phone;
    birthdayBook = await bookOnStory(page, { title: "Task five birthday", occasion: "birthday" }, 2, 540);
    expect(await bookRow(birthdayBook)).toMatchObject({ occasion: "birthday" });
    const fields = storyFields(page);
    await expect(fields).toHaveCount(2);
    await expect(page.getByRole("textbox", { name: /Whose birthday was it\?/ })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /What made the day special\?/ })).toBeVisible();
    // Each question has its own tap-to-fill chips.
    for (const q of storyQuestionsFor("birthday")) {
      expect(await page.getByTestId(`story-question-${q.id}`).getByTestId("story-chip").count()).toBeGreaterThanOrEqual(3);
    }
    // Left here on purpose (nothing answered, nothing saved): test f opens it from the dashboard.
    expect(await storyContext(birthdayBook)).toBeNull();
  });

  test("f. a book left on step 4 / 5 opens in the wizard from its dashboard card; old ?step=5 without photos lands on Photos", async () => {
    test.setTimeout(300_000);
    test.skip(!birthdayBook, "needs the birthday book of test c");
    const { page } = phone;
    const errorsBefore = pageErrors.length;

    // Left on step 4: the card leads into the wizard, never to the editor.
    const row = await bookRow(birthdayBook);
    console.log(`[f] left-on-4 book: page_count>0=${row.page_count > 0} ai_status=${row.ai_status} confirmed=${row.album_confirmed_at !== null}`);
    await page.goto("/dashboard");
    const card = page.getByTestId("book-card").filter({ hasText: "Task five birthday" });
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    const href = (await card.getAttribute("href")) ?? "";
    expect(href).toBe(`/books/new?book=${birthdayBook}&step=5`);
    await card.click();
    await page.waitForURL((u) => u.pathname === "/books/new" && u.searchParams.get("book") === birthdayBook, { timeout: 30_000 });
    await expect(page.getByTestId("new-book-wizard")).toBeVisible({ timeout: 30_000 });
    const landed = Number(await page.getByTestId("new-book-wizard").getAttribute("data-step"));
    console.log(`[f] card of a book left on step 4 → wizard step ${landed}`);
    expect([4, 5]).toContain(landed);
    await expect(page.getByTestId("editor-shell")).toHaveCount(0);
    expect((await runsOf(birthdayBook)).length).toBe(0); // opening it started nothing

    // Left on step 5 (a design picked, not continued): the same.
    await page.goto(`/books/new?book=${birthdayBook}&step=5`);
    await expectWizardStep(page, 5, 30_000);
    await expect(page.getByTestId("wizard-step-design")).toBeVisible({ timeout: 30_000 });
    await page.goto("/dashboard");
    const card5 = page.getByTestId("book-card").filter({ hasText: "Task five birthday" });
    await expect(card5).toHaveCount(1, { timeout: 30_000 });
    await card5.click();
    await page.waitForURL((u) => u.pathname === "/books/new" && u.searchParams.get("book") === birthdayBook, { timeout: 30_000 });
    await expectWizardStep(page, 5, 30_000);
    // The editor URL of such a book is not where the dashboard sends anyone.
    expect(await page.locator(`a[href="/books/${birthdayBook}/edit"]`).count()).toBe(0);

    // An old-numbering link (5 used to be Photos) on a book WITHOUT photos → Photos, no error.
    const empty = await createBookViaWizard(page, { title: "Task five empty", occasion: "other" });
    bookIds.add(empty);
    for (const n of [5, 4]) {
      const res = await page.goto(`/books/new?book=${empty}&step=${n}`);
      expect(res?.status() ?? 0).toBeLessThan(400);
      await expectWizardStep(page, 3, 30_000);
      await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("wizard-step-error")).toHaveCount(0);
      await expect(page.getByTestId("wizard-step-story")).toHaveCount(0);
      await expect(page.getByTestId("wizard-step-design")).toHaveCount(0);
    }
    expect(new URL(page.url()).searchParams.get("step")).toBe("3");
    // Its card (no photos) leads to Photos as well.
    await page.goto("/dashboard");
    const emptyCard = page.getByTestId("book-card").filter({ hasText: "Task five empty" });
    await expect(emptyCard).toHaveCount(1, { timeout: 30_000 });
    expect(await emptyCard.getAttribute("href")).toBe(`/books/new?book=${empty}&step=3`);
    expect(pageErrors.length - errorsBefore).toBe(0);
  });

  test("d. Wedding: the visible questions ask about the occasion and the moments that mattered", async () => {
    test.setTimeout(300_000);
    const { page } = phone;
    weddingBook = await bookOnStory(page, { title: "Task five wedding", occasion: "wedding" }, 2, 560);
    const labels = (await page.getByTestId("wizard-step-story").locator("label[for]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    expect(labels).toHaveLength(2);
    // Question 1: whose day / what kind of celebration (the occasion).
    expect(labels[0]).toMatch(/whose day/i);
    expect(labels[0]).toMatch(/celebration/i);
    // Question 2: the important moments.
    expect(labels[1]).toMatch(/moments/i);
    expect(labels[1]).toMatch(/mattered most|important/i);
    for (const l of labels) expect(l).toMatch(/\(optional\)$/);
    // The chips speak about a wedding day and its moments too.
    const chips = await page.getByTestId("story-chip").allInnerTexts();
    expect(chips.some((c) => /wedding/i.test(c))).toBe(true);
    expect(chips.some((c) => /vows|first dance/i.test(c))).toBe(true);
    await expect(page.getByRole("textbox", { name: /Whose day was it, and what kind of celebration\?/ })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Which moments mattered most\?/ })).toBeVisible();
  });

  test("e. accessibility of Story and Design at 375 px: names, keyboard tone group, 44 px targets, no sideways scroll, focus on step change", async () => {
    test.setTimeout(300_000);
    test.skip(!weddingBook, "needs the wedding book of test d");
    const { page } = phone;
    const issues: string[] = [];

    // Arrive on Story through a step change (Photos → Continue): focus lands on the headline or the first field.
    await page.goto(`/books/new?book=${weddingBook}&step=3`);
    await expectWizardStep(page, 3, 30_000);
    await continueFromPhotos(page);
    const focusStory = await focusedPart(page);
    console.log(`[e] focus after 3 → 4: ${focusStory}`);
    expect(["headline", "first-field"]).toContain(focusStory);

    const story = await surfaceAudit(page);
    console.log(`[e] story: ${JSON.stringify({ ...story, small: story.small.length, unnamed: story.unnamed.length })}`);
    if (story.h1 !== 1) issues.push(`story: ${story.h1} h1`);
    if (story.scrollWidth > story.innerWidth) issues.push(`story: horizontal scroll ${story.scrollWidth}/${story.innerWidth}`);
    for (const s of story.small) issues.push(`story: target under 44 px ${s}`);
    for (const u of story.unnamed) issues.push(`story: no accessible name ${u}`);
    expect(story.textareas).toBe(2);
    expect(story.radios).toBe(3);

    // The tone: a named group of three native radios sharing one name, none required.
    const group = page.getByRole("group", { name: /How should it sound\?/ });
    await expect(group).toBeVisible();
    for (const label of Object.values(WIZARD_STORY_TONE_LABELS)) await expect(group.getByRole("radio", { name: label })).toHaveCount(1);
    await expect(group.getByRole("radio")).toHaveCount(3);
    expect(await group.getByRole("radio").evaluateAll((els) => new Set(els.map((e) => (e as HTMLInputElement).name)).size)).toBe(1);

    // Keyboard only: Tab from the last chip reaches the group; Space picks, arrows move, Space clears.
    await page.getByTestId("story-chip").last().focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name ?? "")).toBe("story-tone");
    await page.keyboard.press("Space");
    await expect(group.getByRole("radio", { name: WIZARD_STORY_TONE_LABELS.heartfelt })).toBeChecked();
    await page.keyboard.press("ArrowDown");
    await expect(group.getByRole("radio", { name: WIZARD_STORY_TONE_LABELS.joyful })).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: WIZARD_STORY_TONE_LABELS.elegant })).toBeChecked();
    await page.keyboard.press("ArrowUp");
    await expect(group.getByRole("radio", { name: WIZARD_STORY_TONE_LABELS.joyful })).toBeChecked();
    await expect(group.getByRole("radio", { checked: true })).toHaveCount(1);
    // The focused option shows a visible ring (on its card).
    const ring = await page.evaluate(() => {
      const label = (document.activeElement as HTMLElement | null)?.closest("label");
      if (!label) return false;
      const s = getComputedStyle(label);
      return (s.boxShadow !== "none" && s.boxShadow !== "") || (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0);
    });
    if (!ring) issues.push("story: focused tone has no visible ring");
    await page.keyboard.press("Space"); // the checked option again → cleared
    await expect(group.getByRole("radio", { checked: true })).toHaveCount(0);
    // … and by tap: choose, tap again → cleared.
    await page.getByTestId("story-tone-elegant").tap();
    await expect(cardRadio(page, "story-tone-elegant")).toBeChecked();
    await page.getByTestId("story-tone-elegant").tap();
    await expect(group.getByRole("radio", { checked: true })).toHaveCount(0);

    // Chips are buttons with a pressed state; Enter in a field continues (a one-line answer).
    const chip = page.getByTestId("story-chip").first();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();

    // Story → Design by keyboard (Enter in the field submits): focus lands on the new headline.
    await storyFields(page).first().focus();
    await page.keyboard.press("Enter");
    await expectWizardStep(page, 5, 30_000);
    await expect(page.getByTestId("wizard-step-design")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("design-shape").getByTestId("choice-badge")).toHaveCount(1, { timeout: 30_000 });
    const focusDesign = await focusedPart(page);
    console.log(`[e] focus after 4 → 5: ${focusDesign}`);
    expect(["headline", "first-field"]).toContain(focusDesign);

    const design = await surfaceAudit(page);
    console.log(`[e] design: ${JSON.stringify({ ...design, small: design.small.length, unnamed: design.unnamed.length })}`);
    if (design.h1 !== 1) issues.push(`design: ${design.h1} h1`);
    if (design.scrollWidth > design.innerWidth) issues.push(`design: horizontal scroll ${design.scrollWidth}/${design.innerWidth}`);
    for (const s of design.small) issues.push(`design: target under 44 px ${s}`);
    for (const u of design.unnamed) issues.push(`design: no accessible name ${u}`);
    expect(design.radios).toBe(8); // 2 shapes + 6 styles
    // Two named radio groups; the badge is part of the card's name, so "Recommended" is announced.
    await expect(page.getByTestId("design-shape").getByRole("radio")).toHaveCount(2);
    await expect(page.getByTestId("design-style").getByRole("radio")).toHaveCount(6);
    await expect(page.getByTestId("design-shape").getByRole("radio", { name: /Recommended/ })).toHaveCount(1);
    await expect(page.getByTestId("design-style").getByRole("radio", { name: /Recommended/ })).toHaveCount(1);
    for (const fs of ["design-shape", "design-style"]) {
      const name = await page.getByTestId(fs).evaluate((el) => el.querySelector("legend")?.textContent?.trim() ?? el.getAttribute("aria-label") ?? "");
      if (!name) issues.push(`design: ${fs} group has no name`);
    }
    // Arrow keys move the shape choice.
    await cardRadio(page, "format-A5_PORTRAIT").focus();
    await page.keyboard.press("Space");
    await expect(cardRadio(page, "format-A5_PORTRAIT")).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(cardRadio(page, "format-A5_LANDSCAPE")).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(cardRadio(page, "format-A5_PORTRAIT")).toBeChecked();
    await expect(page.getByRole("button", { name: "Create my book" })).toBeVisible();

    console.log(`[e] issues=${issues.length}`);
    for (const i of issues) console.log(`  ${i}`);
    expect(issues).toEqual([]);
  });

  test("s. screenshots: Story and Design at 1280 (and the filled Story at 375)", async ({ browser }) => {
    test.setTimeout(300_000);
    test.skip(!weddingBook, "needs the wedding book of test d");
    const desk = await newContext(browser, DESKTOP);
    try {
      const p = desk.page;
      await p.goto(`/books/new?book=${weddingBook}&step=4`);
      await expectWizardStep(p, 4, 30_000);
      await expect(storyFields(p)).toHaveCount(2);
      const wide = await surfaceAudit(p);
      expect(wide.scrollWidth).toBeLessThanOrEqual(wide.innerWidth);
      expect(wide.h1).toBe(1);
      await shot(p, "story-1280");
      await p.getByTestId("story-chip").nth(1).click();
      await p.getByTestId("story-tone-heartfelt").click();
      await shot(p, "story-1280-filled");
      await p.getByTestId("story-skip").click();
      await expectWizardStep(p, 5, 30_000);
      await expect(p.getByTestId("design-shape").getByTestId("choice-badge")).toHaveCount(1, { timeout: 30_000 });
      const wideDesign = await surfaceAudit(p);
      expect(wideDesign.scrollWidth).toBeLessThanOrEqual(wideDesign.innerWidth);
      expect(wideDesign.h1).toBe(1);
      await shot(p, "design-1280");
    } finally {
      await desk.context.close();
    }
    console.log(`[s] screenshots written to the test output dir`);
  });

  test("g. AI off: Story (answer + tone) and Design still lead through the rule build to the editor", async () => {
    test.setTimeout(600_000);
    test.skip(!OFF_URL, "set E2E_OFF_URL (a second server with AI_MODE=off)");
    const { page } = phone;
    await page.goto(`${OFF_URL}/books/new`);
    const id = await createBookViaWizard(page, { title: "Task five no AI", occasion: "family", goto: false });
    bookIds.add(id);
    const api = await page.context().request.get(`${OFF_URL}/api/books/${id}/wizard?step=3`);
    expect(api.ok()).toBe(true);
    expect(((await api.json()) as { aiOn?: boolean }).aiOn).toBe(false);
    await pickPhotos(page, 6, 580);
    await continueFromPhotos(page);

    const [q1] = storyQuestionsFor("family");
    const chip = page.getByTestId(`story-question-${q1.id}`).getByTestId("story-chip").first();
    const chipWords = ((await chip.textContent()) ?? "").trim();
    await chip.tap();
    await page.getByTestId("story-tone-elegant").tap();
    await page.getByTestId("story-continue").tap();
    await expectWizardStep(page, 5, 30_000);
    // The recommendation needs no AI: badges show with AI off too.
    await expect(page.getByTestId("design-shape").getByTestId("choice-badge")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("design-style").getByTestId("choice-badge")).toHaveCount(1);
    await chooseDesign(page, { format: "A5_LANDSCAPE", style: "scrapbook" });
    await waitForReview(page, id);
    await expect(page.getByTestId("review-banner-ai_off")).toBeVisible();
    await generateAlbum(page, id);
    expect(new URL(page.url()).origin).toBe(new URL(OFF_URL).origin);

    const row = await bookRow(id);
    expect(row).toMatchObject({ occasion: "family", format: "A5_LANDSCAPE", design_style: "scrapbook" });
    expect(row.page_count).toBeGreaterThan(0);
    const runs = await runsOf(id);
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ mode: "rule", state: "done" });
    const stored = await storyContext(id);
    expect(stored!.context).toMatchObject({
      occasion: "family",
      storyTone: "elegant",
      skipped: false,
      answers: [{ questionId: q1.id, question: q1.prompt, text: chipWords, source: "user" }],
      note: null,
      people: [],
      places: [],
      facts: [],
    });
    console.log(`[g] AI off: runs=${runs.length} mode=${runs[0]?.mode} pages=${row.page_count} answers=${(stored!.context.answers as unknown[]).length}`);
  });

  test("z. no uncaught page error during the walkthrough", () => {
    console.log(`[z] page errors=${pageErrors.length} ${[...new Set(pageErrors)].join(",")}`);
    expect(pageErrors).toEqual([]);
    for (const id of bookIds) expect(id).toMatch(UUID);
  });
});

// ---- helpers -------------------------------------------------------------------------------------

/** Where the focus is after a step change: the step headline, the step's first field, or something else. */
async function focusedPart(p: Page): Promise<string> {
  // The wizard focuses the headline in an effect after the step renders.
  await expect
    .poll(() => p.evaluate(() => document.activeElement !== null && document.activeElement !== document.body), { timeout: 5_000 })
    .toBe(true)
    .catch(() => {});
  return p.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    if (el.matches('h1[data-testid="wizard-headline"]')) return "headline";
    const step = document.querySelector('[data-testid="wizard-step-story"], [data-testid="wizard-step-design"]');
    const first = step?.querySelector("textarea, input, button");
    if (first && el === first) return "first-field";
    return `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? ""}]`;
  });
}

/**
 * One frame of measurements for the screen: visible h1 count, page width, interactive targets under
 * 44 × 44 px (a radio is measured by its card label; inline text links are left out) and fields /
 * radios / buttons without an accessible name.
 */
async function surfaceAudit(p: Page) {
  await p.evaluate(() => document.fonts.ready);
  return p.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      return (el as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;
    };
    const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const nameOf = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((id) => text(document.getElementById(id))).join(" ").trim();
        if (t) return t;
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length) {
        const t = Array.from(labels).map((l) => text(l)).join(" ").trim();
        if (t) return t;
      }
      if (el.tagName === "BUTTON" || el.tagName === "A") return text(el);
      return "";
    };
    const desc = (el: Element) => {
      const tid = el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid");
      return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""}`;
    };
    const sel = "a[href],button,[role=button],summary,select,textarea,input:not([type=hidden])";
    const small: string[] = [];
    const unnamed: string[] = [];
    let textareas = 0;
    let radios = 0;
    for (const el of Array.from(document.querySelectorAll(sel))) {
      let box: Element = el;
      const isChoice = el.tagName === "INPUT" && /^(radio|checkbox|file)$/.test((el as HTMLInputElement).type);
      if (isChoice) {
        const lab = el.closest("label");
        if (lab) box = lab;
        else if (el.getAttribute("aria-hidden") === "true") continue;
      } else if (el.closest(".sr-only")) continue;
      if (!visible(box)) continue;
      if (el.tagName === "TEXTAREA") textareas++;
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "radio") radios++;
      if (!nameOf(el)) unnamed.push(desc(el));
      const r = box.getBoundingClientRect();
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
      small.push(`${desc(el)} ${Math.round(r.width * 10) / 10}×${Math.round(r.height * 10) / 10}`);
    }
    const h1 = Array.from(document.querySelectorAll("h1")).filter((h) => (h as HTMLElement).checkVisibility?.() ?? true).length;
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, h1, textareas, radios, small, unnamed };
  });
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
  return list.map((b64, i) => ({ name: `task5-${seedBase + i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}

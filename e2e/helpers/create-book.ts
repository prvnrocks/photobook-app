/**
 * Shared e2e helper: walk the book creation wizard on /books/new (M19 D-071, M20 D-072 — one
 * continuous 7-step wizard; Task 5 order). Steps:
 *   1 Title (book-title)
 *   2 Occasion (occasion-* labels, incl. birthday; NO caption-language control since M20 — the server
 *     derives it: Arabic-script title → memory → Accept-Language → en) → create-book: the book is
 *     created HERE, with a provisional design (default shape + the occasion's style)
 *   3 Photos (/books/new?book=<id>&step=3; upload-input / upload-pick). Upload only — no build starts.
 *     When the upload settled: upload-wizard-continue.
 *   4 Story ("Every memory has a story."; story-answer-<questionId>, story-chip, story-tone-<tone>;
 *     story-continue / story-skip) — optional.
 *   5 Design (format-* and style-* labels on one screen; six style cards since M30, travel defaults to
 *     Magazine — D-090; a "Recommended" badge = choice-badge) → wizard-design-continue ("Create my
 *     book"): saves the design and asks for the first build.
 *   6 Create (?step=6) renders in place. Since Task 8 it is the storybook generation screen ("Your
 *     memories are becoming a story.", wizard-step-story-generation): Design's Continue starts the
 *     storybook job and, when it is done, the wizard opens /books/<id>/edit by itself — there is no
 *     step 7 for a new book. 7 Preview + "Generate album" (wizard-generate) remain only for books made
 *     by the old album flow (a book whose active job is an album build).
 *
 * Specs written before Task 5 call createBookViaWizard(page, { format, style }), upload their photos,
 * then wait for step 6 / 7. That still works: the options are remembered per page, and
 * waitForSortingOrReview / waitForReview / finishWizardToEditor first walk Photos → Story → Design
 * with them (finishBookSetup) when the wizard is still on an open step (3–5).
 *
 * The occasion / format / style testids sit on the card <label>; the native radio is inside it.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type WizardOccasion = "wedding" | "travel" | "baby" | "birthday" | "graduation" | "family" | "other";
/** The seven step-2 cards in display order. */
export const WIZARD_OCCASIONS: readonly WizardOccasion[] = ["wedding", "travel", "baby", "birthday", "graduation", "family", "other"];
export type WizardFormat = "A5_PORTRAIT" | "A5_LANDSCAPE";
/** M30 (D-090): six style cards — the four older styles + Magazine and Editorial. */
export type WizardStyle = "modern" | "classic" | "geometric" | "scrapbook" | "magazine" | "editorial";
/** The Design step's style cards in display order (2 × 3 at 375 px, 3 × 2 from `sm`). */
export const WIZARD_STYLES: readonly WizardStyle[] = ["modern", "classic", "geometric", "scrapbook", "magazine", "editorial"];
export type WizardStoryTone = "heartfelt" | "joyful" | "elegant";
export const WIZARD_STORY_TONE_LABELS: Record<WizardStoryTone, string> = {
  heartfelt: "Heartfelt & personal",
  joyful: "Joyful & playful",
  elegant: "Elegant & timeless",
};
/**
 * What to do on step 4: "skip" (default: "Skip for now"), or answers in question order — a string is
 * typed, `{ chip: n }` taps that question's n-th suggestion chip, null leaves the question empty —
 * plus an optional tone, then Continue.
 */
export type WizardStory = "skip" | { answers?: (string | { chip: number } | null)[]; tone?: WizardStoryTone };

export type WizardOptions = {
  /** Typed on step 1; "" / undefined = leave blank (allowed). */
  title?: string;
  occasion?: WizardOccasion;
  /**
   * Clicked on step 5 (Design). Default A5_PORTRAIT — clicked, so the shape never depends on what
   * the recommendation makes of a spec's fixture photos. "recommended" = no tap: keep the shape the
   * step preselected (the shortest real walk; tap-counting specs).
   */
  format?: WizardFormat | "recommended";
  /**
   * Click this style on step 5; undefined = keep what is selected (the recommendation = the
   * occasion's default). M30 (D-090): travel now defaults to Magazine (was Geometric) — a spec that is
   * not about the Magazine style must name its style here, or it silently starts testing magazine
   * books (and needs migration 2100 on the DB).
   */
  style?: WizardStyle;
  /** Assert this style is selected on step 5 before continuing (e.g. the occasion default). */
  expectStyle?: WizardStyle;
  /** Step 4 (Story). Default "skip". */
  story?: WizardStory;
  /** Navigate to /books/new first (default true). false = the page is already on step 1. */
  goto?: boolean;
  /** Optional tap/click wrapper (tap-counting specs). Receives the target + a label. */
  press?: (target: Locator, label: string) => Promise<void>;
  /** Called with the step number when a step the helper walks (1, 2, 4, 5) is on screen (screenshots / audits). */
  onStep?: (step: 1 | 2 | 4 | 5) => Promise<void>;
  /** Called on steps 1, 2, 4, 5 after the choices are made, just before Continue (screenshots). */
  beforeContinue?: (step: 1 | 2 | 4 | 5) => Promise<void>;
};

/** Step 3 (Photos) in the continuous wizard: /books/new?book=<id>&step=3 (no navigation since step 1). */
export const WIZARD_PHOTOS_URL = /\/books\/new\?book=([0-9a-f-]{36})&step=3$/;
/** Step 6 (the build) or 7 (preview) of a book — a fast replay run may skip past 6 before we look. */
export const wizardStepUrl = (bookId: string, steps = "[67]") => new RegExp(`/books/new\\?book=${bookId}&step=${steps}$`);
export const WIZARD_TOTAL = 7;
/** Stepper names, in order (Task 5). */
export const WIZARD_STEP_NAMES = ["Title", "Occasion", "Photos", "Story", "Design", "Create", "Edit"] as const;
export const STORY_HEADLINE = "Every memory has a story.";

/** The options createBookViaWizard was given, for the later Story / Design steps of the same page. */
const remembered = new WeakMap<Page, WizardOptions>();

/** For specs that create the book by hand (walkWizardToOccasion + create-book): what finishBookSetup should use later. */
export function rememberWizardOptions(page: Page, opts: WizardOptions): void {
  remembered.set(page, opts);
}

/** The native radio inside a card label testid. */
export function cardRadio(page: Page, testId: string): Locator {
  return page.getByTestId(testId).locator('input[type="radio"]');
}

export async function expectWizardStep(page: Page, step: 1 | 2 | 3 | 4 | 5 | 6 | 7, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId("new-book-wizard")).toHaveAttribute("data-step", String(step), { timeout });
  await expect(page.getByTestId("wizard-step-label")).toHaveText(`Step ${step} of ${WIZARD_TOTAL}`, { timeout });
}

/**
 * Wait until the wizard island is hydrated: typing into the title updates the band title (client
 * state). A probe word is typed and removed so the real title starts clean.
 */
export async function waitForWizardHydrated(page: Page): Promise<void> {
  const input = page.getByTestId("book-title");
  const cover = page.getByTestId("wizard-band-title");
  await expect(input).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await input.fill("Probe");
    await expect(cover).toHaveText("Probe", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await input.fill("");
}

async function pressOn(opts: WizardOptions, target: Locator, label: string): Promise<void> {
  if (opts.press) await opts.press(target, label);
  else await target.click();
}

/** Step-1 Continue → step 2 (step 2's own Continue creates the book: createBookViaWizard). */
export async function wizardContinue(page: Page, from: 1, opts: WizardOptions = {}): Promise<void> {
  await pressOn(opts, page.getByTestId("wizard-continue"), `Continue (step ${from})`);
  await expectWizardStep(page, (from + 1) as 2);
}

/** Steps 1–2 of the wizard: title typed, occasion chosen — stops on step 2, nothing submitted. */
export async function walkWizardToOccasion(page: Page, opts: WizardOptions = {}): Promise<void> {
  if (opts.goto !== false) await page.goto("/books/new");
  await expectWizardStep(page, 1, 30_000);
  await waitForWizardHydrated(page);
  await opts.onStep?.(1);
  if (opts.title) {
    await page.getByTestId("book-title").fill(opts.title);
    await expect(page.getByTestId("book-title")).toHaveValue(opts.title);
  }
  await opts.beforeContinue?.(1);
  await wizardContinue(page, 1, opts);

  await opts.onStep?.(2);
  const occasion = opts.occasion ?? "travel";
  await pressOn(opts, page.getByTestId(`occasion-${occasion}`), `Occasion: ${occasion}`);
  await expect(cardRadio(page, `occasion-${occasion}`)).toBeChecked();
  await opts.beforeContinue?.(2);
}

/**
 * Walk steps 1–2 and create the book (step-2 Continue). Returns the new book id; the page stays on
 * /books/new — now ?book=<id>&step=3 — with the upload picker of the Photos step ready. `format`,
 * `style`, `expectStyle` and `story` are remembered for finishBookSetup (after the upload).
 */
export async function createBookViaWizard(page: Page, opts: WizardOptions = {}): Promise<string> {
  await walkWizardToOccasion(page, opts);
  await pressOn(opts, page.getByTestId("create-book"), "Continue (step 2: create)");
  await page.waitForURL(WIZARD_PHOTOS_URL, { timeout: 30_000 });
  await expectWizardStep(page, 3, 30_000);
  await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
  remembered.set(page, opts);
  const u = new URL(page.url());
  return WIZARD_PHOTOS_URL.exec(u.pathname + u.search)![1];
}

/** The step the wizard shows now (data-step), or null when the wizard isn't on screen. */
export async function currentWizardStep(page: Page): Promise<number | null> {
  const raw = await page.getByTestId("new-book-wizard").getAttribute("data-step", { timeout: 5_000 }).catch(() => null);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(n) ? n : null;
}

/**
 * Step 3 → 4: wait until the upload settled (the Continue button shows only then — never while
 * photos are still uploading) and continue to the Story step. No build starts here.
 */
export async function continueFromPhotos(page: Page, opts: WizardOptions = {}, timeout = 240_000): Promise<void> {
  const next = page.getByTestId("upload-wizard-continue");
  await expect(next).toBeVisible({ timeout });
  await pressOn(opts, next, "Continue (step 3: photos)");
  await expectWizardStep(page, 4, 30_000);
  await expect(page.getByTestId("wizard-step-story")).toBeVisible({ timeout: 30_000 });
}

/** The (≤ 2) answer fields of the Story step, in question order. */
export function storyFields(page: Page): Locator {
  return page.getByTestId("wizard-step-story").locator("textarea");
}

/** Step 4 → 5: skip, or answer (typed text / a chip per question, an optional tone) and continue. */
export async function answerStory(page: Page, opts: WizardOptions = {}): Promise<void> {
  await expectWizardStep(page, 4, 30_000);
  await expect(page.getByTestId("wizard-headline")).toHaveText(STORY_HEADLINE);
  await opts.onStep?.(4);
  const story = opts.story ?? "skip";
  if (story === "skip") {
    await opts.beforeContinue?.(4);
    await pressOn(opts, page.getByTestId("story-skip"), "Skip for now (step 4: story)");
  } else {
    const questions = page.locator('[data-testid^="story-question-"]');
    const answers = story.answers ?? [];
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i];
      if (a === null) continue;
      const q = questions.nth(i);
      if (typeof a === "string") {
        await q.locator("textarea").fill(a);
        await expect(q.locator("textarea")).toHaveValue(a);
      } else {
        const chip = q.getByTestId("story-chip").nth(a.chip);
        await pressOn(opts, chip, `Story chip ${a.chip} (question ${i + 1})`);
        await expect(chip).toHaveAttribute("aria-pressed", "true");
      }
    }
    if (story.tone) {
      await pressOn(opts, page.getByTestId(`story-tone-${story.tone}`), `Story tone: ${story.tone}`);
      await expect(cardRadio(page, `story-tone-${story.tone}`)).toBeChecked();
    }
    await opts.beforeContinue?.(4);
    await pressOn(opts, page.getByTestId("story-continue"), "Continue (step 4: story)");
  }
  await expectWizardStep(page, 5, 30_000);
  await expect(page.getByTestId("wizard-step-design")).toBeVisible({ timeout: 30_000 });
}

/**
 * Step 5: choose the shape (always clicked — default portrait) and, when given, the style; then
 * "Create my book" (saves the design when it differs and asks for the first build). Waits only until
 * the wizard has left step 5 (the button is busy meanwhile — a second walk must not press it again);
 * use waitForSortingOrReview / waitForReview for step 6 / the editor.
 */
export async function chooseDesign(page: Page, opts: WizardOptions = {}): Promise<void> {
  await expectWizardStep(page, 5, 30_000);
  await opts.onStep?.(5);
  const format = opts.format ?? "A5_PORTRAIT";
  if (format === "recommended") {
    await expect(page.locator('input[name="wizard-format"]:checked')).toHaveCount(1, { timeout: 30_000 });
  } else {
    await pressOn(opts, page.getByTestId(`format-${format}`), `Shape: ${format}`);
    await expect(cardRadio(page, `format-${format}`)).toBeChecked();
  }
  if (opts.style) {
    await pressOn(opts, page.getByTestId(`style-${opts.style}`), `Style: ${opts.style}`);
    await expect(cardRadio(page, `style-${opts.style}`)).toBeChecked();
  }
  if (opts.expectStyle) await expect(cardRadio(page, `style-${opts.expectStyle}`)).toBeChecked();
  await opts.beforeContinue?.(5);
  await pressOn(opts, page.getByTestId("wizard-design-continue"), "Create my book (step 5: design)");
  await expect
    .poll(async () => /\/edit$/.test(new URL(page.url()).pathname) || (await currentWizardStep(page)) !== 5, { timeout: 120_000 })
    .toBe(true);
}

/**
 * After the spec picked its photos on step 3: walk Photos → Story → Design from wherever the wizard
 * is (3, 4 or 5) with the options createBookViaWizard was given (or `opts`), ending with the build
 * request. A no-op when the wizard already left the open steps (6 / 7) or isn't on screen.
 */
export async function finishBookSetup(page: Page, opts?: WizardOptions, timeout = 240_000): Promise<void> {
  const o = opts ?? remembered.get(page) ?? {};
  let step = await currentWizardStep(page);
  if (step === 3) {
    await continueFromPhotos(page, o, timeout);
    step = 4;
  }
  if (step === 4) {
    await answerStory(page, o);
    step = 5;
  }
  if (step === 5) await chooseDesign(page, o);
}

/**
 * After photos were picked on step 3: finish Story + Design (finishBookSetup) when still needed, then
 * wait until the wizard is on step 6 (the build), already 7 (old album flow) or — a fast storybook
 * run — already in the editor (Task 8: step 6 opens it by itself).
 */
export async function waitForSortingOrReview(page: Page, bookId: string, timeout = 240_000): Promise<6 | 7 | "editor"> {
  await finishBookSetup(page, undefined, timeout);
  const steps = wizardStepUrl(bookId);
  const edit = new RegExp(`/books/${bookId}/edit$`);
  await page.waitForURL((u) => steps.test(u.pathname + u.search) || edit.test(u.pathname), { timeout });
  const u = new URL(page.url());
  if (edit.test(u.pathname)) return "editor";
  return u.searchParams.get("step") === "6" ? 6 : 7;
}

/** The editor of a book (a new book's step 6 opens it by itself when the storybook job is done). */
export const editorUrl = (bookId: string) => new RegExp(`/books/${bookId}/edit$`);

/**
 * Wait until the first run finished: the editor opened by itself (Task 8 storybook flow — the normal
 * case) or, for a book made by the old album flow, step 7 (Preview) is ready to generate. Finishes
 * Story + Design first when still needed. Returns which one it reached.
 */
export async function waitForReview(page: Page, bookId: string, timeout = 420_000): Promise<"editor" | 7> {
  await finishBookSetup(page, undefined, timeout);
  const edit = editorUrl(bookId);
  const step7 = wizardStepUrl(bookId, "7");
  await page.waitForURL((u) => edit.test(u.pathname) || step7.test(u.pathname + u.search), { timeout });
  if (edit.test(new URL(page.url()).pathname)) {
    await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
    return "editor";
  }
  await expectWizardStep(page, 7, 60_000);
  await expect(page.getByTestId("wizard-generate")).toBeEnabled({ timeout: 60_000 });
  return 7;
}

/**
 * → editor. On step 7 (old album flow): "Generate album" (confirmAlbumAction redirects; soft
 * navigation). Already in the editor (Task 8: step 6 opened it): only waits for the editor shell.
 * `press` = tap-counting wrapper.
 */
export async function generateAlbum(
  page: Page,
  bookId: string,
  opts: { press?: WizardOptions["press"]; timeout?: number } = {},
): Promise<void> {
  if (!editorUrl(bookId).test(new URL(page.url()).pathname)) {
    const btn = page.getByTestId("wizard-generate");
    await expect(btn).toBeEnabled({ timeout: 60_000 });
    if (opts.press) await opts.press(btn, "Generate album (step 7)");
    else await btn.click();
  }
  await page.waitForURL(editorUrl(bookId), { timeout: opts.timeout ?? 120_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
}

/** Photos picked on step 3 → story → design → step 6 (storybook job) → editor (the whole first run). */
export async function finishWizardToEditor(page: Page, bookId: string, opts: { timeout?: number } = {}): Promise<void> {
  await waitForReview(page, bookId, opts.timeout ?? 420_000);
  await generateAlbum(page, bookId);
}

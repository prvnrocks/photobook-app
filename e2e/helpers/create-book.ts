/**
 * Shared e2e helper: walk the book creation wizard on /books/new (M19 D-071, M20 D-072 — one
 * continuous 7-step wizard). Steps: 1 title (book-title) → 2 purpose (occasion-* labels; NO caption-
 * language control since M20 — the server derives it: Arabic-script title → memory →
 * Accept-Language → en) → 3 shape (format-* labels) → 4 style (style-* labels) → create-book. The
 * create stays on the same document: /books/new?book=<id>&step=5 (photos), then step 6 (sorting,
 * ?step=6) and step 7 (review, ?step=7) render in place; "Generate album" (wizard-generate) is the
 * one navigation, to /books/<id>/edit.
 *
 * The occasion / format / style testids sit on the card <label>; the native radio is inside it.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type WizardOccasion = "wedding" | "travel" | "baby" | "graduation" | "family" | "other";
export type WizardFormat = "A5_PORTRAIT" | "A5_LANDSCAPE";
export type WizardStyle = "modern" | "classic" | "geometric" | "scrapbook";

export type WizardOptions = {
  /** Typed on step 1; "" / undefined = leave blank (allowed). */
  title?: string;
  occasion?: WizardOccasion;
  format?: WizardFormat;
  /** Click this style on step 4; undefined = keep the occasion's default. */
  style?: WizardStyle;
  /** Assert this style is selected on step 4 before continuing (e.g. the occasion default). */
  expectStyle?: WizardStyle;
  /** Navigate to /books/new first (default true). false = the page is already on step 1. */
  goto?: boolean;
  /** Optional tap/click wrapper (tap-counting specs). Receives the target + a label. */
  press?: (target: Locator, label: string) => Promise<void>;
  /** Called with the step number when each of steps 1–4 is on screen (screenshots / audits). */
  onStep?: (step: 1 | 2 | 3 | 4) => Promise<void>;
  /** Called on steps 1–4 after the choices are made, just before Continue (screenshots). */
  beforeContinue?: (step: 1 | 2 | 3 | 4) => Promise<void>;
};

/** Step 5 in the continuous wizard: /books/new?book=<id>&step=5 (no navigation since step 1). */
export const WIZARD_STEP5_URL = /\/books\/new\?book=([0-9a-f-]{36})&step=5$/;
/** Step 6 (sorting) or 7 (review) of a book — a fast replay run may skip past 6 before we look. */
export const wizardStepUrl = (bookId: string, steps = "[67]") => new RegExp(`/books/new\\?book=${bookId}&step=${steps}$`);
export const WIZARD_TOTAL = 7;

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

/** Step-1 → 4 Continue (not the step-4 create button). */
export async function wizardContinue(page: Page, from: 1 | 2 | 3, opts: WizardOptions = {}): Promise<void> {
  await pressOn(opts, page.getByTestId("wizard-continue"), `Continue (step ${from})`);
  await expectWizardStep(page, (from + 1) as 2 | 3 | 4);
}

/** Steps 1–3 of the wizard (stops on step 4, nothing submitted). */
export async function walkWizardToStyle(page: Page, opts: WizardOptions = {}): Promise<void> {
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
  await wizardContinue(page, 2, opts);

  await opts.onStep?.(3);
  const format = opts.format ?? "A5_PORTRAIT";
  await pressOn(opts, page.getByTestId(`format-${format}`), `Shape: ${format}`);
  await expect(cardRadio(page, `format-${format}`)).toBeChecked();
  await opts.beforeContinue?.(3);
  await wizardContinue(page, 3, opts);

  await opts.onStep?.(4);
  if (opts.style) {
    await pressOn(opts, page.getByTestId(`style-${opts.style}`), `Style: ${opts.style}`);
    await expect(cardRadio(page, `style-${opts.style}`)).toBeChecked();
  }
  if (opts.expectStyle) await expect(cardRadio(page, `style-${opts.expectStyle}`)).toBeChecked();
  await opts.beforeContinue?.(4);
}

/**
 * Walk all four wizard steps and create the book. Returns the new book id (the page stays on
 * /books/new — now ?book=<id>&step=5 — with the upload picker of step 5 ready).
 */
export async function createBookViaWizard(page: Page, opts: WizardOptions = {}): Promise<string> {
  await walkWizardToStyle(page, opts);
  await pressOn(opts, page.getByTestId("create-book"), "Continue (step 4: create)");
  await page.waitForURL(WIZARD_STEP5_URL, { timeout: 30_000 });
  await expectWizardStep(page, 5, 30_000);
  await expect(page.getByTestId("upload-pick")).toBeVisible({ timeout: 30_000 });
  const u = new URL(page.url());
  return WIZARD_STEP5_URL.exec(u.pathname + u.search)![1];
}

/** After photos were picked on step 5: wait until the wizard is on step 6 (sorting) or already 7. */
export async function waitForSortingOrReview(page: Page, bookId: string, timeout = 240_000): Promise<6 | 7> {
  await page.waitForURL(wizardStepUrl(bookId), { timeout });
  return new URL(page.url()).searchParams.get("step") === "6" ? 6 : 7;
}

/** Wait for step 7 (Review) to be ready to generate (the run finished). */
export async function waitForReview(page: Page, bookId: string, timeout = 420_000): Promise<void> {
  await page.waitForURL(wizardStepUrl(bookId, "7"), { timeout });
  await expectWizardStep(page, 7, 60_000);
  await expect(page.getByTestId("wizard-generate")).toBeEnabled({ timeout: 60_000 });
}

/**
 * Step 7 → editor: "Generate album" (confirmAlbumAction redirects; soft navigation) and wait for the
 * editor shell. `press` = tap-counting wrapper.
 */
export async function generateAlbum(
  page: Page,
  bookId: string,
  opts: { press?: WizardOptions["press"]; timeout?: number } = {},
): Promise<void> {
  const btn = page.getByTestId("wizard-generate");
  await expect(btn).toBeEnabled({ timeout: 60_000 });
  if (opts.press) await opts.press(btn, "Generate album (step 7)");
  else await btn.click();
  await page.waitForURL(new RegExp(`/books/${bookId}/edit$`), { timeout: opts.timeout ?? 120_000 });
  await expect(page.getByTestId("editor-shell")).toBeVisible({ timeout: 60_000 });
}

/** Photos picked on step 5 → sorting → review → Generate album → editor (the whole first run). */
export async function finishWizardToEditor(page: Page, bookId: string, opts: { timeout?: number } = {}): Promise<void> {
  await waitForReview(page, bookId, opts.timeout ?? 420_000);
  await generateAlbum(page, bookId);
}

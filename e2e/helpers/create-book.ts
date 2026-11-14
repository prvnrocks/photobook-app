/**
 * Shared e2e helper: walk the M19 book creation wizard (D-071) on /books/new and land on step 5
 * (/books/<id>/upload). Steps: 1 title (book-title) → 2 occasion (occasion-* labels; lang-en/lang-ar)
 * → 3 shape (format-* labels) → 4 style (style-* labels) → create-book.
 *
 * The occasion / format / style testids sit on the card <label>; the native radio is inside it.
 * The caption-language testids sit on the radio itself.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type WizardOccasion = "wedding" | "travel" | "baby" | "graduation" | "family" | "other";
export type WizardFormat = "A5_PORTRAIT" | "A5_LANDSCAPE";
export type WizardStyle = "modern" | "classic" | "geometric" | "scrapbook";

export type WizardOptions = {
  /** Typed on step 1; "" / undefined = leave blank (allowed). */
  title?: string;
  occasion?: WizardOccasion;
  /** Caption language switch on step 2; undefined = keep the suggested default. */
  lang?: "en" | "ar";
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

const UUID_UPLOAD = /\/books\/([0-9a-f-]{36})\/upload$/;

/** The native radio inside a card label testid. */
export function cardRadio(page: Page, testId: string): Locator {
  return page.getByTestId(testId).locator('input[type="radio"]');
}

export async function expectWizardStep(page: Page, step: 1 | 2 | 3 | 4, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId("new-book-wizard")).toHaveAttribute("data-step", String(step), { timeout });
  await expect(page.getByTestId("wizard-step-label")).toHaveText(`Step ${step} of 6`, { timeout });
}

/**
 * Wait until the wizard island is hydrated: typing into the title updates the cover art preview
 * (client state). A probe character is typed and removed so the real title starts clean.
 */
export async function waitForWizardHydrated(page: Page): Promise<void> {
  const input = page.getByTestId("book-title");
  const cover = page.getByTestId("wizard-cover-title");
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
  if (opts.lang) {
    await pressOn(opts, page.getByTestId(`lang-${opts.lang}`), `Captions: ${opts.lang}`);
    await expect(page.getByTestId(`lang-${opts.lang}`)).toBeChecked();
  }
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
 * Walk all four wizard steps and create the book. Returns the new book id (the page is on
 * /books/<id>/upload, step 5).
 */
export async function createBookViaWizard(page: Page, opts: WizardOptions = {}): Promise<string> {
  await walkWizardToStyle(page, opts);
  await pressOn(opts, page.getByTestId("create-book"), "Continue (step 4: create)");
  await page.waitForURL(UUID_UPLOAD, { timeout: 30_000 });
  return UUID_UPLOAD.exec(new URL(page.url()).pathname)![1];
}

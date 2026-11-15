// The book creation wizard's steps (M19 T2 D-071; M20 T2 D-072): one continuous 7-step wizard on
// /books/new — 1 title → 2 purpose (occasion) → 3 shape → 4 style (the book is created on step-4
// Continue) → 5 photos → 6 sorting (first AI build) → 7 review. Each step has a short stepper name, a
// lucide icon id (mapped to components in WizardStepper, so this module stays icon-free) and a headline.
// Pure: only pure data modules (book options, design defaults) are imported — no zod, no React — so
// first-load client islands can use it. Tested in node (tests/m20-wizard-chrome.test.tsx).

import { BOOK_TITLE_MAX_CODE_POINTS, CAPTION_LANGS, OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { FORM_DESIGN_STYLES, FORM_FORMATS, type FormDesignStyle } from "@/lib/design/defaults";

/** Icon ids the stepper knows (WizardStepper maps each to a lucide-react icon). */
export type WizardStepIcon = "pen-line" | "heart" | "ratio" | "palette" | "images" | "sparkles" | "book-open-check";

export const WIZARD_STEPS = [
  { id: "title", name: "Title", icon: "pen-line", headline: "Give your book a title" },
  { id: "occasion", name: "Purpose", icon: "heart", headline: "What's this book for?" },
  { id: "shape", name: "Shape", icon: "ratio", headline: "Choose a page shape" },
  { id: "style", name: "Style", icon: "palette", headline: "Choose a book style" },
  { id: "photos", name: "Photos", icon: "images", headline: "Add your photos" },
  { id: "sorting", name: "Sorting", icon: "sparkles", headline: "Sorting your photos" },
  { id: "review", name: "Review", icon: "book-open-check", headline: "Review your book" },
] as const satisfies readonly { id: string; name: string; icon: WizardStepIcon; headline: string }[];

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];
/** 1-based step number shown to people ("Step 3 of 7"). */
export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** The steps before the book exists (answers held in the client draft). */
export type WizardFormStep = 1 | 2 | 3 | 4;

export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;
export const WIZARD_FORM_STEP_COUNT = 4;

/** Every step number, in order (for steppers and loops). */
export const WIZARD_STEP_NUMBERS: readonly WizardStep[] = [1, 2, 3, 4, 5, 6, 7];

export function isWizardStep(v: unknown): v is WizardStep {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= WIZARD_STEP_COUNT;
}

export function isWizardFormStep(step: WizardStep): step is WizardFormStep {
  return step <= WIZARD_FORM_STEP_COUNT;
}

export function wizardHeadline(step: WizardStep): string {
  return WIZARD_STEPS[step - 1].headline;
}

export function wizardStepId(step: WizardStep): WizardStepId {
  return WIZARD_STEPS[step - 1].id;
}

/** The short stepper name ("Purpose"). */
export function wizardStepName(step: WizardStep): string {
  return WIZARD_STEPS[step - 1].name;
}

export function wizardStepIcon(step: WizardStep): WizardStepIcon {
  return WIZARD_STEPS[step - 1].icon;
}

/** "Step 3 of 7" */
export function wizardStepLabel(step: WizardStep): string {
  return `Step ${step} of ${WIZARD_STEP_COUNT}`;
}

/**
 * The /books/new `?step=` param → 1..7. Accepts what Next gives searchParams (string, string[],
 * undefined) or anything else; only an exact "1"–"7" (first value of an array) counts, else 1.
 * Steps 5–7 only make sense with ?book= — the page / flow decides what to do with them.
 */
export function parseStep(raw: unknown): WizardStep {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (isWizardStep(v)) return v;
  if (typeof v === "string" && /^[1-7]$/.test(v)) return Number(v) as WizardStep;
  return 1;
}

/** parseStep limited to the form steps (the M19 /books/new contract): anything but "1"–"4" → 1. */
export function parseFormStep(raw: unknown): WizardFormStep {
  const step = parseStep(raw);
  return isWizardFormStep(step) ? step : 1;
}

export type WizardFormat = (typeof FORM_FORMATS)[number];

/** What steps 1–4 collect. Unanswered choices are null; the title is "" until typed. */
export type WizardDraft = {
  title: string;
  occasion: Occasion | null;
  /** Not asked by a step (memory / default); carried so the create action gets it. */
  captionLang: CaptionLang | null;
  format: WizardFormat | null;
  designStyle: FormDesignStyle | null;
};

export const EMPTY_WIZARD_DRAFT: WizardDraft = {
  title: "",
  occasion: null,
  captionLang: null,
  format: null,
  designStyle: null,
};

const codePoints = (s: string) => Array.from(s).length;

/** False when the string holds a lone UTF-16 surrogate (Postgres jsonb rejects those). */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** A usable title: non-blank after trimming and within the DB limit (code points, like char_length). */
export function isValidWizardTitle(title: string): boolean {
  const t = title.trim();
  return t.length > 0 && codePoints(t) <= BOOK_TITLE_MAX_CODE_POINTS && isWellFormed(t);
}

/**
 * A title step 1 can continue with: empty / blank is allowed (the AI or rule draft suggests one,
 * M19 T3), otherwise within the DB limit after trimming and well-formed.
 */
export function isAcceptableWizardTitle(title: string): boolean {
  return title.trim() === "" || isValidWizardTitle(title);
}

/**
 * The first step whose answer is missing, or null when steps 1–4 are all answered. An empty title is
 * an answer (step 1 allows it); only an over-long / malformed one sends the user back to step 1.
 */
export function firstMissingStep(draft: WizardDraft): WizardFormStep | null {
  if (!isAcceptableWizardTitle(draft.title)) return 1;
  if (draft.occasion === null) return 2;
  if (draft.format === null) return 3;
  if (draft.designStyle === null) return 4;
  return null;
}

/**
 * Steps 1–4 of an existing draft (the /books/new edit mode): step-5 Back, and where browser Back from
 * step 5 lands after the wizard created the book (M19 BUG-2). Lives here (not in wizard-routes, which
 * re-exports it) so the first-load wizard island doesn't pull the book schema.
 */
export function wizardBackHref(bookId: string): string {
  return `/books/new?book=${encodeURIComponent(bookId)}&step=4`;
}

// ---- sessionStorage draft -------------------------------------------------------------------------

export const WIZARD_DRAFT_VERSION = 1;
export const WIZARD_DRAFT_STORAGE_KEY = "photobook:new-book-draft";

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

function nullableEnum<T extends string>(list: readonly T[], v: unknown): T | null | undefined {
  if (v === null) return null;
  return isOneOf(list, v) ? v : undefined; // undefined = invalid
}

export function serializeWizardDraft(draft: WizardDraft): string {
  return JSON.stringify({
    v: WIZARD_DRAFT_VERSION,
    title: draft.title,
    occasion: draft.occasion,
    captionLang: draft.captionLang,
    format: draft.format,
    designStyle: draft.designStyle,
  });
}

/**
 * Reads a stored draft. Anything unexpected (bad JSON, another version, an unknown enum value, an
 * over-long or malformed title, missing fields) → null, and the wizard starts fresh.
 */
export function parseWizardDraft(raw: string | null | undefined): WizardDraft | null {
  if (typeof raw !== "string" || raw === "") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (o.v !== WIZARD_DRAFT_VERSION) return null;
  if (typeof o.title !== "string" || codePoints(o.title) > BOOK_TITLE_MAX_CODE_POINTS || !isWellFormed(o.title)) {
    return null;
  }
  const occasion = nullableEnum(OCCASIONS, o.occasion);
  const captionLang = nullableEnum(CAPTION_LANGS, o.captionLang);
  const format = nullableEnum(FORM_FORMATS, o.format);
  const designStyle = nullableEnum(FORM_DESIGN_STYLES, o.designStyle);
  if (occasion === undefined || captionLang === undefined || format === undefined || designStyle === undefined) {
    return null;
  }
  return { title: o.title, occasion, captionLang, format, designStyle };
}

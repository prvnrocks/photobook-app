// The book creation wizard's steps (M19 T2, D-071): /books/new steps 1–4 (title → occasion → shape →
// style; the book is created on step-4 Continue), step 5 = first-run upload, step 6 = first-run build.
// Pure: only pure data modules (book options, design defaults) are imported, so client islands can use
// it without pulling server code. Tested in node (tests/m19-wizard-chrome.test.tsx).

import { BOOK_TITLE_MAX_CODE_POINTS, CAPTION_LANGS, OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { FORM_DESIGN_STYLES, FORM_FORMATS, type FormDesignStyle } from "@/lib/design/defaults";

export const WIZARD_STEPS = [
  { id: "title", headline: "Give your book a title" },
  { id: "occasion", headline: "What's this book for?" },
  { id: "shape", headline: "Choose a page shape" },
  { id: "style", headline: "Choose a book style" },
  { id: "photos", headline: "Add your photos" },
  { id: "sorting", headline: "Sorting your photos" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];
/** 1-based step number shown to people ("Step 3 of 6"). */
export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
/** The steps that live on /books/new (before the book exists). */
export type WizardFormStep = 1 | 2 | 3 | 4;

export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;
export const WIZARD_FORM_STEP_COUNT = 4;

export function wizardHeadline(step: WizardStep): string {
  return WIZARD_STEPS[step - 1].headline;
}

export function wizardStepId(step: WizardStep): WizardStepId {
  return WIZARD_STEPS[step - 1].id;
}

/** "Step 3 of 6" */
export function wizardStepLabel(step: WizardStep): string {
  return `Step ${step} of ${WIZARD_STEP_COUNT}`;
}

/**
 * The /books/new `?step=` param → 1..4. Accepts what Next gives searchParams (string, string[],
 * undefined) or anything else; only an exact "1"–"4" (first value of an array) counts, else 1.
 */
export function parseStep(raw: unknown): WizardFormStep {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4) return v as WizardFormStep;
  if (typeof v === "string" && /^[1-4]$/.test(v)) return Number(v) as WizardFormStep;
  return 1;
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

/** A step can be shown once every earlier step is answered (deep links to later steps bounce back). */
export function canEnter(step: WizardFormStep, draft: WizardDraft): boolean {
  const missing = firstMissingStep(draft);
  return missing === null || step <= missing;
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

// "What makes this memory special?" — the wizard's optional story step (Task 5, reshaped in v3
// 2026-11-19). Pure data, client-safe.
//
// Three short, optional fields: the occasion (prefilled from step 2, editable), who is in the
// photos to the user (free text + tap-to-fill chips) and one short personal memory. Answers are
// the USER's words: they are stored in the memory context with source "user"
// (src/lib/storybook/schemas.ts); a skipped question stores nothing and nothing is ever prefilled
// except the occasion the user already picked (which is stored only when they change it).
// Nothing here asks for or suggests anything sensitive (health, religion, money, exact address,
// full names, ages …). Question ids are stable: stored answers refer to them; Task 5 answers are
// mapped onto the v3 questions (LEGACY_QUESTION_MAP) so they still load.

import { OCCASION_LABELS, type Occasion } from "@/lib/book/options";

export const STORY_TONES = ["heartfelt", "joyful", "elegant"] as const;
export type StoryTone = (typeof STORY_TONES)[number];

export const STORY_TONE_LABELS: Record<StoryTone, string> = {
  heartfelt: "Heartfelt & personal",
  joyful: "Joyful & playful",
  elegant: "Elegant & timeless",
};

/** Max answer length in Unicode code points (what Postgres char_length counts). */
export const STORY_ANSWER_MAX = 200;
/** Never more than this many questions on the step (v3: occasion, relationship, one memory). */
export const STORY_QUESTIONS_MAX = 3;
/** Max chip length (characters). */
export const STORY_SUGGESTION_MAX = 30;

/** v3 question kinds of "What makes this memory special?". */
export const MEMORY_QUESTION_KINDS = ["occasion", "relationship", "moment"] as const;
export type MemoryQuestionKind = (typeof MEMORY_QUESTION_KINDS)[number];

export type StoryQuestion = {
  /** Stable id, `memory.<kind>` (v3) or a legacy `<occasion>.<topic>` id in stored answers. */
  id: string;
  kind: MemoryQuestionKind;
  prompt: string;
  /** A hint under the label (plain words, never an answer). */
  hint: string;
  placeholder: string;
  /** Short tap-to-fill chips (none for the occasion: it is prefilled from step 2 instead). */
  suggestions: string[];
};

export const MEMORY_QUESTION_IDS: Record<MemoryQuestionKind, string> = {
  occasion: "memory.occasion",
  relationship: "memory.relationship",
  moment: "memory.moment",
};

const QUESTIONS: readonly StoryQuestion[] = [
  {
    id: MEMORY_QUESTION_IDS.occasion,
    kind: "occasion",
    prompt: "What was the occasion?",
    hint: "From the start of this book — change it in your own words if you like.",
    placeholder: "e.g. A weekend trip",
    suggestions: [],
  },
  {
    id: MEMORY_QUESTION_IDS.relationship,
    kind: "relationship",
    prompt: "Who is in these photos, to you?",
    hint: "We only use what you write here — we never guess who people are.",
    placeholder: "e.g. My brother and me",
    suggestions: ["My brother", "My sister", "My partner", "Friends", "Family"],
  },
  {
    id: MEMORY_QUESTION_IDS.moment,
    kind: "moment",
    prompt: "One short memory from that time",
    hint: "A sentence is enough.",
    placeholder: "e.g. The first coffee we had together in ages",
    suggestions: [],
  },
];

/**
 * The questions of "What makes this memory special?" (v3: the same three for every occasion;
 * the occasion field is prefilled from step 2 by the step, see occasionPrefill).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for callers: the questions no longer vary by occasion (v3)
export function storyQuestionsFor(_occasion: Occasion | null): StoryQuestion[] {
  return QUESTIONS.slice(0, STORY_QUESTIONS_MAX).map((q) => ({ ...q, suggestions: [...q.suggestions] }));
}

/** The occasion field's starting text: the occasion picked in step 2 ("Travel"), "" for none / Other. */
export function occasionPrefill(occasion: Occasion | null): string {
  return occasion && occasion !== "other" ? OCCASION_LABELS[occasion] : "";
}

/**
 * Task 5 answers (two questions per occasion) → the v3 questions, so stored answers still load:
 * who-questions → relationship, what-it-was-about questions → occasion, what-made-it-special
 * questions → the short memory. The text is the user's own, unchanged.
 */
export const LEGACY_QUESTION_MAP: Readonly<Record<string, string>> = {
  "wedding.occasion": MEMORY_QUESTION_IDS.occasion,
  "wedding.moments": MEMORY_QUESTION_IDS.moment,
  "travel.companions": MEMORY_QUESTION_IDS.relationship,
  "travel.special": MEMORY_QUESTION_IDS.moment,
  "baby.milestone": MEMORY_QUESTION_IDS.occasion,
  "baby.firsts": MEMORY_QUESTION_IDS.moment,
  "birthday.person": MEMORY_QUESTION_IDS.relationship,
  "birthday.highlights": MEMORY_QUESTION_IDS.moment,
  "graduation.graduate": MEMORY_QUESTION_IDS.relationship,
  "graduation.proud": MEMORY_QUESTION_IDS.moment,
  "family.people": MEMORY_QUESTION_IDS.relationship,
  "family.special": MEMORY_QUESTION_IDS.moment,
  "other.about": MEMORY_QUESTION_IDS.occasion,
  "other.special": MEMORY_QUESTION_IDS.moment,
};

/** Stored answers under the v3 ids: a v3 answer wins over a legacy one for the same question. */
export function migrateStoryAnswers<T extends { questionId: string; text: string }>(answers: readonly T[]): (T & { questionId: string })[] {
  const out = new Map<string, T>();
  for (const a of answers) if (Object.values(MEMORY_QUESTION_IDS).includes(a.questionId)) out.set(a.questionId, a);
  for (const a of answers) {
    const to = LEGACY_QUESTION_MAP[a.questionId];
    if (to && !out.has(to)) out.set(to, { ...a, questionId: to });
  }
  return QUESTIONS.map((q) => out.get(q.id)).filter((a): a is T => !!a);
}

export function isStoryTone(value: unknown): value is StoryTone {
  return typeof value === "string" && (STORY_TONES as readonly string[]).includes(value);
}

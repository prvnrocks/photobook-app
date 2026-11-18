// "Every memory has a story." — the wizard's optional story step (Task 5). Pure data, client-safe.
//
// At most two short questions per occasion, each with tap-to-fill chips so nobody has to type a
// long description. Answers are the USER's words: they are stored in the memory context with
// source "user" (src/lib/storybook/schemas.ts) and a skipped question stores nothing.
// Nothing here asks for or suggests anything sensitive (health, religion, money, exact address,
// full names, ages …). Question ids are stable: stored answers refer to them.

import type { Occasion } from "@/lib/book/options";

export const STORY_TONES = ["heartfelt", "joyful", "elegant"] as const;
export type StoryTone = (typeof STORY_TONES)[number];

export const STORY_TONE_LABELS: Record<StoryTone, string> = {
  heartfelt: "Heartfelt & personal",
  joyful: "Joyful & playful",
  elegant: "Elegant & timeless",
};

/** Max answer length in Unicode code points (what Postgres char_length counts). */
export const STORY_ANSWER_MAX = 200;
/** Never more than this many questions on the step. */
export const STORY_QUESTIONS_MAX = 2;
/** Max chip length (characters). */
export const STORY_SUGGESTION_MAX = 30;

export type StoryQuestion = {
  /** Stable id, `<occasion>.<topic>`, e.g. "travel.companions". */
  id: string;
  prompt: string;
  placeholder: string;
  /** 3–5 short tap-to-fill chips. */
  suggestions: string[];
};

const QUESTIONS: Record<Occasion, readonly StoryQuestion[]> = {
  wedding: [
    {
      id: "wedding.occasion",
      prompt: "Whose day was it, and what kind of celebration?",
      placeholder: "e.g. Our wedding by the sea",
      suggestions: ["Our wedding day", "Our engagement party", "My sister's wedding", "A friend's wedding", "Our anniversary"],
    },
    {
      id: "wedding.moments",
      prompt: "Which moments mattered most?",
      placeholder: "e.g. The first dance",
      suggestions: ["The vows", "The first dance", "Getting ready together", "The speeches", "Dancing all night"],
    },
  ],
  travel: [
    {
      id: "travel.companions",
      prompt: "Who did you travel with?",
      placeholder: "e.g. My two best friends",
      suggestions: ["My partner", "My family", "My friends", "Just me", "The whole team"],
    },
    {
      id: "travel.special",
      prompt: "What made this trip special?",
      placeholder: "e.g. Our first time in the mountains",
      suggestions: ["Our first trip together", "The food", "The views", "Time to slow down", "A dream come true"],
    },
  ],
  baby: [
    {
      id: "baby.milestone",
      prompt: "Which milestone is this book about?",
      placeholder: "e.g. The first year",
      suggestions: ["The first days", "The first month", "The first year", "Coming home", "Meeting the family"],
    },
    {
      id: "baby.firsts",
      prompt: "Any firsts you want to remember?",
      placeholder: "e.g. The first laugh",
      suggestions: ["First smile", "First laugh", "First steps", "First word", "First trip out"],
    },
  ],
  birthday: [
    {
      id: "birthday.person",
      prompt: "Whose birthday was it?",
      placeholder: "e.g. My mum's",
      suggestions: ["Mine", "My child's", "My partner's", "My mum's", "A close friend's"],
    },
    {
      id: "birthday.highlights",
      prompt: "What made the day special?",
      placeholder: "e.g. Everyone came",
      suggestions: ["A surprise party", "The cake", "Everyone together", "Games and laughter", "A quiet dinner"],
    },
  ],
  graduation: [
    {
      id: "graduation.graduate",
      prompt: "Who graduated?",
      placeholder: "e.g. My younger brother",
      suggestions: ["I did", "My child", "My sister", "My brother", "My best friend"],
    },
    {
      id: "graduation.proud",
      prompt: "What should the book remember about the day?",
      placeholder: "e.g. The cap toss",
      suggestions: ["Walking the stage", "The cap toss", "Proud family", "Friends for life", "Years of hard work"],
    },
  ],
  family: [
    {
      id: "family.people",
      prompt: "Who is in this book?",
      placeholder: "e.g. Three generations of us",
      suggestions: ["The whole family", "The kids", "Grandparents and kids", "Cousins together", "Just the two of us"],
    },
    {
      id: "family.special",
      prompt: "What do you want to remember about this time?",
      placeholder: "e.g. Fridays at grandma's",
      suggestions: ["Everyday moments", "A family gathering", "A holiday together", "Weekends at home", "Growing up fast"],
    },
  ],
  other: [
    {
      id: "other.about",
      prompt: "What is this book about?",
      placeholder: "e.g. A year of little moments",
      suggestions: ["A special day", "A year in photos", "Time with friends", "A place we love", "A gift for someone"],
    },
    {
      id: "other.special",
      prompt: "What made it special?",
      placeholder: "e.g. We were all together",
      suggestions: ["The people", "The place", "The little moments", "Being together", "A new beginning"],
    },
  ],
};

/** The (at most two) questions for an occasion. No / unknown occasion → the "Other" questions. */
export function storyQuestionsFor(occasion: Occasion | null): StoryQuestion[] {
  const list = (occasion && QUESTIONS[occasion]) || QUESTIONS.other;
  return list.slice(0, STORY_QUESTIONS_MAX).map((q) => ({ ...q, suggestions: [...q.suggestions] }));
}

export function isStoryTone(value: unknown): value is StoryTone {
  return typeof value === "string" && (STORY_TONES as readonly string[]).includes(value);
}

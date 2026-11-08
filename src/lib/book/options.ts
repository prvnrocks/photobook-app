// Book options shown in the "new book" flow and passed to the AI pipeline (M3).
// Pure data — safe to import from client components.

export const OCCASIONS = ["wedding", "travel", "baby", "graduation", "family", "other"] as const;
export type Occasion = (typeof OCCASIONS)[number];

export const OCCASION_LABELS: Record<Occasion, string> = {
  wedding: "Wedding",
  travel: "Travel",
  baby: "Baby",
  graduation: "Graduation",
  family: "Family",
  other: "Other",
};

export const TONES = ["romantic", "fun", "nostalgic", "minimal"] as const;
export type Tone = (typeof TONES)[number];

export const TONE_LABELS: Record<Tone, string> = {
  romantic: "Romantic",
  fun: "Fun",
  nostalgic: "Nostalgic",
  minimal: "Minimal",
};

export const DEFAULT_TONE: Record<Occasion, Tone> = {
  wedding: "romantic",
  travel: "fun",
  baby: "nostalgic",
  graduation: "fun",
  family: "nostalgic",
  other: "minimal",
};

export const CAPTION_LANGS = ["en", "ar"] as const;
export type CaptionLang = (typeof CAPTION_LANGS)[number];

export const CAPTION_LANG_LABELS: Record<CaptionLang, string> = {
  en: "English",
  ar: "العربية",
};

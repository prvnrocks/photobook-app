// The cover title of a book without a user title, per occasion (the rule album and the AI plan
// fallback use it — src/lib/autolayout.ts re-exports it). A light module: client UI (setup card)
// names the same default without bundling the layout engine.
import type { Occasion } from "@/lib/book/options";

export const DEFAULT_TITLES: Record<Occasion, string> = {
  wedding: "Our Wedding",
  travel: "Our Travels",
  baby: "Our Little One",
  graduation: "Graduation Day",
  family: "Family Moments",
  other: "Our Photobook",
};

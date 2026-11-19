// Story v4: the small "CHAPTER ONE" label over a chapter story page's title. Generated from the
// chapter's position in doc.chapters at render time — never stored, never written by the AI — so
// it stays right when chapters are added, removed or reordered. Pure, client-safe.

const EN = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN", "TWENTY"] as const;
const AR = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"] as const;

/** "CHAPTER ONE" (English) / "الفصل الأول" (Arabic) for the chapter at `index` (0-based); digits past the word list. */
export function chapterLabel(index: number, lang: string | null | undefined): string {
  if (!Number.isInteger(index) || index < 0) return "";
  if (lang === "ar") return `الفصل ${AR[index] ?? String(index + 1)}`;
  return `CHAPTER ${EN[index] ?? String(index + 1)}`;
}

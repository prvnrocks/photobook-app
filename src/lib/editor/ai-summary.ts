// Editor "AI kept X of Y · See left out" chip (M13 T7, D-070 (3)): the review screen folded into
// the editor as a secondary screen. Pure: counts come from the photos' kept/dropped status (the
// same status the review grid shows); nothing about photo content is used.

export type AiSummary = {
  /** "AI kept 34 of 40" (AI album) or "34 of 40 in your book" (rule album — no AI claim; review wording). */
  label: string;
  /** "See 6 left out", or "See all photos" when nothing was left out. */
  linkText: string;
  kept: number;
  total: number;
};

/**
 * The chip model, or null when there is no curation to report: an AI album (`generator` from
 * doc.meta; absent meta = rule album) always gets one; a rule album only when it left photos out
 * (otherwise there is nothing to see). No photos → null.
 */
export function aiSummary(
  generator: "ai" | "rule" | null | undefined,
  photos: readonly { status: "kept" | "dropped" }[],
): AiSummary | null {
  const total = photos.length;
  if (total === 0) return null;
  const kept = photos.filter((p) => p.status === "kept").length;
  const left = total - kept;
  const ai = generator === "ai";
  if (!ai && left === 0) return null;
  return {
    label: ai ? `AI kept ${kept} of ${total}` : `${kept} of ${total} in your book`,
    linkText: left > 0 ? `See ${left} left out` : "See all photos",
    kept,
    total,
  };
}

/** localStorage key: the chip stays hidden for this book once dismissed (per browser). */
export function aiSummaryDismissKey(bookId: string): string {
  return `pb.aiSummaryChip.dismissed.${bookId}`;
}

// Dismissal storage. localStorage can be unavailable (Safari private mode, blocked storage, in-app
// browsers): every access is guarded; without storage a dismiss still holds for this page session.
export type ChipStorage = Pick<Storage, "getItem" | "setItem">;

const memoryDismissed = new Set<string>();
const listeners = new Set<() => void>();

function storage(): ChipStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True once the chip was dismissed for this book. Never throws. */
export function aiSummaryDismissed(bookId: string, store: ChipStorage | null = storage()): boolean {
  if (memoryDismissed.has(bookId)) return true;
  try {
    return store?.getItem(aiSummaryDismissKey(bookId)) === "1";
  } catch {
    return false;
  }
}

/** Hide the chip for this book and notify subscribers. Never throws. */
export function dismissAiSummary(bookId: string, store: ChipStorage | null = storage()): void {
  memoryDismissed.add(bookId);
  try {
    store?.setItem(aiSummaryDismissKey(bookId), "1");
  } catch {
    // Storage full / blocked: the in-memory flag still hides it for this page session.
  }
  for (const l of listeners) l();
}

export function subscribeAiSummary(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Tests only: forget in-memory dismissals. */
export function resetAiSummaryMemoryForTests(): void {
  memoryDismissed.clear();
}

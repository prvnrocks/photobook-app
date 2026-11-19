// The editor's Story actions (Task 8) — the pure part, tested in node: what is selected, which
// actions apply, chapter ranges, and the HTTP calls for "Rewrite story" / the regenerated doc.
//   Rewrite story    the selected page text (needs a blockRef: AI-written story text, or the user's
//                    edit of one) → POST /api/books/[id]/story-rewrite
//   Change photo     the selected photo → the existing Replace panel (replaceSlotPhoto re-lays the
//                    page out when the new photo no longer fits)
//   Regenerate page  the current page, when it is a storybook template page → regeneratePageLayout
//   View chapters    doc.chapters with their page ranges
// Client-safe: no React, no server imports.

import type { BookDoc, PageText } from "@/lib/book/types";
import type { EditorPosition, EditorSelection, EditorState } from "@/lib/editor/store";
import { getPageTemplate } from "@/lib/layouts/templates";
import { isUuid } from "@/lib/uuid";

export const REWRITE_OPTIONS = [
  { kind: "shorter", label: "Shorter" },
  { kind: "longer", label: "Longer" },
  { kind: "simpler", label: "Simpler" },
  { kind: "regenerate", label: "Write it again" },
] as const;
export const TONE_OPTIONS = [
  { tone: "heartfelt", label: "Heartfelt" },
  { tone: "joyful", label: "Joyful" },
  { tone: "elegant", label: "Elegant" },
] as const;
export type RewriteChoice = { kind: (typeof REWRITE_OPTIONS)[number]["kind"] } | { kind: "tone"; tone: (typeof TONE_OPTIONS)[number]["tone"] };

/** The selected storybook page text that "Rewrite story" can work on (it needs a blockRef). */
export function selectedStoryText(state: Pick<EditorState, "doc" | "selection">): { pageIdx: number; panel: number; text: PageText } | null {
  const sel = state.selection;
  if (sel?.kind !== "text") return null;
  const text = state.doc.pages[sel.pageIdx]?.texts?.find((t) => t.panel === sel.panel);
  return text && text.blockRef ? { pageIdx: sel.pageIdx, panel: sel.panel, text } : null;
}

/** The selected photo slot on a page ("Change photo"). */
export function selectedSlot(selection: EditorSelection): { pageIdx: number; slotIdx: number } | null {
  return selection?.kind === "slot" ? { pageIdx: selection.pageIdx, slotIdx: selection.slotIdx } : null;
}

/** The page "Regenerate page" works on: the one shown, when it is a storybook template page (a spread → its left half). */
export function regeneratablePage(doc: BookDoc, page: EditorPosition): number | null {
  if (page === "cover" || !doc.meta?.story) return null;
  let idx = page;
  if (doc.pages[idx]?.side === "right") idx -= 1;
  const p = doc.pages[idx];
  return p && getPageTemplate(p.layout) ? idx : null;
}

export type ChapterRange = { id: string; title: string; from: number; to: number; firstIdx: number };

/** Chapters with their 1-based page ranges (chapters without pages are left out). */
export function chapterRanges(doc: BookDoc): ChapterRange[] {
  const out: ChapterRange[] = [];
  for (const c of doc.chapters) {
    const idxs = doc.pages.map((p, i) => (p.chapterId === c.id ? i : -1)).filter((i) => i >= 0);
    if (idxs.length === 0) continue;
    out.push({ id: c.id, title: c.title, from: idxs[0]! + 1, to: idxs[idxs.length - 1]! + 1, firstIdx: idxs[0]! });
  }
  return out;
}

// ---------------------------------------------------------------------------- HTTP

export type RewriteOutcome =
  | { kind: "ok"; text: string; lang: "en" | "ar"; proposal: boolean }
  | { kind: "error"; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (i, init) => fetch(i, init);

const REWRITE_ERRORS: Record<string, string> = {
  not_found: "This text isn't part of the story any more. Tap another text.",
  conflict: "The story changed meanwhile. Try again.",
  ungrounded: "We couldn't write a version that sticks to your photos. Try another option.",
  invalid_instruction: "That option isn't available for this text.",
  limit_reached: "You've used this book's story rewrites.",
  budget_exhausted: "AI is taking a break — try again later.",
  ai_unavailable: "AI isn't available right now. Try again later.",
};

export async function requestStoryRewrite(
  bookId: string,
  input: { blockRef: string; text: string; source: "ai" | "user"; choice: RewriteChoice },
  fetchImpl: FetchLike = defaultFetch,
): Promise<RewriteOutcome> {
  if (!isUuid(bookId)) return { kind: "error", message: REWRITE_ERRORS.not_found! };
  let res: Response;
  try {
    res = await fetchImpl(`/api/books/${bookId}/story-rewrite`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockRef: input.blockRef, text: input.text.slice(0, 2000), source: input.source, kind: input.choice.kind, ...(input.choice.kind === "tone" ? { tone: input.choice.tone } : {}) }),
    });
  } catch {
    return { kind: "error", message: "We couldn't reach the server. Check your connection and try again." };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (res.ok && body && typeof body.text === "string" && body.text.trim() !== "") {
    return { kind: "ok", text: body.text, lang: body.lang === "ar" ? "ar" : "en", proposal: body.proposal === true };
  }
  if (res.status === 401) return { kind: "error", message: "You've been signed out. Sign in again to continue." };
  const code = typeof body?.error === "string" ? body.error : "";
  return { kind: "error", message: REWRITE_ERRORS[code] ?? "Something went wrong. Try again." };
}

/** The doc + rev the server holds now (after "Regenerate story"). */
export async function fetchStoryDoc(bookId: string, fetchImpl: FetchLike = defaultFetch): Promise<{ doc: BookDoc; rev: number } | null> {
  if (!isUuid(bookId)) return null;
  try {
    const res = await fetchImpl(`/api/books/${bookId}/story-doc`, { method: "GET", credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { doc?: unknown; rev?: unknown };
    if (!body || typeof body.rev !== "number" || !body.doc || typeof body.doc !== "object") return null;
    return { doc: body.doc as BookDoc, rev: body.rev };
  } catch {
    return null;
  }
}

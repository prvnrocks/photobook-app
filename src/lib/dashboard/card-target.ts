// Where a dashboard book card leads (M5 Task 12). Pure: safe on client and server, tested in node.
//
// Rules, in order:
// 1. An AI build/rebuild is running (books.ai_status analyzing/planning/captioning) → build page
//    (its progress screen resumes the run) — same as the editor's own redirect.
// 2. No album yet (page_count 0): no upload-finished photos → upload; photos → build
//    (= the upload page's "Continue" and editorRedirect in src/lib/editor/page-data.ts).
// 3. Album built and edited by the user (editor save sets doc.meta.userEdited) → editor.
// 4. Album built, never edited → review, so the keep/drop step isn't skipped. Review "Continue"
//    then opens the editor. There is no persisted "confirmed" marker, so a book confirmed on review
//    but not yet edited still opens review (one tap to the editor).

export const RUNNING_AI_STATUSES = ["analyzing", "planning", "captioning"] as const;

export interface BookCardState {
  id: string;
  page_count: number;
  /** Upload-finished photos (upload_state = 'ready'). */
  photo_count: number;
  ai_status: string | null;
  /** doc.meta.userEdited === true. */
  user_edited: boolean;
}

export type BookCardStep = "upload" | "build" | "review" | "edit";

export function bookCardStep(b: Omit<BookCardState, "id">): BookCardStep {
  if ((RUNNING_AI_STATUSES as readonly string[]).includes(b.ai_status ?? "")) return "build";
  if (!(b.page_count > 0)) return b.photo_count > 0 ? "build" : "upload";
  return b.user_edited ? "edit" : "review";
}

export function bookCardHref(b: BookCardState): string {
  return `/books/${b.id}/${bookCardStep(b)}`;
}

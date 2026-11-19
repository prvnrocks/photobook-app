// Where a dashboard book card leads (M5 Task 12). Pure: safe on client and server, tested in node.
//
// Rules, in order:
// 1. An AI build/rebuild is running (books.ai_status analyzing/planning/captioning) → build page
//    (its progress screen resumes the run) — same as the editor's own redirect.
// 2. No album yet (page_count 0): no upload-finished photos → upload; photos → build
//    (= the upload page's "Continue" and editorRedirect in src/lib/editor/page-data.ts).
// 3. Book built (AI or rule album, edited or not) → editor (M13, D-070: build goes straight to the
//    editor; review stays reachable from the editor's "AI kept X of Y" chip).
// M20 T9 (D-072): the href of a fresh draft goes straight into the wizard (one hop instead of the
// upload/build page's redirect): "upload" → /books/new?book=<id>&step=3 (Photos; Task 5 order), "build" with no run going
// → step 6 (the wizard's gate moves it on: finished run → 7; AI off stays in the wizard, M20b).
// Task 5: a draft album with no run yet, unedited and unconfirmed → the wizard (step 5), see bookCardHref.
// M20c: a confirmed book ("Generate album" ran) never gets a wizard href — Open → the editor.
// A running build/rebuild keeps /books/<id>/build: only that page can tell a rebuild (classic) from
// a first build (it redirects the latter into the wizard).

export const RUNNING_AI_STATUSES = ["analyzing", "planning", "captioning"] as const;

export interface BookCardState {
  id: string;
  page_count: number;
  /** Upload-finished photos (upload_state = 'ready'). */
  photo_count: number;
  ai_status: string | null;
  /** doc.meta.userEdited === true (no longer changes the card target since M13 / D-070). */
  user_edited: boolean;
  /**
   * books.album_confirmed_at is set (M20c: "Generate album" ran). Never a wizard href: Open → the
   * editor (which itself redirects a running build to /build or an empty album to the classic pages).
   */
  album_confirmed?: boolean;
  /** Task 8 follow-up: the storybook composer made the pages (doc.meta.story) → a finished book, editor. */
  storybook?: boolean;
}

export type BookCardStep = "upload" | "build" | "edit";

export function bookCardStep(b: Omit<BookCardState, "id">): BookCardStep {
  if ((RUNNING_AI_STATUSES as readonly string[]).includes(b.ai_status ?? "")) return "build";
  if (!(b.page_count > 0)) return b.photo_count > 0 ? "build" : "upload";
  return "edit";
}

/** Same URL as wizardStepHref in src/lib/books/wizard-routes.ts (kept here: this module stays dependency-free). */
const wizardHref = (id: string, step: 3 | 5 | 6) => `/books/new?book=${encodeURIComponent(id)}&step=${step}`;

export function bookCardHref(b: BookCardState): string {
  const step = bookCardStep(b);
  if (b.album_confirmed === true && step !== "edit" && !(RUNNING_AI_STATUSES as readonly string[]).includes(b.ai_status ?? "")) {
    return `/books/${b.id}/edit`;
  }
  if (step === "upload") return wizardHref(b.id, 3);
  // Task 5: photos are uploaded before Story / Design, and finalize writes a rule draft right after
  // upload — so a draft album with NO AI run yet (ai_status idle), not edited and not confirmed, is a
  // book the user left mid-wizard. Open → back into the wizard (step 5; the server gate moves it to the
  // right step), not the editor: one edit there would lock the book out of its first AI build.
  if (step === "edit" && b.album_confirmed !== true && b.storybook !== true && !b.user_edited && (b.ai_status ?? "idle") === "idle") {
    return wizardHref(b.id, 5);
  }
  if (step === "build" && !(RUNNING_AI_STATUSES as readonly string[]).includes(b.ai_status ?? "")) {
    return wizardHref(b.id, 6);
  }
  return `/books/${b.id}/${step}`;
}

// Server page → client shell mapping for /books/[id]/edit (pure; tested in node).
// Type-only import of the loader's shape: no server code is pulled in.

import type { EditorData } from "@/lib/db/editor";
import { freeLinkState } from "@/lib/publish/free-link";
import { albumEditedByUser } from "@/lib/review/ui";
import { wizardStepHref } from "@/lib/books/wizard-routes";
import { editorAiPath } from "./ai-path";
import type { EditorShellData } from "./types";

/**
 * Where the editor must send the user instead of opening:
 * - an AI build/rebuild is running → its progress page (only /build can tell a rebuild, which stays
 *   classic, from a first build, which it redirects into the wizard — same as the dashboard card);
 * - no album yet and never built (fresh book, M20 D-072) → straight into the wizard, one hop:
 *   no photos → step 3 (Photos), photos uploaded → step 6 (the wizard's gate moves it on; AI off too, M20b);
 * - no album yet otherwise (a build ran before, or the album was confirmed — M20c: a confirmed book
 *   never enters the wizard, whose gate would send it straight back here) → the classic upload /
 *   build pages.
 * null = open the editor (or the invalid-doc state).
 */
export function editorRedirect(
  data: Pick<EditorData, "book" | "activeBuildRunId" | "docError" | "photos" | "hasBuildRun" | "aiMode"> &
    Partial<Pick<EditorData, "albumConfirmed">>,
): string | null {
  const id = data.book.id;
  if (data.activeBuildRunId) return `/books/${id}/build`;
  if (data.docError !== "empty") return null;
  const classic = data.hasBuildRun || data.albumConfirmed === true;
  if (data.photos.length === 0) return classic ? `/books/${id}/upload` : wizardStepHref(id, 3);
  return classic ? `/books/${id}/build` : wizardStepHref(id, 6);
}

/**
 * Serializable props for <EditorShell>, or null when there is no usable doc. `now` fixes the free
 * link's days left on the server (no client clock → no hydration mismatch).
 */
export function toEditorShellData(data: EditorData, now: Date = new Date()): EditorShellData | null {
  if (!data.doc) return null;
  return {
    book: data.book,
    doc: data.doc,
    docRev: data.docRev,
    publishedRev: data.publishedRev,
    ...(data.book.isPaid ? {} : { freeLink: freeLinkState(data.expiresAt, now) }),
    canSave: data.canSave,
    aiMode: data.aiMode,
    aiPath: editorAiPath({
      aiMode: data.aiMode,
      generator: data.doc.meta?.generator ?? "rule",
      userEdited: albumEditedByUser(data.doc),
      hasBuildRun: data.hasBuildRun,
      storybook: !!data.doc.meta?.story || (data.latestStoryRun ?? null) !== null,
    }),
    rewritesUsed: data.rewritesUsed,
    rewritesLeft: data.rewritesLeft,
    ...(data.latestStoryRun ? { story: { latest: data.latestStoryRun } } : {}),
    photos: data.photos.map((p) => ({
      id: p.id,
      status: p.status,
      userOverride: p.userOverride,
      width: p.width,
      height: p.height,
      webUrl: p.webUrl,
      thumbUrl: p.thumbUrl,
    })),
  };
}

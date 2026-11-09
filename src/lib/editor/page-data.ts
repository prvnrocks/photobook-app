// Server page → client shell mapping for /books/[id]/edit (pure; tested in node).
// Type-only import of the loader's shape: no server code is pulled in.

import type { EditorData } from "@/lib/db/editor";
import type { EditorShellData } from "./types";

/**
 * Where the editor must send the user instead of opening:
 * - an AI build/rebuild is running → its progress page;
 * - no album yet → upload (no photos) or build (photos uploaded; same as the upload page's
 *   "Continue" in UploadSummary).
 * null = open the editor (or the invalid-doc state).
 */
export function editorRedirect(data: Pick<EditorData, "book" | "activeBuildRunId" | "docError" | "photos">): string | null {
  const id = data.book.id;
  if (data.activeBuildRunId) return `/books/${id}/build`;
  if (data.docError === "empty") return data.photos.length === 0 ? `/books/${id}/upload` : `/books/${id}/build`;
  return null;
}

/** Serializable props for <EditorShell>, or null when there is no usable doc. */
export function toEditorShellData(data: EditorData): EditorShellData | null {
  if (!data.doc) return null;
  return {
    book: data.book,
    doc: data.doc,
    docRev: data.docRev,
    canSave: data.canSave,
    aiMode: data.aiMode,
    rewritesUsed: data.rewritesUsed,
    rewritesLeft: data.rewritesLeft,
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

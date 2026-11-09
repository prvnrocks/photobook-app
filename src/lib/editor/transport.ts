// Browser side of the editor routes: PUT /api/books/[id]/doc and POST /api/books/[id]/photo-urls.
// Every response maps to a typed outcome; nothing throws. Only the doc and photo ids travel;
// nothing is logged.

import type { BookDoc } from "@/lib/book/types";
import { canUseKeepalive, classifySaveResponse, type SaveOutcome } from "./autosave";
import type { FreshPhotoUrls } from "./photo-urls";

export interface EditorTransport {
  save(doc: BookDoc, baseRev: number, opts: { keepalive: boolean }): Promise<SaveOutcome>;
  photoUrls(ids: string[]): Promise<FreshPhotoUrls[] | null>;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function httpEditorTransport(bookId: string): EditorTransport {
  const base = `/api/books/${encodeURIComponent(bookId)}`;
  return {
    async save(doc, baseRev, opts) {
      const body = JSON.stringify({ doc, baseRev });
      const bytes = new TextEncoder().encode(body).length;
      try {
        const res = await fetch(`${base}/doc`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
          credentials: "same-origin",
          cache: "no-store",
          keepalive: opts.keepalive && canUseKeepalive(bytes),
        });
        return classifySaveResponse(res.status, await readJson(res));
      } catch {
        return classifySaveResponse(null, null);
      }
    },
    async photoUrls(ids) {
      try {
        const res = await fetch(`${base}/photo-urls`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) return null;
        const json = (await readJson(res)) as { photos?: unknown } | null;
        if (!json || !Array.isArray(json.photos)) return null;
        return json.photos.filter(
          (p): p is FreshPhotoUrls =>
            !!p && typeof p === "object" && typeof (p as FreshPhotoUrls).id === "string",
        );
      } catch {
        return null;
      }
    },
  };
}

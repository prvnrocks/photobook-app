// Browser side of the editor routes: PUT /api/books/[id]/doc and POST /api/books/[id]/photo-urls.
// Every response maps to a typed outcome; nothing throws. Only the doc and photo ids travel;
// nothing is logged.

import type { BookDoc } from "@/lib/book/types";
import { canUseKeepalive, classifySaveResponse, type SaveOutcome } from "./autosave";
import { DEFAULT_RETRY_LATER_MS, type FreshPhotoUrls, type PhotoUrlsResult } from "./photo-urls";

export interface EditorTransport {
  save(doc: BookDoc, baseRev: number, opts: { keepalive: boolean }): Promise<SaveOutcome>;
  /** null = failed; { retryAfterMs } = 503, ask again later (old URLs stay). */
  photoUrls(ids: string[]): Promise<PhotoUrlsResult>;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Retry-After delta seconds → ms; missing / unparsable → DEFAULT_RETRY_LATER_MS. */
function retryAfterMs(header: string | null): number {
  const raw = header?.trim();
  return raw && /^\d+(\.\d+)?$/.test(raw) ? Math.ceil(Number(raw) * 1000) : DEFAULT_RETRY_LATER_MS;
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
        if (res.status === 503) return { retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
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

// Fixture data + stub transport for the dev-only /dev-editor route (404 in production).
// No user data: placeholder SVG photos from src/lib/book/dev-preview.ts.

import { DEV_BG_PHOTO_UUID, devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
import { serializeDoc } from "@/lib/book/doc-version";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import type { SaveOutcome } from "./autosave";
import type { EditorTransport } from "./transport";
import type { EditorShellData } from "./types";

export type DevSaveMode = "ok" | "conflict" | "unavailable" | "offline" | "invalid" | "readonly";

export const DEV_SAVE_MODES: readonly DevSaveMode[] = ["ok", "conflict", "unavailable", "offline", "invalid", "readonly"];

/** `?ai=` on /dev-editor: AI off (default), on (replay; the rewrite call itself is real or mocked), or no rewrites left. */
export type DevAiMode = "off" | "replay" | "limit";

export const DEV_AI_MODES: readonly DevAiMode[] = ["off", "replay", "limit"];

export function devEditorData(mode: DevSaveMode, ai: DevAiMode = "off"): EditorShellData {
  const doc = devPreviewDoc();
  const photos = devPreviewPhotos();
  return {
    book: {
      id: "00000000-0000-4000-8000-000000000000",
      title: doc.cover.title,
      occasion: "wedding",
      tone: "romantic",
      captionLang: "en",
      isPaid: false,
      maxPages: 20,
    },
    doc,
    docRev: mode === "readonly" ? null : 1,
    publishedRev: null,
    canSave: mode !== "readonly",
    aiMode: ai === "off" ? "off" : "replay",
    rewritesUsed: ai === "limit" ? 20 : 0,
    rewritesLeft: ai === "limit" ? 0 : 20,
    photos: Object.entries(photos).map(([id, p]) => ({
      id,
      // d14/d15 = AI-dropped (photo picker "Dropped by AI" tab); d13 = kept but unused.
      status: id === "d14" || id === "d15" ? ("dropped" as const) : ("kept" as const),
      userOverride: false,
      width: p?.width ?? null,
      height: p?.height ?? null,
      webUrl: p?.url ?? null,
      thumbUrl: p?.url ?? null,
    })),
  };
}

/** uuid of a second AI-dropped fixture photo (alias of d14's image), for `?bg=1`. */
export const DEV_DROPPED_BG_PHOTO_UUID = "00000000-0000-4000-8000-0000000000f4";

/**
 * `?bg=1` (M10a A8): photo backgrounds need uuid photo ids (schema), the d* fixture ids aren't —
 * add two uuid photos: DEV_BG_PHOTO_UUID (kept, d15's image) and DEV_DROPPED_BG_PHOTO_UUID
 * (AI-dropped, d14's image). Not placed in the doc.
 */
export function withDevBackgroundPhotos(data: EditorShellData): EditorShellData {
  const byId = new Map(data.photos.map((p) => [p.id, p]));
  const alias = (id: string, of: string, status: "kept" | "dropped") => {
    const src = byId.get(of);
    return src ? [{ ...src, id, status }] : [];
  };
  return {
    ...data,
    photos: [...data.photos, ...alias(DEV_BG_PHOTO_UUID, "d15", "kept"), ...alias(DEV_DROPPED_BG_PHOTO_UUID, "d14", "dropped")],
  };
}

/** What the last stub save would have stored (dev-only, read by e2e as window.__devEditorLastSave). */
export interface DevLastSave {
  rev: number;
  /** serializeDoc(validated doc) — the JSON the real route writes to books.doc. */
  stored: unknown;
}

export interface DevTransportOptions {
  /**
   * Run the real save validator (validateEditorDoc, as PUT /api/books/[id]/doc does) on every
   * "ok" save; a rejection becomes the route's 422 outcome. Photo ids = the fixture's photos.
   */
  validate?: { photoIds: ReadonlySet<string>; maxPages: number; savedDoc: unknown };
}

/** Stub save: ~400 ms, then the outcome for `mode` (ok bumps the rev). */
export function devTransport(mode: DevSaveMode, opts: DevTransportOptions = {}): EditorTransport {
  let rev = 1;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async save(doc): Promise<SaveOutcome> {
      await wait(400);
      switch (mode) {
        case "conflict":
          return { kind: "conflict" };
        case "unavailable":
          return { kind: "unavailable" };
        case "offline":
          return { kind: "retry", reason: "network" };
        case "invalid":
          return { kind: "invalid", code: "page_limit" };
        default: {
          if (opts.validate) {
            const r = validateEditorDoc(doc, opts.validate);
            if (!r.ok) return { kind: "invalid", code: r.code };
            rev += 1;
            const last: DevLastSave = { rev, stored: serializeDoc(r.doc) };
            (globalThis as { __devEditorLastSave?: DevLastSave }).__devEditorLastSave = last;
            return { kind: "ok", rev, savedAt: new Date().toISOString() };
          }
          rev += 1;
          return { kind: "ok", rev, savedAt: new Date().toISOString() };
        }
      }
    },
    async photoUrls() {
      return [];
    },
  };
}

// Fixture data + stub transport for the dev-only /dev-editor route (404 in production).
// No user data: placeholder SVG photos from src/lib/book/dev-preview.ts.

import { devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
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

/** Stub save: ~400 ms, then the outcome for `mode` (ok bumps the rev). */
export function devTransport(mode: DevSaveMode): EditorTransport {
  let rev = 1;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async save(): Promise<SaveOutcome> {
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
        default:
          rev += 1;
          return { kind: "ok", rev, savedAt: new Date().toISOString() };
      }
    },
    async photoUrls() {
      return [];
    },
  };
}

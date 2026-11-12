// Props the editor page passes to the client shell. Re-declared here (mirrors EditorData in
// src/lib/db/editor.ts) so client components never import server modules; the page maps one to
// the other and tsc checks the shapes line up.

import type { BookDoc } from "@/lib/book/types";
import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import type { FreeLinkState } from "@/lib/publish/free-link";
import type { EditorAiPath } from "./ai-path";

/** Mirrors AiMode in src/lib/ai/client.ts (server-only). */
export type EditorAiMode = "off" | "replay" | "live";

export type EditorShellPhoto = {
  id: string;
  status: "kept" | "dropped";
  userOverride: boolean;
  /** ORIGINAL pixel size (for low-res checks), null if unknown. */
  width: number | null;
  height: number | null;
  /** Signed ≤1600px web image; refreshed on load errors. */
  webUrl: string | null;
  /** Signed 512px thumb. */
  thumbUrl: string | null;
};

export type EditorShellBook = {
  id: string;
  title: string | null;
  occasion: Occasion;
  tone: Tone;
  captionLang: CaptionLang;
  isPaid: boolean;
  maxPages: number;
};

export type EditorShellData = {
  book: EditorShellBook;
  doc: BookDoc;
  /** null = saving not available (migration 0900 missing) → read-only. */
  docRev: number | null;
  /** doc_rev of the live published snapshot; null = not published. */
  publishedRev: number | null;
  /** Unpaid books: where the free link stands (D-039) for the Share button. Absent = never published. */
  freeLink?: FreeLinkState;
  canSave: boolean;
  aiMode: EditorAiMode;
  /** "Make it with AI" chip / "Redo with AI" entry (src/lib/editor/ai-path.ts). Absent = neither. */
  aiPath?: EditorAiPath;
  rewritesUsed: number;
  rewritesLeft: number;
  photos: EditorShellPhoto[];
};

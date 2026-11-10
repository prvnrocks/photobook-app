"use client";

// Everything editor UI pieces (toolbar tools, panels, carousel overlays) need, from one context.
// Tasks 9–11: read it with useEditor() inside your Panel / overlay, or use the `ctx` your tool's
// run()/Panel receives (same object).

import { createContext, useContext } from "react";
import type { EditorState } from "@/lib/editor/store";
import type { AiSessionBlock } from "@/lib/editor/caption-tools";
import type { EditorShellBook, EditorAiMode } from "@/lib/editor/types";
import type { SaveState } from "./useAutosave";
import type { EditorActions } from "./useEditorStore";
import type { EditorPhotos } from "./usePhotoUrls";

export interface EditorContextValue {
  book: EditorShellBook;
  /** isPaymentsEnabled() from the server page (Stripe keys configured); absent = false. */
  paymentsEnabled?: boolean;
  state: EditorState;
  actions: EditorActions;
  /** All upload-finished photos of the book (kept + dropped) with fresh URLs + RenderPhotos maps. */
  photos: EditorPhotos;
  /** state.readOnly (no saving / conflict / signed out). Tools that edit must not run. */
  readOnly: boolean;
  save: {
    status: SaveState;
    flush(): void;
    /** Send pending saves and wait for them (useAutosave().settle) — e.g. before a PDF export. */
    settle?(): Promise<SaveState>;
  };
  ai: {
    mode: EditorAiMode;
    rewritesUsed: number;
    rewritesLeft: number;
    /** Task 10: update after a successful ✨ rewrite (the server's 429 stays authoritative). */
    setRewrites(used: number, left: number): void;
    /** ✨ switched off for the rest of this session by a server answer (503 / daily limit…). */
    blocked?: AiSessionBlock | null;
    blockSession?(kind: AiSessionBlock): void;
  };
  /**
   * Facing-pages editing (≥ md, M10a A9): the carousel shows open spreads and state.page is the
   * page last tapped inside the shown spread. Absent = false (single page).
   */
  spread?: boolean;
  /** Id of the tool whose Panel is open, or null. */
  activeTool: string | null;
  openTool(id: string): void;
  closeTool(): void;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside <EditorShell>");
  return ctx;
}

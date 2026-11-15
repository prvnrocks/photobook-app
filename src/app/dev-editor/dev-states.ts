// Named fixture states for /dev-editor screenshots (M22 T7): `?state=<name>` on top of the other
// query params. Dev-only route (404 in production). Pure: no React, no server modules.

import type { DevSaveMode } from "@/lib/editor/dev-fixture";
import { aiSummary, type AiSummary } from "@/lib/editor/ai-summary";
import type { EditorShellData } from "@/lib/editor/types";

export const DEV_EDITOR_STATES = ["readOnly", "conflict", "makeWithAi", "aiSummary", "linkExpired", "paid"] as const;

export type DevEditorState = (typeof DEV_EDITOR_STATES)[number];

export function parseDevEditorState(v: unknown): DevEditorState | null {
  return (DEV_EDITOR_STATES as readonly string[]).includes(String(v)) ? (v as DevEditorState) : null;
}

/** Save mode a state needs (readOnly → no saving; conflict → the stub save answers 409), else the given one. */
export function devStateSaveMode(state: DevEditorState | null, mode: DevSaveMode): DevSaveMode {
  if (state === "readOnly") return "readonly";
  if (state === "conflict") return "conflict";
  return mode;
}

/**
 * Applies a state to fixture data:
 * - makeWithAi: rule album that never had an AI build → the persistent "Make it with AI" chip;
 * - aiSummary: the "AI kept X of Y · See N left out" chip (fixture has 2 AI-dropped photos);
 * - linkExpired: published free book whose 30-day link has run out → Share shows "Link expired";
 * - paid: paid book (100 pages, PDF instead of Upgrade).
 * readOnly / conflict only change the save mode (devStateSaveMode); conflict shows its banner after
 * the first save, which DevEditorClient triggers with one harmless edit.
 */
export function withDevEditorState(data: EditorShellData, state: DevEditorState | null): { data: EditorShellData; summary: AiSummary | null } {
  switch (state) {
    case "makeWithAi":
      return { data: { ...data, aiMode: "replay", aiPath: { makeWithAi: true, redoWithAi: false } }, summary: null };
    case "aiSummary":
      return { data, summary: aiSummary("ai", data.photos) };
    case "linkExpired":
      return { data: { ...data, publishedRev: data.docRev, freeLink: { kind: "expired" } }, summary: null };
    case "paid":
      return { data: { ...data, book: { ...data.book, isPaid: true, maxPages: 100 } }, summary: null };
    default:
      return { data, summary: null };
  }
}

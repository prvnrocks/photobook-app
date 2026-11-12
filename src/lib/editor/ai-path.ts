// The editor's way back to the AI (M13 review fix, D-070 (3)). Pure + tested in node.
// Books that never got an AI build (auto start skipped: < 5 photos, a limit, an error) open in the
// editor with the rule album; without this they'd lose the AI path. The review screen still decides
// what is actually allowed (D-028 / D-037: rebuild counts, edited albums) — these flags only decide
// which entry points the editor shows.

import type { Generator } from "@/lib/book/types";
import type { EditorAiMode } from "./types";

export type EditorAiPath = {
  /** Persistent "Make it with AI" chip → /books/[id]/build (manual start, normal caps). */
  makeWithAi: boolean;
  /** "Redo with AI" entry in the editor's More sheet → the review screen (its rebuild button). */
  redoWithAi: boolean;
};

export const NO_AI_PATH: EditorAiPath = { makeWithAi: false, redoWithAi: false };

/**
 * - AI off (D-024) or the album has user edits (D-037 #2: AI runs can't overwrite it) → neither;
 * - rule album and no build run ever → "Make it with AI";
 * - otherwise (an AI album, or a run that fell back / failed) → "Redo with AI" (review decides
 *   between Redo / Try AI again and shows the rebuilds left).
 */
export function editorAiPath(input: {
  aiMode: EditorAiMode;
  generator: Generator | null | undefined;
  userEdited: boolean;
  hasBuildRun: boolean;
}): EditorAiPath {
  if (input.aiMode === "off" || input.userEdited) return NO_AI_PATH;
  if (input.generator !== "ai" && !input.hasBuildRun) return { makeWithAi: true, redoWithAi: false };
  return { makeWithAi: false, redoWithAi: true };
}

/**
 * During the session: any edit (undo history) will be saved as a user edit, after which AI runs are
 * refused (D-037 #2) — hide both entries then; also in read-only mode.
 */
export function sessionAiPath(initial: EditorAiPath | undefined, opts: { edited: boolean; readOnly: boolean }): EditorAiPath {
  if (!initial || opts.edited || opts.readOnly) return NO_AI_PATH;
  return initial;
}

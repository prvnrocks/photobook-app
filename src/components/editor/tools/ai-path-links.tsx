// Page-level More entries that leave the editor (M13 review fix): the review screen must never
// depend on the dismissible "AI kept X of Y" chip.
// - "See all photos" → /books/[id]/review (always, nothing selected; works read-only too).
// - "Redo with AI" → the same review screen, whose rebuild button decides what's allowed
//   (D-028 / D-037: rebuilds left, edited albums). Only while ctx.aiPath.redoWithAi.

import { Images, Sparkles } from "lucide-react";
import type { EditorTool } from "./types";

export const SEE_PHOTOS_TOOL_ID = "see-photos";
export const REDO_AI_TOOL_ID = "redo-ai";

function reviewHref(bookId: string): string {
  return `/books/${bookId}/review`;
}

export const seePhotosTool: EditorTool = {
  id: SEE_PHOTOS_TOOL_ID,
  label: "See all photos",
  icon: Images,
  scopes: ["none"],
  order: 90,
  tier: "more",
  editsDoc: false,
  href: (ctx) => reviewHref(ctx.book.id),
};

export const redoAiTool: EditorTool = {
  id: REDO_AI_TOOL_ID,
  label: "Redo with AI",
  icon: Sparkles,
  scopes: ["none"],
  order: 91,
  tier: "more",
  isAvailable: (ctx) => ctx.aiPath?.redoWithAi === true,
  href: (ctx) => reviewHref(ctx.book.id),
};

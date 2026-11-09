"use client";

// "Add page" toolbar button (M5 Task 11): inserts an empty page after the current one (from the
// cover: before page 1) and jumps to it. At the book's page limit a free book opens the Upgrade
// sheet instead — page 21 is never created; the server's 422 page_limit stays the real guard.

import { FilePlus2 } from "lucide-react";
import { addPage } from "@/lib/book/edit-ops";
import { addPageDecision } from "@/lib/editor/pages";
import type { EditorContextValue } from "../editor-context";
import { openUpgrade } from "../UpgradeSheet";
import type { EditorTool } from "./types";

/** Run the Add page action for `ctx` (exported for tests). */
export function runAddPage(ctx: Pick<EditorContextValue, "state" | "book" | "actions" | "readOnly" | "openTool">): void {
  if (ctx.readOnly) return;
  const decision = addPageDecision(ctx.state.doc, ctx.book, ctx.state.page);
  if (decision.kind === "upgrade") {
    openUpgrade(ctx);
    return;
  }
  if (decision.kind !== "add") return;
  const { afterIdx } = decision;
  const maxPages = ctx.book.maxPages;
  ctx.actions.edit((d) => addPage(d, afterIdx, undefined, maxPages), { select: null, goTo: afterIdx + 1 });
}

export const addPageTool: EditorTool = {
  id: "add-page",
  label: "Add page",
  icon: FilePlus2,
  scopes: "always",
  order: 75,
  // Paid book at 100 pages: nothing left to offer.
  isDisabled: (ctx) => addPageDecision(ctx.state.doc, ctx.book, ctx.state.page).kind === "full",
  run: runAddPage,
};

"use client";

// "Add page" toolbar button (M5 Task 11): inserts an empty page after the current one (from the
// cover: before page 1) and jumps to it. At the book's page limit a free book opens the Upgrade
// sheet instead — page 21 is never created; the server's 422 page_limit stays the real guard.
// Spreads (M10b A15, D-064): after a spread half the page goes after the whole spread; later
// spreads pushed onto a right page are split → toast with Undo. Navigation uses result.pageIdx.

import { FilePlus2 } from "lucide-react";
import { addPageResult, type PageOpResult } from "@/lib/book/edit-ops";
import { addPageDecision, splitNotice } from "@/lib/editor/pages";
import type { EditorContextValue } from "../editor-context";
import { showEditorToast } from "../EditorToast";
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
  const base = ctx.state.doc;
  let r: PageOpResult;
  try {
    r = addPageResult(base, afterIdx, undefined, maxPages);
  } catch {
    // Let the reducer record the error code (shown in the toolbar's error line).
    ctx.actions.edit((d) => addPageResult(d, afterIdx, undefined, maxPages).doc, { select: null });
    return;
  }
  ctx.actions.edit((d) => (d === base ? r.doc : addPageResult(d, afterIdx, undefined, maxPages).doc), {
    select: null,
    goTo: r.pageIdx,
  });
  const split = splitNotice(r.splitCount);
  if (split) showEditorToast({ message: split, action: { label: "Undo", run: ctx.actions.undo }, dismissOnEdit: true });
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

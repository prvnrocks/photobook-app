"use client";

// "Upgrade this book" sheet (M5 Task 11, D-037 #3): before M7 wires Stripe Checkout it only
// explains the paid tier and shows a disabled "Coming soon" button. It never changes the doc
// (editsDoc: false — also shown in read-only mode).
//
// Reuse:
// - Open it from any tool / panel: `openUpgrade(ctx)` (or ctx.openTool(UPGRADE_TOOL_ID)).
//   The tool stays visible while it is open, whatever the selection.
// - Or embed the body directly: <UpgradeSheet reason="rewrites" />.
// Paid status comes from the server (books.is_paid via the editor loader) — never set client-side.

import { Gem } from "lucide-react";
import { LIMITS } from "@/lib/ai/limits";
import { selectionKind } from "@/lib/editor/store";
import { UPGRADE } from "@/lib/pricing";
import type { EditorContextValue } from "./editor-context";
import type { EditorTool } from "./tools/types";

export const UPGRADE_TOOL_ID = "upgrade";

/** Price copy (CLAUDE.md: AED 39 one-time per book). M7 replaces the button with Stripe Checkout. */
export const UPGRADE_PRICE_LABEL = UPGRADE.label;

/** Why the sheet opened — picks the first line. */
export type UpgradeReason = "pages" | "rewrites" | "general";

export function upgradeReasonCopy(reason: UpgradeReason, freeMaxPages: number = LIMITS.free.maxPages): string | null {
  switch (reason) {
    case "pages":
      return `Free books have up to ${freeMaxPages} pages. This one is full.`;
    case "rewrites":
      return "You've used the free caption rewrites for this book.";
    default:
      return null;
  }
}

export function UpgradeSheet({ reason = "general" }: { reason?: UpgradeReason }) {
  const lead = upgradeReasonCopy(reason);
  return (
    <div className="flex flex-col gap-4" data-testid="upgrade-sheet">
      {lead ? (
        <p className="text-sm text-muted-foreground" data-testid="upgrade-reason">
          {lead}
        </p>
      ) : null}
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <Gem className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold">Upgrade this book</p>
          <p className="text-sm text-muted-foreground">One-time payment, just for this book.</p>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        <li>Up to {LIMITS.paid.maxPages} pages</li>
        <li>No watermark</li>
        <li>PDF download</li>
        <li>Permanent link</li>
      </ul>
      <p className="text-2xl font-semibold" data-testid="upgrade-price">
        {UPGRADE_PRICE_LABEL}
      </p>
      <button
        type="button"
        disabled
        aria-describedby="upgrade-soon"
        className="flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        data-testid="upgrade-button"
      >
        Upgrade · Coming soon
      </button>
      <p id="upgrade-soon" className="text-center text-xs text-muted-foreground">
        Payments are coming soon. Your book keeps its free features until then.
      </p>
    </div>
  );
}

function UpgradePanel({ ctx }: { ctx: EditorContextValue }) {
  const atLimit = ctx.state.doc.pages.length >= ctx.book.maxPages;
  return <UpgradeSheet reason={atLimit ? "pages" : "general"} />;
}

/** Toolbar entry: free books only; visible with nothing selected, and whenever it is open. */
export const upgradeTool: EditorTool = {
  id: UPGRADE_TOOL_ID,
  label: "Upgrade",
  icon: Gem,
  scopes: "always",
  order: 98,
  editsDoc: false,
  isAvailable: (ctx) =>
    !ctx.book.isPaid && (ctx.activeTool === UPGRADE_TOOL_ID || selectionKind(ctx.state.selection) === "none"),
  Panel: UpgradePanel,
  panelTitle: "Upgrade",
};

/** Open the Upgrade sheet from any tool or panel (no-op for paid books). */
export function openUpgrade(ctx: Pick<EditorContextValue, "book" | "openTool">): void {
  if (!ctx.book.isPaid) ctx.openTool(UPGRADE_TOOL_ID);
}

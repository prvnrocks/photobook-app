"use client";

// "Upgrade this book" sheet (M5 Task 11, D-037 #3; M7 T6): explains the paid tier and starts the
// AED 39 Stripe Checkout via <UpgradeButton> (disabled + "Payments unavailable" when the server
// has no Stripe keys). It never changes the doc (editsDoc: false — also shown in read-only mode).
//
// Reuse:
// - Open it from any tool / panel: `openUpgrade(ctx)` (or ctx.openTool(UPGRADE_TOOL_ID)).
//   The tool stays visible while it is open, whatever the selection.
// - Or embed the body directly: <UpgradeSheet reason="rewrites" ctx={ctx} />.
// Paid status comes from the server (books.is_paid via the editor loader) — never set client-side.
// M22 T5 (D-074): card styling in the share page's language — serif heading, ivory perks card, the
// Checkout button emerald solid (one gold per screen = Share). Hex/tokens only: no palette class
// names (tests assert none).

import { Check, Gem } from "lucide-react";
import { LIMITS } from "@/lib/ai/limits";
import { selectionKind } from "@/lib/editor/store";
import { UpgradeButton } from "@/components/upgrade/UpgradeButton";
import { UPGRADE } from "@/lib/pricing";
import { ED_CTA_EMERALD, ED_PANEL_HEADING } from "./editor-classes";
import type { EditorContextValue } from "./editor-context";
import type { EditorTool } from "./tools/types";

export const UPGRADE_TOOL_ID = "upgrade";

/** Price copy (CLAUDE.md: AED 39 one-time per book). */
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

export type UpgradeSheetCtx = Pick<EditorContextValue, "book" | "paymentsEnabled"> & {
  save?: Pick<EditorContextValue["save"], "flush">;
};

export function UpgradeSheet({ reason = "general", ctx }: { reason?: UpgradeReason; ctx: UpgradeSheetCtx }) {
  const lead = upgradeReasonCopy(reason);
  return (
    <div className="flex flex-col gap-4" data-testid="upgrade-sheet">
      {lead ? (
        <p className="text-sm text-muted-foreground" data-testid="upgrade-reason">
          {lead}
        </p>
      ) : null}
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#f6efdc] text-accent-text ring-1 ring-[#e9dfca]">
          <Gem className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className={ED_PANEL_HEADING}>Upgrade this book</p>
          <p className="text-sm text-muted-foreground">One-time payment, just for this book.</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2.5 rounded-2xl border border-[#e9dfca] bg-[#faf6ee] p-4 text-sm font-medium text-[#0e3b2e]">
        {[`Up to ${LIMITS.paid.maxPages} pages`, "No watermark", "PDF download", "Permanent link"].map((item) => (
          <li key={item} className="flex items-center gap-2">
            <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>
      <p className="font-display text-2xl font-semibold text-[#0e3b2e]" data-testid="upgrade-price">
        {UPGRADE_PRICE_LABEL}
      </p>
      {ctx.book.isPaid ? (
        <p className="text-sm font-medium text-success" data-testid="upgrade-already-paid">
          This book is already upgraded.
        </p>
      ) : (
        <UpgradeButton
          bookId={ctx.book.id}
          returnTo={`/books/${ctx.book.id}/edit`}
          isPaid={ctx.book.isPaid}
          paymentsEnabled={ctx.paymentsEnabled === true}
          onBeforeStart={ctx.save?.flush}
          testId="upgrade-button"
          className={`${ED_CTA_EMERALD} w-full text-center whitespace-normal`}
        />
      )}
    </div>
  );
}

function UpgradePanel({ ctx }: { ctx: EditorContextValue }) {
  const atLimit = ctx.state.doc.pages.length >= ctx.book.maxPages;
  return <UpgradeSheet reason={atLimit ? "pages" : "general"} ctx={ctx} />;
}

/** Toolbar entry: free books only; visible with nothing selected, and whenever it is open. */
export const upgradeTool: EditorTool = {
  id: UPGRADE_TOOL_ID,
  label: "Upgrade",
  icon: Gem,
  scopes: "always",
  order: 98,
  tier: "more",
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

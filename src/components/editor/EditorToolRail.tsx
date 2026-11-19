"use client";

// Desktop tool sidebar (≥ lg, ctx.sidebar): every tool for the current selection as a clearly
// labelled button in a rail on the right edge — no "More" sheet, nothing hidden. The open tool's
// panel (EditorPanelHost) sits between the page and this rail and stays until the user closes it.
// Phones and tablets keep the bottom pill bar (EditorToolbar). Same `editor-tool-<id>` testids.

import Link from "next/link";
import { selectionKind, type SelectionKind } from "@/lib/editor/store";
import { cx } from "@/lib/cx";
import { useEditor } from "./editor-context";
import type { EditorTool } from "./tools/types";

/** Rail width — EditorShell reserves the same width while the screen size is unknown. */
export const ED_RAIL_WIDTH = "w-24";
export const ED_RAIL_SURFACE = "border-l border-[#e5dccb] bg-[#f4ede0]";

const GROUP_LABEL: Record<SelectionKind, string> = { none: "Page", slot: "Photo", caption: "Caption", description: "Text", text: "Text", cover: "Cover" };

const ITEM =
  "relative flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 text-center text-xs leading-tight font-semibold outline-none transition-[background-color,color] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f4ede0] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const ITEM_IDLE = "text-[#0e3b2e] hover:bg-white";
const ITEM_ACTIVE = "bg-[#0e3b2e] text-[#f2e8d8] shadow-[0_6px_14px_-8px_rgb(14_59_46/0.9)]";
const HEADING = "px-1 pb-0.5 text-center text-[0.65rem] font-semibold tracking-[0.18em] text-[#56625a] uppercase";

export function EditorToolRail({ tools, className }: { tools: EditorTool[]; className?: string }) {
  const ctx = useEditor();
  const { activeTool } = ctx;
  const kind = selectionKind(ctx.state.selection);
  // Tools for what is selected first, then the ones that are always there (book-level).
  const forSelection = tools.filter((t) => t.scopes !== "always");
  const always = tools.filter((t) => t.scopes === "always");

  const onTool = (t: EditorTool) => {
    if (t.isDisabled?.(ctx)) return;
    t.run?.(ctx);
    if (t.Panel) {
      if (activeTool === t.id) ctx.closeTool();
      else ctx.openTool(t.id);
    }
  };

  const item = (t: EditorTool) => {
    const Icon = t.icon;
    const disabled = t.isDisabled?.(ctx) ?? false;
    const active = activeTool === t.id;
    const face = (
      <>
        <Icon className="size-6 shrink-0" aria-hidden="true" />
        <span className="max-w-full break-words">{t.label}</span>
      </>
    );
    return (
      <li key={t.id}>
        {t.href && !disabled ? (
          <Link href={t.href(ctx)} className={cx(ITEM, ITEM_IDLE)} data-testid={`editor-tool-${t.id}`}>
            {face}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => onTool(t)}
            disabled={disabled}
            aria-pressed={t.Panel ? active : undefined}
            className={cx(ITEM, active ? ITEM_ACTIVE : ITEM_IDLE)}
            data-active={active ? "true" : undefined}
            data-testid={`editor-tool-${t.id}`}
          >
            {face}
          </button>
        )}
      </li>
    );
  };

  return (
    <nav
      aria-label="Editing tools"
      className={cx("min-h-0 shrink-0 overflow-y-auto p-2", ED_RAIL_WIDTH, ED_RAIL_SURFACE, className)}
      data-testid="editor-tool-rail"
      data-count={tools.length}
    >
      {tools.length === 0 ? (
        <p className="px-1 py-3 text-center text-xs text-[#56625a]" data-testid="toolbar-hint">
          {ctx.readOnly ? "Read-only" : "No tools for this yet."}
        </p>
      ) : (
        <>
          {forSelection.length > 0 ? (
            <>
              <p className={cx(HEADING, "pt-1")} data-testid="editor-rail-group">
                {GROUP_LABEL[kind]}
              </p>
              <ul className="flex flex-col gap-1">{forSelection.map(item)}</ul>
            </>
          ) : null}
          {always.length > 0 ? (
            <>
              <p className={cx(HEADING, forSelection.length > 0 ? "mt-2 border-t border-[#e5dccb] pt-3" : "pt-1")}>Book</p>
              <ul className="flex flex-col gap-1">{always.map(item)}</ul>
            </>
          ) : null}
        </>
      )}
    </nav>
  );
}

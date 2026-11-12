"use client";

// "More" sheet of the simple editor toolbar (M13 T8): the tools that aren't big buttons in the row
// for the current selection (registry.splitTools), so every tool stays ≤ 2 taps away.
// Phones: bottom sheet with a tap-to-close backdrop. sm+: a popover above the More button.
// Keyboard: focus moves to the first tool on open, arrows move between tools, Tab is trapped,
// Escape / backdrop / Close return focus to the More button (EditorToolbar owns that).
// Each tool keeps its `editor-tool-<id>` testid here, exactly as in the row.

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { nextRadioIndex, trapFocusIndex } from "@/lib/editor/roving";
import { cn } from "@/lib/utils";
import type { EditorContextValue } from "./editor-context";
import type { EditorTool } from "./tools/types";

export const MORE_SHEET_TITLE = "More tools";

const ITEM =
  "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-start text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

export interface MoreSheetProps {
  id: string;
  tools: readonly EditorTool[];
  ctx: EditorContextValue;
  /** Close without choosing (Escape, backdrop, Close button). */
  onClose(): void;
  /** A tool was chosen: the toolbar closes the sheet, then runs / opens the tool. */
  onPick(tool: EditorTool): void;
}

export function MoreSheet({ id, tools, ctx, onClose, onPick }: MoreSheetProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | HTMLAnchorElement | null)[]>([]);
  const disabled = tools.map((t) => t.isDisabled?.(ctx) ?? false);

  // Focus the first usable tool once, on open.
  useEffect(() => {
    const first = itemRefs.current.find((el) => el && !(el instanceof HTMLButtonElement && el.disabled));
    (first ?? rootRef.current?.querySelector<HTMLElement>("button"))?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Don't let the editor's window handler also clear the selection.
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const root = rootRef.current;
      if (!root) return;
      const all = Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
      if (all.length === 0) return;
      e.preventDefault();
      const from = all.indexOf(document.activeElement as HTMLElement);
      all[trapFocusIndex(from, all.length, e.shiftKey)]?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const from = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement | HTMLAnchorElement);
      const next = nextRadioIndex(from, disabled, e.key);
      if (next === null) return;
      e.preventDefault();
      itemRefs.current[next]?.focus();
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close more tools"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-30 bg-primary/25 sm:bg-transparent"
        data-testid="editor-more-backdrop"
      />
      <div
        ref={rootRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex max-h-[70dvh] flex-col rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-lift",
          "sm:absolute sm:inset-x-auto sm:end-2 sm:bottom-full sm:mb-2 sm:w-72 sm:rounded-2xl sm:border sm:pb-0",
        )}
        data-testid="editor-more-sheet"
      >
        <div aria-hidden="true" className="flex shrink-0 justify-center pt-2 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-input/40" />
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-border ps-4 pe-2">
          <h2 id={titleId} className="type-h2 min-w-0 flex-1 truncate py-2">
            {MORE_SHEET_TITLE}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="editor-more-close"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-labelledby={titleId}>
          {tools.map((t, i) => {
            const Icon = t.icon;
            const active = ctx.activeTool === t.id;
            const face = (
              <>
                <Icon className="size-5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{t.label}</span>
              </>
            );
            const setRef = (el: HTMLButtonElement | HTMLAnchorElement | null) => {
              itemRefs.current[i] = el;
            };
            return (
              <li key={t.id}>
                {t.href && !disabled[i] ? (
                  // Navigation entry (e.g. See all photos → review): a real link.
                  <Link
                    ref={setRef}
                    href={t.href(ctx)}
                    className={cn(ITEM, "text-foreground hover:bg-muted")}
                    data-testid={`editor-tool-${t.id}`}
                  >
                    {face}
                  </Link>
                ) : (
                  <button
                    ref={setRef}
                    type="button"
                    onClick={() => onPick(t)}
                    disabled={disabled[i]}
                    aria-pressed={t.Panel ? active : undefined}
                    className={cn(ITEM, active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted")}
                    data-active={active ? "true" : undefined}
                    data-testid={`editor-tool-${t.id}`}
                  >
                    {face}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

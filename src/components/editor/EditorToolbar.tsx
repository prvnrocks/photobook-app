"use client";

// Bottom toolbar (mobile: last row of the full-height editor, safe-area aware; desktop: same row
// under the page). Renders the registered tools for the current selection — see
// ./tools/registry.ts for the extension point. Plus the panel host for the active tool.
// 375 px (M10a): buttons size to their label (11 px, tight tracking, ≥ 44 px, ≤ 72 px on phones)
// so the 7 "nothing selected" tools fit; on narrower screens the row scrolls and fade edges show
// there is more.

import { X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { EDIT_ERROR_COPY } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { useEditor, type EditorContextValue } from "./editor-context";
import type { EditorTool } from "./tools/types";

/** Hint shown when no tool applies (exported for tests). */
export function toolbarHint(ctx: Pick<EditorContextValue, "readOnly" | "state">): string {
  if (ctx.readOnly) return "Read-only — editing is paused.";
  if (ctx.state.selection === null) return "Tap a photo or caption to edit it.";
  return "No tools for this yet.";
}

/** Which ends of a horizontal scroller have hidden content (scroll affordance). */
function useScrollEdges(ref: RefObject<HTMLElement | null>, deps: unknown) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((p) => (p.start === start && p.end === end ? p : { start, end }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // The row and every tool button: content width changes don't resize the row itself.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref, deps]);
  return edges;
}

export function EditorToolbar({ tools }: { tools: EditorTool[] }) {
  const ctx = useEditor();
  const { state, actions, activeTool } = ctx;
  const rowRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(rowRef, tools.map((t) => t.id).join(","));

  const onTool = (t: EditorTool) => {
    if (t.isDisabled?.(ctx)) return;
    t.run?.(ctx);
    if (t.Panel) {
      if (activeTool === t.id) ctx.closeTool();
      else ctx.openTool(t.id);
    }
  };

  return (
    <div className="shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]" data-testid="editor-toolbar">
      {state.error ? (
        <div role="alert" className="flex items-center gap-2 border-b bg-red-50 px-4 py-1 text-sm text-red-900" data-testid="editor-error">
          <p className="flex-1">{EDIT_ERROR_COPY[state.error]}</p>
          <button
            type="button"
            onClick={actions.dismissError}
            aria-label="Dismiss"
            className="flex size-11 shrink-0 items-center justify-center"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="relative mx-auto max-w-3xl">
      <div
        ref={rowRef}
        className="flex min-h-16 items-stretch gap-0.5 overflow-x-auto px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="editor-toolbar-row"
      >
        {tools.length === 0 ? (
          <p className="flex flex-1 items-center justify-center px-2 text-center text-sm text-muted-foreground" data-testid="toolbar-hint">
            {toolbarHint(ctx)}
          </p>
        ) : (
          tools.map((t) => {
            const Icon = t.icon;
            const disabled = t.isDisabled?.(ctx) ?? false;
            const active = activeTool === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onTool(t)}
                disabled={disabled}
                aria-pressed={t.Panel ? active : undefined}
                className={cn(
                  // Phones: as wide as the label (≥ 44 px tap target, ≤ 72 px); sm+: share the row.
                  "flex min-h-11 min-w-11 max-w-[72px] flex-auto shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1",
                  "text-[11px] leading-tight font-medium tracking-tight sm:max-w-none sm:min-w-16 sm:flex-1 sm:px-2 sm:text-xs sm:tracking-normal",
                  "outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40",
                  active ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
                data-testid={`editor-tool-${t.id}`}
              >
                <Icon className="size-5" aria-hidden="true" />
                <span className="whitespace-nowrap">{t.label}</span>
              </button>
            );
          })
        )}
      </div>
      {/* Scroll affordance: fade the edge that has more tools behind it. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent transition-opacity",
          edges.start ? "opacity-100" : "opacity-0",
        )}
        data-testid="toolbar-fade-start"
        data-visible={edges.start ? "true" : "false"}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent transition-opacity",
          edges.end ? "opacity-100" : "opacity-0",
        )}
        data-testid="toolbar-fade-end"
        data-visible={edges.end ? "true" : "false"}
      />
      </div>
    </div>
  );
}

/**
 * While editing text that sits ON the page (caption, cover title), the mobile panel is docked
 * under the page instead of floating over it: the carousel gets shorter, the height-bound page
 * scales down, and the text being edited stays visible. Exported for tests.
 */
export function panelDocksOnMobile(selection: EditorContextValue["state"]["selection"]): boolean {
  return selection?.kind === "caption" || (selection?.kind === "cover" && selection.part === "text");
}

/**
 * Panel of the active tool: bottom sheet on mobile (with a tap-to-close backdrop) — or docked
 * under the page for on-page text (see panelDocksOnMobile) or a tool with dockOnMobile — right-hand side panel on desktop
 * (lg). Rendered by EditorShell, whose panel row is a column on mobile.
 */
export function EditorPanelHost({ tool }: { tool: EditorTool | null }) {
  const ctx = useEditor();
  if (!tool || !tool.Panel) return null;
  const Panel = tool.Panel;
  const title = tool.panelTitle ?? tool.label;
  const docked = tool.dockOnMobile === true || panelDocksOnMobile(ctx.state.selection);
  return (
    <>
      {docked ? null : (
        <button
          type="button"
          aria-label="Close panel"
          tabIndex={-1}
          onClick={ctx.closeTool}
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
        />
      )}
      <aside
        role="dialog"
        aria-label={title}
        className={cn(
          docked
            ? "relative flex max-h-[42dvh] shrink-0 flex-col rounded-t-2xl border-t bg-background shadow-[0_-4px_16px_rgba(0,0,0,0.08)]"
            : "fixed inset-x-0 bottom-0 z-40 flex max-h-[70dvh] flex-col rounded-t-2xl border-t bg-background shadow-xl",
          "pb-[env(safe-area-inset-bottom)]",
          "lg:static lg:z-auto lg:max-h-none lg:w-80 lg:shrink-0 lg:rounded-none lg:border-t-0 lg:border-l lg:pb-0 lg:shadow-none",
        )}
        data-testid={`editor-panel-${tool.id}`}
        data-editor-panel=""
        data-docked={docked ? "true" : "false"}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-4">
          <h2 className="flex-1 truncate py-3 text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={ctx.closeTool}
            aria-label="Close"
            className="-mr-2 flex size-11 items-center justify-center"
            data-testid="editor-panel-close"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Panel ctx={ctx} close={ctx.closeTool} />
        </div>
      </aside>
    </>
  );
}

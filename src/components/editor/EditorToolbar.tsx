"use client";

// Bottom toolbar (mobile: last row of the full-height editor, safe-area aware; desktop: same row
// under the page). Renders the registered tools for the current selection — see
// ./tools/registry.ts for the extension point. Plus the panel host for the active tool.

import { X } from "lucide-react";
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

export function EditorToolbar({ tools }: { tools: EditorTool[] }) {
  const ctx = useEditor();
  const { state, actions, activeTool } = ctx;

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
      <div className="mx-auto flex min-h-16 max-w-3xl items-stretch gap-1 overflow-x-auto px-2 py-1 [scrollbar-width:none]">
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
                  "flex min-h-11 min-w-16 flex-1 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-2 text-xs font-medium",
                  "outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40",
                  active ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
                data-testid={`editor-tool-${t.id}`}
              >
                <Icon className="size-5" aria-hidden="true" />
                <span className="max-w-20 truncate">{t.label}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Panel of the active tool: bottom sheet on mobile (with a tap-to-close backdrop), right-hand
 * side panel on desktop (lg). Rendered by EditorShell.
 */
export function EditorPanelHost({ tool }: { tool: EditorTool | null }) {
  const ctx = useEditor();
  if (!tool || !tool.Panel) return null;
  const Panel = tool.Panel;
  const title = tool.panelTitle ?? tool.label;
  return (
    <>
      <button
        type="button"
        aria-label="Close panel"
        tabIndex={-1}
        onClick={ctx.closeTool}
        className="fixed inset-0 z-30 bg-black/20 lg:hidden"
      />
      <aside
        role="dialog"
        aria-label={title}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex max-h-[70dvh] flex-col rounded-t-2xl border-t bg-background shadow-xl",
          "pb-[env(safe-area-inset-bottom)]",
          "lg:static lg:z-auto lg:max-h-none lg:w-80 lg:shrink-0 lg:rounded-none lg:border-t-0 lg:border-l lg:pb-0 lg:shadow-none",
        )}
        data-testid={`editor-panel-${tool.id}`}
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

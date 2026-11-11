"use client";

// Bottom toolbar (mobile: last row of the full-height editor, safe-area aware; desktop: same row
// under the page). Renders the registered tools for the current selection — see
// ./tools/registry.ts for the extension point. Plus the panel host for the active tool.
// 375 px (M10a): buttons size to their label (11 px, tight tracking, ≥ 44 px, ≤ 72 px on phones)
// so the 7 "nothing selected" tools fit; on narrower screens the row scrolls and fade edges show
// there is more.
// M11 T13: app tokens; the active tool is filled navy with a terracotta marker (aria-pressed); a
// one-time coach line sits in the toolbar (in flow, never over the page); panels get a grab handle
// and a serif title.

import { Lightbulb, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { coachSeen, EDITOR_COACH_TEXT, markCoachSeen, subscribeCoach } from "@/lib/editor/coach";
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

/** Server/hydration snapshot: seen → the line only appears after hydration, never in SSR HTML. */
const coachSeenOnServer = () => true;

/** Whether the one-time coach line applies right now (exported for tests). */
export function coachApplies(ctx: Pick<EditorContextValue, "readOnly" | "state" | "activeTool">, toolCount: number): boolean {
  return !ctx.readOnly && ctx.state.selection === null && ctx.activeTool === null && toolCount > 0;
}

/**
 * One-time hint above the tool row: in the toolbar's own flow, so it never covers the page.
 * Hidden for good once dismissed or once the user taps a photo (localStorage, see lib/editor/coach).
 */
export function EditorCoachLine({ show }: { show: boolean }) {
  const seen = useSyncExternalStore(subscribeCoach, () => coachSeen(), coachSeenOnServer);
  if (!show || seen) return null;
  return <CoachLineView onDismiss={() => markCoachSeen()} />;
}

/** Presentational coach line (exported for render tests). */
export function CoachLineView({ onDismiss }: { onDismiss(): void }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-secondary/60 ps-4 pe-1" data-testid="editor-coach">
      <Lightbulb className="size-4 shrink-0 text-accent-strong" aria-hidden="true" />
      <p className="type-small min-w-0 flex-1 py-1.5 text-secondary-foreground">{EDITOR_COACH_TEXT}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss tip"
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="editor-coach-dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function EditorToolbar({ tools }: { tools: EditorTool[] }) {
  const ctx = useEditor();
  const { state, actions, activeTool } = ctx;
  const rowRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(rowRef, tools.map((t) => t.id).join(","));
  // The coach line has done its job once the user taps a photo.
  const selKind = state.selection?.kind ?? null;
  useEffect(() => {
    if (selKind === "slot" || selKind === "cover") markCoachSeen();
  }, [selKind]);

  const onTool = (t: EditorTool) => {
    if (t.isDisabled?.(ctx)) return;
    t.run?.(ctx);
    if (t.Panel) {
      if (activeTool === t.id) ctx.closeTool();
      else ctx.openTool(t.id);
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]" data-testid="editor-toolbar">
      {state.error ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-destructive-border bg-destructive-soft ps-4 pe-1 py-1 text-sm text-destructive"
          data-testid="editor-error"
        >
          <p className="flex-1">{EDIT_ERROR_COPY[state.error]}</p>
          <button
            type="button"
            onClick={actions.dismissError}
            aria-label="Dismiss"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <EditorCoachLine show={coachApplies(ctx, tools.length)} />
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
                  "relative flex min-h-11 min-w-11 max-w-[72px] flex-auto shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1",
                  "text-[11px] leading-tight font-medium tracking-tight sm:max-w-none sm:min-w-16 sm:flex-1 sm:px-2 sm:text-xs sm:tracking-normal",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:opacity-40",
                  active ? "bg-primary text-primary-foreground shadow-card" : "text-foreground hover:bg-muted",
                )}
                data-active={active ? "true" : undefined}
                data-testid={`editor-tool-${t.id}`}
              >
                <Icon className="size-5" aria-hidden="true" />
                <span className="whitespace-nowrap">{t.label}</span>
                {/* Not colour alone: the open tool also gets a terracotta bar. */}
                {active ? (
                  <span aria-hidden="true" className="absolute inset-x-3 bottom-0.5 h-0.5 rounded-full bg-accent-strong" />
                ) : null}
              </button>
            );
          })
        )}
      </div>
      {/* Scroll affordance: fade the edge that has more tools behind it. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-card to-transparent transition-opacity",
          edges.start ? "opacity-100" : "opacity-0",
        )}
        data-testid="toolbar-fade-start"
        data-visible={edges.start ? "true" : "false"}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-card to-transparent transition-opacity",
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
          className="fixed inset-0 z-30 bg-primary/25 lg:hidden"
        />
      )}
      <aside
        role="dialog"
        aria-label={title}
        className={cn(
          docked
            ? "relative flex max-h-[42dvh] shrink-0 flex-col rounded-t-2xl border-t border-border bg-card shadow-[0_-6px_18px_-8px_rgb(30_42_71/0.18)]"
            : "fixed inset-x-0 bottom-0 z-40 flex max-h-[70dvh] flex-col rounded-t-2xl border-t border-border bg-card shadow-lift",
          "pb-[env(safe-area-inset-bottom)]",
          "lg:static lg:z-auto lg:max-h-none lg:w-80 lg:shrink-0 lg:rounded-none lg:border-t-0 lg:border-l lg:pb-0 lg:shadow-none",
        )}
        data-testid={`editor-panel-${tool.id}`}
        data-editor-panel=""
        data-docked={docked ? "true" : "false"}
      >
        {/* Grab handle: shows this is a sheet (phones only; the desktop side panel has none). */}
        <div aria-hidden="true" className="flex shrink-0 justify-center pt-2 lg:hidden" data-testid="editor-panel-handle">
          <span className="h-1 w-10 rounded-full bg-input/40" />
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-border ps-4 pe-2">
          <h2 className="type-h2 min-w-0 flex-1 truncate py-2 lg:py-3">{title}</h2>
          <button
            type="button"
            onClick={ctx.closeTool}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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

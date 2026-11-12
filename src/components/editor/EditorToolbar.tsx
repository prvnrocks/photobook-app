"use client";

// Bottom toolbar (mobile: last row of the full-height editor, safe-area aware; desktop: same row
// under the page). Renders the registered tools for the current selection — see
// ./tools/registry.ts for the extension point. Plus the panel host for the active tool.
// M13 T8 (simple editor): at most 3 big primary tools per selection + a "More" button that opens
// MoreSheet with the rest (registry.splitTools) — ≤ 4 buttons, no sideways scroll at 375 px,
// every tool ≤ 2 taps away. Focus returns to More when its sheet (or a tool opened from it) closes.
// M11 T13: app tokens; the active tool is filled navy with a terracotta marker (aria-pressed); a
// one-time coach line sits in the toolbar (in flow, never over the page); panels get a grab handle
// and a serif title.

import { Ellipsis, Lightbulb, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { coachSeen, EDITOR_COACH_TEXT, markCoachSeen, subscribeCoach } from "@/lib/editor/coach";
import { EDIT_ERROR_COPY } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { useEditor, type EditorContextValue } from "./editor-context";
import { MoreSheet } from "./MoreSheet";
import { splitTools } from "./tools/registry";
import type { EditorTool } from "./tools/types";

/** Hint shown when no tool applies (exported for tests). */
export function toolbarHint(ctx: Pick<EditorContextValue, "readOnly" | "state">): string {
  if (ctx.readOnly) return "Read-only — editing is paused.";
  if (ctx.state.selection === null) return EDITOR_COACH_TEXT;
  return "No tools for this yet.";
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

const TOOL_BUTTON = cn(
  // Up to 4 equal buttons share the row: ≥ 44 px tall and wide, never wider than 10 rem on desktop.
  "relative flex min-h-14 min-w-11 max-w-40 flex-1 basis-0 flex-col items-center justify-center gap-1 rounded-lg px-1",
  // < 360 px (e.g. 320): one size smaller + tight tracking so "Background" still fits a quarter row.
  "text-xs leading-tight font-medium max-[359px]:text-[11px] max-[359px]:tracking-tight",
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:opacity-40",
);

function ToolButtonFace({ tool, active }: { tool: Pick<EditorTool, "icon" | "label">; active: boolean }) {
  const Icon = tool.icon;
  return (
    <>
      <Icon className="size-6" aria-hidden="true" />
      <span className="max-w-full truncate">{tool.label}</span>
      {/* Not colour alone: the open tool also gets a terracotta bar. */}
      {active ? <span aria-hidden="true" className="absolute inset-x-3 bottom-0.5 h-0.5 rounded-full bg-accent-strong" /> : null}
    </>
  );
}

/** What is selected, as a stable string (same thing → same key even for a new object). Exported for tests. */
export function selectionKey(selection: EditorContextValue["state"]["selection"]): string {
  if (selection === null) return "none";
  switch (selection.kind) {
    case "slot":
      return `slot:${selection.pageIdx}:${selection.slotIdx}`;
    case "caption":
      return `caption:${selection.pageIdx}`;
    case "cover":
      return `cover:${selection.part}`;
  }
}

/** True when keyboard focus is inside `el` or nowhere (<body>). */
function focusIsIn(el: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || (!!el && el.contains(active));
}

export function EditorToolbar({ tools }: { tools: EditorTool[] }) {
  const ctx = useEditor();
  const { state, actions, activeTool } = ctx;
  const { primary, more } = splitTools(tools, ctx);
  const moreId = useId();
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  /** Tool opened from the More sheet: when its panel closes, focus goes back to More. */
  const openedFromMore = useRef<string | null>(null);

  // The coach line has done its job once the user taps a photo.
  const selKind = state.selection?.kind ?? null;
  useEffect(() => {
    if (selKind === "slot" || selKind === "cover") markCoachSeen();
  }, [selKind]);

  // A different selection shows a different set of tools: close a stale sheet — only when what is
  // selected really changed (not on a new object for the same thing), and keep focus in the toolbar.
  const selKey = selectionKey(state.selection);
  const lastSelKey = useRef(selKey);
  const rowRef = useRef<HTMLDivElement>(null);
  /** Set when the sheet closes by itself while focus was in it: refocus the toolbar after unmount. */
  const refocusRef = useRef(false);
  const hasMore = more.length > 0;
  useEffect(() => {
    const changed = lastSelKey.current !== selKey;
    lastSelKey.current = selKey;
    if (!moreOpen || (!changed && hasMore)) return;
    refocusRef.current = focusIsIn(document.getElementById(moreId));
    setMoreOpen(false);
  }, [selKey, hasMore, moreId, moreOpen]);
  useEffect(() => {
    if (moreOpen || !refocusRef.current) return;
    refocusRef.current = false;
    const el = document.activeElement;
    if (el && el !== document.body) return;
    (moreBtnRef.current ?? rowRef.current?.querySelector<HTMLElement>("button:not([disabled]), a[href]"))?.focus();
  }, [moreOpen]);

  // Focus return after a tool opened from More closes (its panel unmounted, focus fell to <body>).
  useEffect(() => {
    const from = openedFromMore.current;
    if (from === null || activeTool === from) return;
    openedFromMore.current = null;
    const el = document.activeElement;
    if (!el || el === document.body) moreBtnRef.current?.focus();
  }, [activeTool]);

  const onTool = (t: EditorTool) => {
    if (t.isDisabled?.(ctx)) return;
    t.run?.(ctx);
    if (t.Panel) {
      if (activeTool === t.id) ctx.closeTool();
      else ctx.openTool(t.id);
    }
  };

  const closeMore = () => {
    setMoreOpen(false);
    moreBtnRef.current?.focus();
  };

  const pickFromMore = (t: EditorTool) => {
    setMoreOpen(false);
    // Keep keyboard focus on a live control; the sheet item is about to unmount.
    moreBtnRef.current?.focus();
    if (t.Panel && activeTool !== t.id) openedFromMore.current = t.id;
    onTool(t);
  };

  const moreActive = more.some((t) => t.id === activeTool);
  const shownCount = primary.length + (hasMore ? 1 : 0);

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
          role="group"
          aria-label="Editing tools"
          className="flex min-h-16 items-stretch justify-center gap-1 px-2 py-1"
          data-testid="editor-toolbar-row"
          data-count={shownCount}
        >
          {shownCount === 0 ? (
            <p className="flex flex-1 items-center justify-center px-2 text-center text-sm text-muted-foreground" data-testid="toolbar-hint">
              {toolbarHint(ctx)}
            </p>
          ) : (
            <>
              {primary.map((t) => {
                const disabled = t.isDisabled?.(ctx) ?? false;
                const active = activeTool === t.id;
                if (t.href && !disabled) {
                  return (
                    <Link
                      key={t.id}
                      href={t.href(ctx)}
                      className={cn(TOOL_BUTTON, "text-foreground hover:bg-muted")}
                      data-testid={`editor-tool-${t.id}`}
                    >
                      <ToolButtonFace tool={t} active={false} />
                    </Link>
                  );
                }
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onTool(t)}
                    disabled={disabled}
                    aria-pressed={t.Panel ? active : undefined}
                    className={cn(TOOL_BUTTON, active ? "bg-primary text-primary-foreground shadow-card" : "text-foreground hover:bg-muted")}
                    data-active={active ? "true" : undefined}
                    data-testid={`editor-tool-${t.id}`}
                  >
                    <ToolButtonFace tool={t} active={active} />
                  </button>
                );
              })}
              {hasMore ? (
                <button
                  ref={moreBtnRef}
                  type="button"
                  onClick={() => (moreOpen ? closeMore() : setMoreOpen(true))}
                  aria-haspopup="dialog"
                  aria-expanded={moreOpen}
                  aria-controls={moreOpen ? moreId : undefined}
                  className={cn(TOOL_BUTTON, moreActive || moreOpen ? "bg-muted text-foreground" : "text-foreground hover:bg-muted")}
                  data-active={moreActive ? "true" : undefined}
                  data-testid="editor-more"
                >
                  <ToolButtonFace tool={{ icon: Ellipsis, label: "More" }} active={moreActive} />
                </button>
              ) : null}
            </>
          )}
        </div>
        {moreOpen && hasMore ? <MoreSheet id={moreId} tools={more} ctx={ctx} onClose={closeMore} onPick={pickFromMore} /> : null}
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

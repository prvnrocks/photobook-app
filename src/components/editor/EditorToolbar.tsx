"use client";

// Bottom toolbar (mobile: last row of the full-height editor, safe-area aware; desktop: same row
// under the page). Renders the registered tools for the current selection — see
// ./tools/registry.ts for the extension point. Plus the panel host for the active tool.
// M13 T8 (simple editor): at most 3 big primary tools per selection + a "More" button that opens
// MoreSheet with the rest (registry.splitTools) — ≤ 4 buttons, no sideways scroll at 375 px,
// every tool ≤ 2 taps away. Focus returns to More when its sheet (or a tool opened from it) closes.
// M11 T13: app tokens; the active tool is filled navy with a terracotta marker (M17: deep emerald with a gold marker) (aria-pressed); a
// one-time coach line sits in the toolbar (in flow, never over the page); panels get a grab handle
// and a serif title.
// M22 T5 (D-074): emerald style — the row is a floating white pill bar (ED_PILL_BAR) of emerald
// segmented pills (ED_PILL / ED_PILL_ACTIVE, merged with cn so phone overrides win), the active tool
// is an emerald fill with a small gold marker; the coach line and error strip are cards; panels are
// card sheets on phones and a side card ≥ lg. Motion: the panel host only fades in (ed-panel-in,
// opacity) — it is an ancestor of the crop box and the pages dnd-kit grid, so it never translates.

import { Ellipsis, Lightbulb, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { coachSeen, EDITOR_COACH_TEXT, markCoachSeen, subscribeCoach } from "@/lib/editor/coach";
import { EDIT_ERROR_COPY } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { ED_CLOSE_BTN, ED_PANEL_HEADING, ED_PILL, ED_PILL_ACTIVE, ED_PILL_BAR, ED_SHEET } from "./editor-classes";
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
    <div className={cn(CARD_STRIP, "border-[#e9dfca] bg-card")} data-testid="editor-coach">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#f6efdc]" aria-hidden="true">
        <Lightbulb className="size-4 text-accent-text" />
      </span>
      <p className="type-small min-w-0 flex-1 py-1.5 text-[#0e3b2e]">{EDITOR_COACH_TEXT}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss tip"
        className={ED_CLOSE_BTN}
        data-testid="editor-coach-dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Coach line / error strip: a small floating card above the pill bar (in flow, never over the page).
 * ≥ md it sits BESIDE the pill bar instead (TOOLBAR_ROW wraps only when there's no room), so the
 * coach line appearing after hydration (it's never in SSR HTML) doesn't make the toolbar taller and
 * the stage doesn't jump (M22 T7: 70 → 124 px before).
 */
const CARD_STRIP =
  "mx-auto mb-2 flex w-full max-w-md items-center gap-2 rounded-2xl border ps-3 pe-1 shadow-[0_10px_24px_-18px_rgb(14_59_46/0.5)] md:mx-0 md:mb-0 md:w-auto md:min-w-0 md:shrink md:grow-0 md:basis-[22rem]";

/** The toolbar block: a column on phones; ≥ md one centred row (card strips · pill bar). */
const TOOLBAR_ROW =
  "shrink-0 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] ps-[max(0.5rem,env(safe-area-inset-left))] pe-[max(0.5rem,env(safe-area-inset-right))] md:flex md:flex-wrap md:items-center md:justify-center md:gap-x-3 md:gap-y-2";

/**
 * Pill overrides (merged over ED_PILL / ED_PILL_ACTIVE by cn — tailwind-merge, so these win):
 * phones (< sm): up to 4 equal pills share the bar, icon over label, 56 px tall — < 360 px (e.g.
 * 320) one size smaller + tight tracking so "Background" still fits a quarter row. sm+: icon beside
 * the label, content width, 44 px.
 */
const TOOL_PILL = cn(
  "relative min-h-14 min-w-11 max-w-40 flex-1 basis-0 flex-col gap-0.5 rounded-[1.25rem] px-1",
  "text-xs leading-tight max-[359px]:px-0.5 max-[359px]:text-[11px] max-[359px]:tracking-tight",
  "sm:min-h-11 sm:max-w-none sm:flex-none sm:basis-auto sm:flex-row sm:gap-2 sm:rounded-full sm:px-4 sm:text-sm",
);

const pillClass = (active: boolean, extra?: string) => cn(active ? ED_PILL_ACTIVE : ED_PILL, TOOL_PILL, extra);

function ToolButtonFace({ tool, active }: { tool: Pick<EditorTool, "icon" | "label">; active: boolean }) {
  const Icon = tool.icon;
  return (
    <>
      <Icon className="size-6 shrink-0 sm:size-5" aria-hidden="true" />
      <span className="max-w-full truncate">{tool.label}</span>
      {/* Not colour alone: the open tool also gets a small gold marker (pale gold on emerald). */}
      {active ? (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-1 mx-auto h-1 w-4 rounded-full bg-[#e3c766]" />
      ) : null}
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
    <div className={TOOLBAR_ROW} data-testid="editor-toolbar">
      {state.error ? (
        <div
          role="alert"
          className={cn(CARD_STRIP, "border-destructive-border bg-destructive-soft py-0.5 text-sm text-destructive")}
          data-testid="editor-error"
        >
          <p className="min-w-0 flex-1">{EDIT_ERROR_COPY[state.error]}</p>
          <button
            type="button"
            onClick={actions.dismissError}
            aria-label="Dismiss"
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-destructive outline-none hover:bg-white/60 focus-visible:ring-2 focus-visible:ring-destructive"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <EditorCoachLine show={coachApplies(ctx, tools.length)} />
      <div className="relative mx-auto w-full max-w-md sm:w-fit sm:max-w-full md:mx-0">
        <div
          ref={rowRef}
          role="group"
          aria-label="Editing tools"
          // overflow-visible (merged over the bar's overflow-x-auto): the row never scrolls sideways —
          // ≤ 4 pills always fit, down to 320 px.
          className={cn(ED_PILL_BAR, "w-full items-stretch justify-center gap-0.5 overflow-visible rounded-[1.75rem] sm:gap-1 sm:rounded-full")}
          data-testid="editor-toolbar-row"
          data-count={shownCount}
        >
          {shownCount === 0 ? (
            <p className="flex min-h-11 flex-1 items-center justify-center px-3 text-center text-sm text-[#56625a]" data-testid="toolbar-hint">
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
                      className={pillClass(false)}
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
                    className={pillClass(active)}
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
                  className={pillClass(false, moreActive || moreOpen ? "bg-[#e6efe9]" : undefined)}
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
          className="fixed inset-0 z-30 bg-[#0e3b2e]/35 lg:hidden"
        />
      )}
      <aside
        role="dialog"
        aria-label={title}
        className={cn(
          // Phones: a card sheet (ED_SHEET; its ::before handle is replaced by the testid'd handle
          // below, and the inner rows own their padding).
          ED_SHEET,
          // Opacity-only entrance: this host contains the crop box (getBoundingClientRect) and the
          // pages dnd-kit grid, so no translating animation here (ed-sheet-rise is for MoreSheet,
          // SpreadPreviewSheet and UpgradeSheet only).
          "ed-panel-in flex flex-col px-0 pb-[env(safe-area-inset-bottom)] before:hidden",
          docked ? "relative max-h-[42dvh] shrink-0" : "fixed inset-x-0 bottom-0 z-40 max-h-[70dvh]",
          // ≥ lg: the side card panel beside the stage (lg-prefixed so the
          // phone sheet above stays one element: lg:w-80 xl:w-96, own scroll, card shadow).
          "lg:static lg:z-auto lg:my-3 lg:me-3 lg:max-h-none lg:w-80 lg:shrink-0 lg:rounded-3xl lg:border lg:border-[#e9dfca] lg:pb-0 lg:shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] xl:w-96",
        )}
        data-testid={`editor-panel-${tool.id}`}
        data-editor-panel=""
        data-docked={docked ? "true" : "false"}
      >
        {/* Grab handle: shows this is a sheet (phones only; the desktop side panel has none). */}
        <div aria-hidden="true" className="flex shrink-0 justify-center pt-2 lg:hidden" data-testid="editor-panel-handle">
          <span className="h-1.5 w-10 rounded-full bg-[#cfc4ad]" />
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-[#efe7d6] ps-4 pe-2 lg:ps-5 lg:pe-3 lg:pt-2">
          <h2 className={cn(ED_PANEL_HEADING, "min-w-0 flex-1 truncate py-2 lg:py-3 lg:text-xl")}>{title}</h2>
          <button
            type="button"
            onClick={ctx.closeTool}
            aria-label="Close"
            className={ED_CLOSE_BTN}
            data-testid="editor-panel-close"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-5">
          <Panel ctx={ctx} close={ctx.closeTool} />
        </div>
      </aside>
    </>
  );
}

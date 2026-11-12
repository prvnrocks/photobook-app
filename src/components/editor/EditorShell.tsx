"use client";

// Editor shell (M5 Task 8): full-height, mobile-first layout
//   header (back · title + save status · undo/redo)
//   save banner (read-only / conflict / rejected / signed out)
//   "AI kept X of Y · See left out" chip → review screen (M13 T7, D-070 (3)), or — for a rule
//   album that never got an AI build — the persistent "Make it with AI" chip (src/lib/editor/ai-path.ts)
//   [desktop: page strip] · page carousel · [desktop: tool panel]
//   toolbar (registered tools for the current selection) — mobile: bottom sheet for panels
// State: useEditorStore (doc + undo/redo + position + selection); autosave: useAutosave;
// photo URLs heal themselves via usePhotoUrls.

import { ArrowLeft, Redo2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayBookTitle } from "@/lib/book/display-title";
import { sessionAiPath } from "@/lib/editor/ai-path";
import type { AiSummary } from "@/lib/editor/ai-summary";
import type { AiSessionBlock } from "@/lib/editor/caption-tools";
import { stepSpread } from "@/lib/editor/spreads";
import { canRedo, canUndo } from "@/lib/editor/store";
import { httpEditorTransport, type EditorTransport } from "@/lib/editor/transport";
import type { ShareResult } from "@/lib/editor/done";
import type { EditorShellData } from "@/lib/editor/types";
import { hasUnpublishedChanges } from "@/lib/publish/ui";
import { AiSummaryChip } from "./AiSummaryChip";
import { EditorContext, type EditorContextValue } from "./editor-context";
import { EditorShareButton } from "./EditorShareButton";
import { MakeWithAiChip } from "./MakeWithAiChip";
import { EditorToastHost } from "./EditorToast";
import { EditorPanelHost, EditorToolbar } from "./EditorToolbar";
import { PageCarousel, SpreadCarouselPlaceholder } from "./PageCarousel";
import { cn } from "@/lib/utils";
import { PageStrip } from "./PageStrip";
import { SaveBanner, SaveStatus } from "./SaveStatus";
import { autoOpenTool, EDITOR_TOOLS, visibleTools } from "./tools/registry";
import type { EditorTool } from "./tools/types";
import { useAutosave } from "./useAutosave";
import { useEditorStore } from "./useEditorStore";
import { useBrokenImageWatcher, usePhotoUrls } from "./usePhotoUrls";
import { useSpreadMode } from "./useSpreadMode";

export type EditorShellProps = {
  data: EditorShellData;
  /** Override the HTTP transport (dev fixture route / tests). */
  transport?: EditorTransport;
  /** Override the tool registry (dev fixture / tests). Defaults to EDITOR_TOOLS. */
  tools?: readonly EditorTool[];
  /** Back link target (default /dashboard). */
  backHref?: string;
  /** Header "Share" (M13 T9): bound shareBookAction. Absent → Share saves, then goes to backHref. */
  share?: () => Promise<ShareResult>;
  /** isPaymentsEnabled() from the server page; false → the Upgrade sheet shows "Payments unavailable". */
  paymentsEnabled?: boolean;
  /** Force single-page or facing-pages editing (tests / dev); default = by screen width (≥ md → spreads). */
  layout?: "single" | "spread";
  /**
   * "AI kept X of Y · See left out" chip (M13 T7): computed by the edit page (aiSummary in
   * src/lib/editor/ai-summary.ts). Absent/null → no chip (dev fixture, rule album with nothing left out).
   */
  aiSummary?: AiSummary | null;
};

/** Header icon buttons: 44 px, visible focus ring (M11 tokens). */
const HEADER_ICON_BTN =
  "flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:bg-transparent";

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

export function EditorShell({ data, transport: transportProp, tools: toolsProp, backHref = "/dashboard", share, paymentsEnabled = false, layout, aiSummary = null }: EditorShellProps) {
  // null until the screen width is known (server render + hydration) — see the render below.
  const spreadMode = useSpreadMode(layout);
  const spread = spreadMode === true;
  const [transport] = useState(() => transportProp ?? httpEditorTransport(data.book.id));
  const saveEnabled = data.canSave && data.docRev !== null;
  const { state, actions } = useEditorStore(data.doc, { readOnly: !saveEnabled });
  const autosave = useAutosave({ doc: state.doc, baseRev: data.docRev, enabled: saveEnabled, transport });
  const photos = usePhotoUrls(data.photos, transport);
  const [rewrites, setRewritesState] = useState({ used: data.rewritesUsed, left: data.rewritesLeft });
  const [aiBlocked, setAiBlocked] = useState<AiSessionBlock | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useBrokenImageWatcher(rootRef, photos);

  // Terminal save states stop editing: further edits could never be saved.
  const terminal =
    autosave.status.kind === "conflict" ||
    autosave.status.kind === "unavailable" ||
    autosave.status.kind === "signedOut" ||
    autosave.status.kind === "failed";
  useEffect(() => {
    if (terminal) actions.setReadOnly(true);
  }, [terminal, actions]);

  const openTool = useCallback((id: string) => setActiveTool(id), []);
  const closeTool = useCallback(() => setActiveTool(null), []);
  const setRewrites = useCallback((used: number, left: number) => setRewritesState({ used, left }), []);
  // Any edit will be saved as a user edit, after which AI runs are refused (D-037 #2).
  const editedThisSession = canUndo(state);
  const aiPath = useMemo(
    () => sessionAiPath(data.aiPath, { edited: editedThisSession, readOnly: state.readOnly }),
    [data.aiPath, editedThisSession, state.readOnly],
  );

  const ctx = useMemo<EditorContextValue>(
    () => ({
      book: data.book,
      paymentsEnabled,
      state,
      actions,
      photos,
      readOnly: state.readOnly,
      save: { status: autosave.status, flush: autosave.flush, settle: autosave.settle },
      ai: {
        mode: data.aiMode,
        rewritesUsed: rewrites.used,
        rewritesLeft: rewrites.left,
        setRewrites,
        blocked: aiBlocked,
        blockSession: setAiBlocked,
      },
      aiPath,
      spread,
      activeTool,
      openTool,
      closeTool,
    }),
    [data.book, paymentsEnabled, data.aiMode, state, actions, photos, autosave.status, autosave.flush, autosave.settle, rewrites, setRewrites, aiBlocked, aiPath, spread, activeTool, openTool, closeTool],
  );

  const registry = toolsProp ?? EDITOR_TOOLS;
  const shown = useMemo(() => visibleTools(registry, ctx), [registry, ctx]);
  const active = shown.find((t) => t.id === activeTool) ?? null;

  // Auto-open on selection (tools with openOnSelect); close a panel whose tool no longer applies.
  const lastSelection = useRef(state.selection);
  useEffect(() => {
    const changed = lastSelection.current !== state.selection;
    lastSelection.current = state.selection;
    if (changed) {
      const auto = autoOpenTool(registry, ctx);
      if (auto) {
        setActiveTool(auto.id);
        return;
      }
    }
    if (activeTool !== null && !active) setActiveTool(null);
  }, [state.selection, registry, ctx, activeTool, active]);

  // Keyboard: undo/redo, arrows to flip pages (spreads on ≥ md), Escape to close/deselect.
  const page = state.page;
  const pageCount = state.doc.pages.length;
  useEffect(() => {
    const step = (delta: 1 | -1) => {
      if (spread) actions.goTo(stepSpread(page, delta, pageCount));
      else if (delta > 0) actions.next();
      else actions.prev();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) actions.redo();
        else actions.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        actions.redo();
      } else if (!mod && e.key === "Escape") {
        if (activeTool !== null) setActiveTool(null);
        else actions.select(null);
      } else if (!mod && activeTool === null && e.key === "ArrowLeft") {
        step(-1);
      } else if (!mod && activeTool === null && e.key === "ArrowRight") {
        step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, activeTool, spread, page, pageCount]);

  // The live cover title is the user's title here (saving syncs it to books.title, D-037 (7)).
  const title = displayBookTitle(state.doc.cover.title || data.book.title, state.doc);
  const unpublished = hasUnpublishedChanges(data.publishedRev, autosave.rev);

  return (
    <EditorContext.Provider value={ctx}>
      <div ref={rootRef} className="flex h-dvh flex-col overflow-hidden bg-background" data-testid="editor-shell" data-readonly={state.readOnly ? "true" : "false"}>
        <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-card px-1">
          <Link
            href={backHref}
            aria-label="Back to my books"
            className={HEADER_ICON_BTN}
            data-testid="editor-back"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <h1 dir="auto" className="truncate font-display text-base font-semibold" data-testid="editor-title">
              {title}
            </h1>
            {/* Unpublished edits show on the Share button ("Publish changes", M13 T9). */}
            <SaveStatus status={autosave.status} />
          </div>
          <button
            type="button"
            onClick={actions.undo}
            disabled={!canUndo(state)}
            aria-label="Undo"
            className={HEADER_ICON_BTN}
            data-testid="editor-undo"
          >
            <Undo2 className="size-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={actions.redo}
            disabled={!canRedo(state)}
            aria-label="Redo"
            className={HEADER_ICON_BTN}
            data-testid="editor-redo"
          >
            <Redo2 className="size-5" aria-hidden="true" />
          </button>
          <EditorShareButton
            bookId={data.book.id}
            settle={autosave.settle}
            share={share}
            fallbackHref={backHref}
            isPaid={data.book.isPaid}
            hasChanges={unpublished}
            freeLink={data.freeLink}
            maxPages={data.book.maxPages}
          />
        </header>

        <SaveBanner status={autosave.status} bookId={data.book.id} />
        {aiPath.makeWithAi ? (
          // Not dismissible: the only way into the AI for this book. Photos stay one tap away in
          // More → "See all photos".
          <MakeWithAiChip bookId={data.book.id} />
        ) : (
          <AiSummaryChip bookId={data.book.id} summary={aiSummary} readOnly={state.readOnly} />
        )}

        {/* Column on mobile so a docked panel (on-page text editing) sits under the page. */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {spreadMode === null ? (
            // lg+ is always spread mode: keep the spread strip's width until the strip can render.
            <div aria-hidden="true" className="hidden w-44 shrink-0 border-r border-border bg-muted/40 lg:block" />
          ) : (
            <PageStrip className={spread ? "hidden w-44 shrink-0 lg:block" : "hidden w-36 shrink-0 lg:block"} />
          )}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Remount on mode change: item indexes mean pages in one mode and spreads in the other.
                Width unknown (SSR/hydration): phones get the real single-page carousel, md+ a
                spread-shaped placeholder — no single → spread flash on desktop (N7). */}
            {spread ? (
              <PageCarousel key="spread" />
            ) : (
              <div className={cn("flex min-h-0 flex-1 flex-col", spreadMode === null && "md:hidden")} data-testid="single-carousel-wrap">
                <PageCarousel key="single" />
              </div>
            )}
            {spreadMode === null ? <SpreadCarouselPlaceholder className="hidden md:flex" /> : null}
            <EditorToolbar tools={shown} />
          </main>
          <EditorPanelHost tool={active} />
          <EditorToastHost />
        </div>
      </div>
    </EditorContext.Provider>
  );
}

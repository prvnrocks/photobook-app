"use client";

// Editor shell (M5 Task 8): full-height, mobile-first layout
//   header (back · title + save status · undo/redo)
//   save banner (read-only / conflict / rejected / signed out)
//   [desktop: page strip] · page carousel · [desktop: tool panel]
//   toolbar (registered tools for the current selection) — mobile: bottom sheet for panels
// State: useEditorStore (doc + undo/redo + position + selection); autosave: useAutosave;
// photo URLs heal themselves via usePhotoUrls.

import { ArrowLeft, Redo2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canRedo, canUndo } from "@/lib/editor/store";
import { httpEditorTransport, type EditorTransport } from "@/lib/editor/transport";
import type { EditorShellData } from "@/lib/editor/types";
import { EditorContext, type EditorContextValue } from "./editor-context";
import { EditorPanelHost, EditorToolbar } from "./EditorToolbar";
import { PageCarousel } from "./PageCarousel";
import { PageStrip } from "./PageStrip";
import { SaveBanner, SaveStatus } from "./SaveStatus";
import { autoOpenTool, EDITOR_TOOLS, visibleTools } from "./tools/registry";
import type { EditorTool } from "./tools/types";
import { useAutosave } from "./useAutosave";
import { useEditorStore } from "./useEditorStore";
import { useBrokenImageWatcher, usePhotoUrls } from "./usePhotoUrls";

export type EditorShellProps = {
  data: EditorShellData;
  /** Override the HTTP transport (dev fixture route / tests). */
  transport?: EditorTransport;
  /** Override the tool registry (dev fixture / tests). Defaults to EDITOR_TOOLS. */
  tools?: readonly EditorTool[];
  /** Back link target (default /dashboard). */
  backHref?: string;
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

export function EditorShell({ data, transport: transportProp, tools: toolsProp, backHref = "/dashboard" }: EditorShellProps) {
  const [transport] = useState(() => transportProp ?? httpEditorTransport(data.book.id));
  const saveEnabled = data.canSave && data.docRev !== null;
  const { state, actions } = useEditorStore(data.doc, { readOnly: !saveEnabled });
  const autosave = useAutosave({ doc: state.doc, baseRev: data.docRev, enabled: saveEnabled, transport });
  const photos = usePhotoUrls(data.photos, transport);
  const [rewrites, setRewritesState] = useState({ used: data.rewritesUsed, left: data.rewritesLeft });
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

  const ctx = useMemo<EditorContextValue>(
    () => ({
      book: data.book,
      state,
      actions,
      photos,
      readOnly: state.readOnly,
      save: { status: autosave.status, flush: autosave.flush },
      ai: { mode: data.aiMode, rewritesUsed: rewrites.used, rewritesLeft: rewrites.left, setRewrites },
      activeTool,
      openTool,
      closeTool,
    }),
    [data.book, data.aiMode, state, actions, photos, autosave.status, autosave.flush, rewrites, setRewrites, activeTool, openTool, closeTool],
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

  // Keyboard: undo/redo, arrows to flip pages, Escape to close/deselect.
  useEffect(() => {
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
        actions.prev();
      } else if (!mod && activeTool === null && e.key === "ArrowRight") {
        actions.next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, activeTool]);

  const title = state.doc.cover.title || data.book.title || "Untitled book";

  return (
    <EditorContext.Provider value={ctx}>
      <div ref={rootRef} className="flex h-dvh flex-col overflow-hidden bg-background" data-testid="editor-shell" data-readonly={state.readOnly ? "true" : "false"}>
        <header className="flex h-14 shrink-0 items-center gap-1 border-b px-1">
          <Link
            href={backHref}
            aria-label="Back to my books"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted"
            data-testid="editor-back"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <h1 dir="auto" className="truncate text-sm font-semibold" data-testid="editor-title">
              {title}
            </h1>
            <SaveStatus status={autosave.status} />
          </div>
          <button
            type="button"
            onClick={actions.undo}
            disabled={!canUndo(state)}
            aria-label="Undo"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"
            data-testid="editor-undo"
          >
            <Undo2 className="size-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={actions.redo}
            disabled={!canRedo(state)}
            aria-label="Redo"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"
            data-testid="editor-redo"
          >
            <Redo2 className="size-5" aria-hidden="true" />
          </button>
        </header>

        <SaveBanner status={autosave.status} bookId={data.book.id} />

        <div className="flex min-h-0 flex-1">
          <PageStrip className="hidden w-36 shrink-0 lg:block" />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PageCarousel />
            <EditorToolbar tools={shown} />
          </main>
          <EditorPanelHost tool={active} />
        </div>
      </div>
    </EditorContext.Provider>
  );
}

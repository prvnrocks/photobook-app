// Editor toolbar registry — THE extension point for M5 Tasks 9–11.
//
// How to add a tool (one import + one array entry):
//
//   // src/components/editor/tools/replace-photo.tsx
//   export const replacePhotoTool: EditorTool = {
//     id: "replace", label: "Replace", icon: ImageIcon, scopes: ["slot", "cover"], order: 10,
//     Panel: ReplacePhotoPanel,           // gets { ctx, close }; ctx = useEditor()
//   };
//   // here:
//   import { replacePhotoTool } from "./replace-photo";
//   export const EDITOR_TOOLS = [replacePhotoTool, …];
//
// - The toolbar shows the tools whose `scopes` match the current selection (state.selection:
//   slot / caption / cover / none), sorted by `order`. Tapping one calls run(ctx) and/or opens its
//   Panel (bottom sheet on mobile, right-hand panel on desktop). `openOnSelect` opens the Panel
//   directly when the user taps a matching thing on the page (caption editor, Task 10).
// - Edit the doc ONLY through ctx.actions.edit(op, { coalesceKey?, select?, goTo? }) with ops
//   from src/lib/book/edit-ops.ts; never mutate ctx.state.doc. Autosave and undo follow.
// - Simple toolbar (M13): each tool has a `tier` ("primary" | "more", optionally per selection
//   kind). The row shows at most MAX_PRIMARY_TOOLS primary tools + a "More" button that opens a
//   sheet with the rest (splitTools) — every tool stays ≤ 2 taps away. New tools default to "more".
// - Read-only: tools with editsDoc !== false are hidden; check ctx.readOnly in panels too.
// - Planned owners: Task 9 slot tools (Replace / Layout / Crop) — scopes ["slot"] (+ "cover" for
//   Replace); Task 10 caption editor + ✨ menu (scopes ["caption"], openOnSelect) and cover text
//   (scopes ["cover"]); Task 11 Pages sheet / Add page / Upgrade (scopes "always", order 70+).

import type { EditorContextValue } from "../editor-context";
import { selectionKind } from "@/lib/editor/store";
import type { SelectionKind } from "@/lib/editor/store";
import type { EditorTool, ToolTier } from "./types";
import { cropTool } from "./crop-mode";
import { layoutPickerTool } from "./layout-picker";
import { backgroundTool } from "./background-picker";
import { photoPickerTool } from "./photo-picker";
import { aiCaptionTool } from "./ai-caption";
import { captionEditorTool, captionStyleTool } from "./caption-editor";
import { chapterTitleTool } from "./chapter-title";
import { coverTextTool } from "./cover-text";
import { addPageTool } from "./add-page";
import { pageMenuTool } from "./page-menu";
import { pagesTool } from "./pages";
import { upgradeTool } from "../UpgradeSheet";
import { pdfDownloadTool } from "./pdf-download";
import { redoAiTool, seePhotosTool } from "./ai-path-links";

export type { EditorPanelProps, EditorTool, ToolScope, ToolTier } from "./types";

/** Registered tools. Tasks 9–11 append here. */
export const EDITOR_TOOLS: readonly EditorTool[] = [
  photoPickerTool,
  cropTool,
  layoutPickerTool,
  backgroundTool,
  pagesTool,
  addPageTool,
  pageMenuTool,
  upgradeTool,
  pdfDownloadTool,
  seePhotosTool,
  redoAiTool,
  captionEditorTool,
  aiCaptionTool,
  captionStyleTool,
  chapterTitleTool,
  coverTextTool,
];

/** Tools to show for the current editor state, sorted by order (then registry order). */
export function visibleTools(tools: readonly EditorTool[], ctx: EditorContextValue): EditorTool[] {
  const kind = selectionKind(ctx.state.selection);
  return tools
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (ctx.readOnly && t.editsDoc !== false) return false;
      if (t.scopes !== "always" && !t.scopes.includes(kind)) return false;
      return t.isAvailable ? t.isAvailable(ctx) : true;
    })
    .sort((a, b) => (a.t.order ?? 100) - (b.t.order ?? 100) || a.i - b.i)
    .map(({ t }) => t);
}

/** The tool to auto-open for the current selection (first visible tool with openOnSelect). */
export function autoOpenTool(tools: readonly EditorTool[], ctx: EditorContextValue): EditorTool | null {
  if (ctx.state.selection === null) return null;
  return visibleTools(tools, ctx).find((t) => t.openOnSelect && t.Panel) ?? null;
}

/** Big buttons in the toolbar row per selection; the rest go behind "More" (M13, ≤ 4 buttons at 375 px). */
export const MAX_PRIMARY_TOOLS = 3;

/** A tool's tier for a selection kind (default "more"). */
export function toolTier(tool: Pick<EditorTool, "tier">, kind: SelectionKind): ToolTier {
  const t = tool.tier;
  if (t === undefined) return "more";
  if (typeof t === "string") return t;
  return t[kind] ?? "more";
}

export interface ToolSplit {
  /** Buttons in the row (≤ MAX_PRIMARY_TOOLS, or + 1 when only one tool would sit behind More). */
  primary: EditorTool[];
  /** Tools in the More sheet (empty → no More button). */
  more: EditorTool[];
}

/**
 * Split the visible tools (visibleTools order) into row buttons and the More sheet: the first
 * MAX_PRIMARY_TOOLS primary-tier tools go in the row, everything else behind More. A More sheet
 * holding a single tool is pointless, so that tool joins the row instead (still ≤ 4 buttons).
 */
export function splitTools(shown: readonly EditorTool[], ctx: Pick<EditorContextValue, "state">): ToolSplit {
  const kind = selectionKind(ctx.state.selection);
  const primary: EditorTool[] = [];
  const more: EditorTool[] = [];
  for (const t of shown) {
    if (toolTier(t, kind) === "primary" && primary.length < MAX_PRIMARY_TOOLS) primary.push(t);
    else more.push(t);
  }
  if (more.length === 1) return { primary: [...primary, more[0]], more: [] };
  return { primary, more };
}

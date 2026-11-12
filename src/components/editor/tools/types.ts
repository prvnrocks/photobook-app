// Editor toolbar extension point (M5 Task 8). See ./registry.ts for how to add a tool.

import type { ComponentType } from "react";
import type { SelectionKind } from "@/lib/editor/store";
import type { EditorContextValue } from "../editor-context";

/** When a tool shows: for the current selection kind ("none" = nothing selected). */
export type ToolScope = SelectionKind;

/**
 * Where a tool sits in the simple toolbar (M13): "primary" = a big button in the row (at most 3 per
 * selection), "more" = inside the "More" sheet (always ≤ 2 taps away).
 */
export type ToolTier = "primary" | "more";

export interface EditorPanelProps {
  ctx: EditorContextValue;
  /** Close the panel (keeps the selection). */
  close(): void;
}

export interface EditorTool {
  /** Stable id, also used as data-testid suffix: `editor-tool-<id>`. */
  id: string;
  /** Short button label in plain words (≤ ~12 chars fits 4 buttons at 375 px). */
  label: string;
  /** lucide-react icon (or any component taking className). */
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  /** Selection kinds the tool shows for, or "always". */
  scopes: readonly ToolScope[] | "always";
  /**
   * Toolbar tier (default "more"): one tier for every scope, or per selection kind — e.g. Layout is
   * primary with nothing selected but sits in More when a photo is selected. See registry.splitTools.
   */
  tier?: ToolTier | Partial<Record<ToolScope, ToolTier>>;
  /** Sort key, ascending (default 100). Built-in convention: slot 10–29, caption 30–49, cover 50–69, page/book 70–99. */
  order?: number;
  /**
   * The tool changes the doc (default true): hidden in read-only mode. Set false for tools that
   * only look (e.g. a preview) or that explain the limit (e.g. upgrade sheet).
   */
  editsDoc?: boolean;
  /** Extra visibility rule (e.g. "only for layouts with a caption area"). */
  isAvailable?(ctx: EditorContextValue): boolean;
  /** Show but disable (e.g. Add page at the page limit). */
  isDisabled?(ctx: EditorContextValue): boolean;
  /**
   * Navigation entry (e.g. "See all photos" → review): rendered as a link to this app path instead
   * of a button; run/Panel are ignored. Use editsDoc: false for links that only look.
   */
  href?(ctx: EditorContextValue): string;
  /** Immediate action on tap. If Panel is also set, run() is called and then the Panel opens. */
  run?(ctx: EditorContextValue): void;
  /** Panel content: bottom sheet on mobile, side panel on desktop. */
  Panel?: ComponentType<EditorPanelProps>;
  /** Panel heading (defaults to label). */
  panelTitle?: string;
  /**
   * Mobile: dock the panel under the page (no backdrop) instead of a bottom sheet over it, so the
   * page stays visible while the tool previews its edits live (e.g. Background).
   */
  dockOnMobile?: boolean;
  /** Open the Panel as soon as the selection enters one of `scopes` (e.g. caption editor on caption tap). */
  openOnSelect?: boolean;
}

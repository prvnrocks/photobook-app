// Chapter description tools (M30 T13, D-090): the descriptors only — they stay in the editor's
// first-load chunk so the toolbar can list the tools; both panels (./chapter-description-panel.tsx)
// are loaded lazily in one chunk (M30 review, D-091).
// - chapterDescriptionTool: opens when the description area is tapped on the page.
// - aiDescriptionTool: the shared AI menu with Rewrite / Shorter / Translate.

import { Sparkles, Type } from "lucide-react";
import { lazyPanel } from "./lazy-panel";
import type { EditorTool } from "./types";

export const DESCRIPTION_TOOL_ID = "description";
export const AI_DESCRIPTION_TOOL_ID = "ai-description";

export const chapterDescriptionTool: EditorTool = {
  id: DESCRIPTION_TOOL_ID,
  label: "Edit",
  icon: Type,
  scopes: ["description"],
  order: 30,
  tier: "primary",
  openOnSelect: true,
  panelTitle: "About this chapter",
  // Placeholder ≈ the panel at 375 px: four-line field, counter, hint, AI button.
  Panel: lazyPanel(() => import("./chapter-description-panel").then((m) => m.ChapterDescriptionPanel), "min-h-56"),
};

export const aiDescriptionTool: EditorTool = {
  id: AI_DESCRIPTION_TOOL_ID,
  label: "AI help",
  icon: Sparkles,
  scopes: ["description"],
  order: 31,
  tier: "primary",
  panelTitle: "AI writing help",
  Panel: lazyPanel(() => import("./chapter-description-panel").then((m) => m.AiDescriptionPanel), "min-h-36"),
};

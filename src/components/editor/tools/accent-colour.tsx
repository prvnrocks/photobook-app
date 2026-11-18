// Accent colour tool (M30 T13, D-090): the descriptor only — it stays in the editor's first-load
// chunk so the toolbar can list the tool; the swatch panel (./accent-colour-panel.tsx) is loaded
// lazily (M30 review, D-091). Absent for the four older styles (no colourways).

import { Droplet } from "lucide-react";
import { accentAvailable } from "@/lib/editor/accent";
import { lazyPanel } from "./lazy-panel";
import type { EditorTool } from "./types";

export const accentColourTool: EditorTool = {
  id: "accent",
  label: "Accent colour",
  icon: Droplet,
  // Next to Background, behind More: the row keeps its three tools (Layout or Cover style /
  // Background / Pages) on every page and for every style.
  scopes: ["none"],
  order: 23,
  tier: "more",
  panelTitle: "Accent colour",
  dockOnMobile: true,
  isAvailable: (ctx) => accentAvailable(ctx.state.doc),
  // Placeholder ≈ the panel at 375 px: two lines of hint + two rows of swatches.
  Panel: lazyPanel(() => import("./accent-colour-panel").then((m) => m.AccentColourPanel), "min-h-[11.75rem]"),
};

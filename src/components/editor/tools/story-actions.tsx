"use client";

// The "Story" tool (Task 8): one toolbar button on composed storybooks (doc.meta.story) that opens
// the Story actions sheet — Rewrite story · Change photo · Regenerate page · View chapters (+ the
// composer's "Things to check" and "Regenerate story"). The sheet is its own lazy chunk; this file
// only registers the button. Always visible on storybook pages (also read-only: View chapters only
// looks; each edit action checks ctx.readOnly itself).

import { BookHeart } from "lucide-react";
import { lazy, Suspense } from "react";
import type { EditorPanelProps, EditorTool } from "./types";

export const STORY_TOOL_ID = "story";

const Panel = lazy(() => import("./story-actions-panel").then((m) => ({ default: m.StoryActionsPanel })));

function StoryPanel(props: EditorPanelProps) {
  return (
    <Suspense
      fallback={
        <p className="text-xs text-muted-foreground" role="status">
          Loading…
        </p>
      }
    >
      <Panel {...props} />
    </Suspense>
  );
}

export const storyActionsTool: EditorTool = {
  id: STORY_TOOL_ID,
  label: "Story",
  icon: BookHeart,
  scopes: "always",
  // first in the row with nothing selected or a story text selected; in More next to photo tools
  tier: { none: "primary", text: "primary", slot: "more", caption: "more", description: "more", cover: "more" },
  order: 5,
  editsDoc: false,
  panelTitle: "Your story",
  isAvailable: (ctx) => !!ctx.state.doc.meta?.story,
  Panel: StoryPanel,
};

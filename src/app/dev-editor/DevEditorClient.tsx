"use client";

// Mounts the real EditorShell with fixture data, a stubbed save and a few demo tools that
// exercise the toolbar extension point (dev-only route).

import { Eraser, PanelBottom, Type } from "lucide-react";
import { useState } from "react";
import { EditorShell } from "@/components/editor/EditorShell";
import type { EditorTool } from "@/components/editor/tools/types";
import { replacePhoto, setCover } from "@/lib/book/edit-ops";
import { devEditorData, devTransport, type DevSaveMode } from "@/lib/editor/dev-fixture";

const DEV_TOOLS: EditorTool[] = [
  {
    id: "dev-clear",
    label: "Clear",
    icon: Eraser,
    scopes: ["slot"],
    order: 10,
    run: ({ state, actions }) => {
      const sel = state.selection;
      if (sel?.kind === "slot") actions.edit((d) => replacePhoto(d, sel.pageIdx, sel.slotIdx, null));
    },
  },
  {
    id: "dev-title",
    label: "Title +",
    icon: Type,
    scopes: "always",
    order: 70,
    run: ({ actions }) => actions.edit((d) => setCover(d, { title: `${d.cover.title}!` })),
  },
  {
    id: "dev-panel",
    label: "Panel",
    icon: PanelBottom,
    scopes: "always",
    order: 80,
    editsDoc: false,
    Panel: ({ ctx }) => (
      <p className="text-sm">
        Demo panel. Page: {String(ctx.state.page)} · selection: {ctx.state.selection?.kind ?? "none"}
      </p>
    ),
  },
];

export function DevEditorClient({ mode }: { mode: DevSaveMode }) {
  const [data] = useState(() => devEditorData(mode));
  const [transport] = useState(() => devTransport(mode));
  return <EditorShell data={data} transport={transport} tools={DEV_TOOLS} backHref="/dev-editor" />;
}

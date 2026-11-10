"use client";

// Mounts the real EditorShell with fixture data, a stubbed save and a few demo tools that
// exercise the toolbar extension point (dev-only route).

import { Eraser, PanelBottom, Type } from "lucide-react";
import { Suspense, useState } from "react";
import { EditorShell } from "@/components/editor/EditorShell";
import { EDITOR_TOOLS } from "@/components/editor/tools/registry";
import type { EditorTool } from "@/components/editor/tools/types";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { replacePhoto, setCover } from "@/lib/book/edit-ops";
import type { BookFormat } from "@/lib/book/types";
import { devEditorData, devTransport, type DevAiMode, type DevSaveMode } from "@/lib/editor/dev-fixture";
import { withDevPagesData } from "@/lib/editor/dev-pages-fixture";

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

/** Real registered tools + the demo tools. */
const TOOLS: EditorTool[] = [...EDITOR_TOOLS, ...DEV_TOOLS];

export function DevEditorClient({
  mode,
  ai = "off",
  pages = null,
  published = false,
  paid = false,
  format = "A5_PORTRAIT",
  paymentsEnabled = false,
}: {
  mode: DevSaveMode;
  ai?: DevAiMode;
  pages?: number | null;
  published?: boolean;
  paid?: boolean;
  format?: BookFormat;
  paymentsEnabled?: boolean;
}) {
  const [data] = useState(() => {
    const fixture = withDevPagesData(devEditorData(mode, ai), pages);
    const base = format === fixture.doc.format ? fixture : { ...fixture, doc: { ...fixture.doc, format } };
    const d = paid ? { ...base, book: { ...base.book, isPaid: true, maxPages: 100 } } : base;
    return published ? { ...d, publishedRev: d.docRev } : d;
  });
  const [transport] = useState(() => devTransport(mode));
  return (
    <>
      <EditorShell data={data} transport={transport} tools={TOOLS} backHref="/dev-editor" paymentsEnabled={paymentsEnabled} />
      <Suspense fallback={null}>
        <UpgradeCancelledNotice floating />
      </Suspense>
    </>
  );
}

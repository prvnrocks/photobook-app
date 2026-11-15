"use client";

// Mounts the real EditorShell with fixture data, a stubbed save and a few demo tools that
// exercise the toolbar extension point (dev-only route).

import { Eraser, PanelBottom, Type } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { EditorShell } from "@/components/editor/EditorShell";
import type { EditorTool } from "@/components/editor/tools/types";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import type { BookDoc } from "@/lib/book/types";
import type { AiSummary } from "@/lib/editor/ai-summary";
import { devTransport, type DevSaveMode } from "@/lib/editor/dev-fixture";
import type { EditorShellData } from "@/lib/editor/types";
import type { DevEditorState } from "./dev-states";

// Demo edits inlined (not @/lib/book/edit-ops): a dev-route import of an editor module keeps webpack
// from concatenating it into the editor's first-load chunk (M22 size trim). Dev-only, minimal.
function devClearSlot(d: BookDoc, pageIdx: number, slotIdx: number): BookDoc {
  const page = d.pages[pageIdx];
  if (!page?.slots[slotIdx] || page.slots[slotIdx].photoId === null) return d;
  const slots = page.slots.map((sl, i) => (i === slotIdx ? { photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } } : sl));
  return { ...d, pages: d.pages.map((p, i) => (i === pageIdx ? { ...p, slots } : p)) };
}

const DEV_TOOLS: EditorTool[] = [
  {
    id: "dev-clear",
    label: "Clear",
    icon: Eraser,
    scopes: ["slot"],
    order: 10,
    run: ({ state, actions }) => {
      const sel = state.selection;
      if (sel?.kind === "slot") actions.edit((d) => devClearSlot(d, sel.pageIdx, sel.slotIdx));
    },
  },
  {
    id: "dev-title",
    label: "Title +",
    icon: Type,
    scopes: "always",
    order: 70,
    run: ({ actions }) => actions.edit((d) => ({ ...d, cover: { ...d.cover, title: `${d.cover.title}!` } })),
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

// Real registered tools + these demo tools (EditorShell's extraTools: this file must not import the
// tool registry or @/lib/editor/ai-summary — see ./dev-states.ts).

export function DevEditorClient({
  mode,
  data,
  summary = null,
  paymentsEnabled = false,
  bg = false,
  state = null,
}: {
  mode: DevSaveMode;
  /** Fixture data + AI summary, built on the server page (devEditorFixture in ./dev-states.ts). */
  data: EditorShellData;
  summary?: AiSummary | null;
  paymentsEnabled?: boolean;
  /** `?bg=1`: uuid background photos + the real save validator in the stub transport (M10a A8). */
  bg?: boolean;
  /** `?state=` named screenshot state (./dev-states.ts); the save mode is already adjusted by the page. */
  state?: DevEditorState | null;
}) {
  const [transport] = useState(() =>
    devTransport(
      mode,
      bg ? { validate: { photoIds: new Set(data.photos.map((p) => p.id)), maxPages: data.book.maxPages, savedDoc: data.doc } } : {},
    ),
  );
  // `?state=conflict`: the banner needs a save — make one harmless edit ("Title +") once hydrated.
  useEffect(() => {
    if (state !== "conflict") return;
    const click = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
    const t = window.setTimeout(() => {
      if (document.querySelector('[data-testid="editor-tool-dev-title"]')) click("editor-tool-dev-title");
      else {
        click("editor-more");
        window.setTimeout(() => click("editor-tool-dev-title"), 50);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <>
      <EditorShell data={data} transport={transport} extraTools={DEV_TOOLS} backHref="/dev-editor" paymentsEnabled={paymentsEnabled} aiSummary={summary} />
      <Suspense fallback={null}>
        <UpgradeCancelledNotice floating />
      </Suspense>
    </>
  );
}

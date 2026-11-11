"use client";

// Replace (M5 Task 9): photo picker for a page slot or the cover photo.
// Tabs "In book / Not used / Dropped by AI" (src/lib/editor/photo-picker.ts). Picking a photo
// that is already on another page swaps the two slots (replacePhoto does it); the cover uses
// setCover. Placing an AI-dropped photo keeps it — the server marks it kept on save (D-037 4).
// M11 T14: docked under the page on phones (dockOnMobile) so the spot being filled stays visible.

import { ImageIcon, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { replacePhoto, setCover } from "@/lib/book/edit-ops";
import { defaultPickerTab, groupPickerPhotos, PICKER_TABS, type PickerTab } from "@/lib/editor/photo-picker";
import type { EditorShellPhoto } from "@/lib/editor/types";
import { cn } from "@/lib/utils";
import type { EditorContextValue } from "../editor-context";
import type { EditorPanelProps, EditorTool } from "./types";

type Target = { kind: "slot"; pageIdx: number; slotIdx: number; current: string | null } | { kind: "cover"; current: string | null };

/** What the picker replaces for the current selection, or null (nothing pickable selected). */
export function pickerTarget(ctx: Pick<EditorContextValue, "state">): Target | null {
  const sel = ctx.state.selection;
  const doc = ctx.state.doc;
  if (sel?.kind === "cover") return sel.part === "photo" ? { kind: "cover", current: doc.cover.photoId } : null;
  if (sel?.kind === "slot") {
    const slot = doc.pages[sel.pageIdx]?.slots[sel.slotIdx];
    return slot ? { kind: "slot", pageIdx: sel.pageIdx, slotIdx: sel.slotIdx, current: slot.photoId } : null;
  }
  return null;
}

export function PhotoPickerPanel({ ctx, close }: EditorPanelProps) {
  const target = pickerTarget(ctx);
  const groups = useMemo(() => groupPickerPhotos(ctx.photos.photos, ctx.state.doc), [ctx.photos.photos, ctx.state.doc]);
  const [tab, setTab] = useState<PickerTab>(() => defaultPickerTab(groups));
  if (!target) return null;

  const choose = (photoId: string | null) => {
    if (ctx.readOnly) return;
    if (target.kind === "cover") {
      ctx.actions.edit((d) => setCover(d, { photoId }), { select: { kind: "cover", part: "photo" } });
    } else {
      const { pageIdx, slotIdx } = target;
      ctx.actions.edit((d) => replacePhoto(d, pageIdx, slotIdx, photoId), { select: { kind: "slot", pageIdx, slotIdx } });
    }
    close();
  };

  const list = groups[tab];
  const meta = PICKER_TABS.find((t) => t.id === tab)!;

  return (
    <div className="flex flex-col gap-3" data-testid="photo-picker">
      <div role="tablist" aria-label="Photos" className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1">
        {PICKER_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "min-h-11 min-w-0 rounded-md px-1 text-xs leading-tight font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === t.id ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`picker-tab-${t.id}`}
          >
            {t.label} <span className="tabular-nums">({groups[t.id].length})</span>
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground" data-testid="picker-empty">
          {meta.empty}
        </p>
      ) : (
        <ul role="tabpanel" aria-label={meta.label} className="grid grid-cols-4 gap-2 lg:grid-cols-3">
          {list.map((p) => (
            <li key={p.id}>
              <PhotoTile
                photo={p}
                current={p.id === target.current}
                hint={tab === "inBook" && target.kind === "slot" && p.id !== target.current ? "Swap" : null}
                onPick={() => choose(p.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {target.current !== null ? (
        <button
          type="button"
          onClick={() => choose(null)}
          className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-destructive-border text-sm font-medium text-destructive outline-none hover:bg-destructive-soft focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="picker-remove"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {target.kind === "cover" ? "Remove cover photo" : "Remove photo from this spot"}
        </button>
      ) : null}
    </div>
  );
}

function PhotoTile({ photo, current, hint, onPick }: { photo: EditorShellPhoto; current: boolean; hint: string | null; onPick(): void }) {
  const src = photo.thumbUrl ?? photo.webUrl;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={current}
      aria-label={current ? "Current photo" : hint === "Swap" ? "Swap with this photo" : "Use this photo"}
      className={cn(
        "relative block aspect-square w-full overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        current && "ring-4 ring-primary",
      )}
      data-testid="picker-photo"
      data-photo-id={photo.id}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : (
        <ImageIcon className="absolute inset-0 m-auto size-6 text-muted-foreground" aria-hidden="true" />
      )}
      {current || hint ? (
        <span className="absolute inset-x-0 bottom-0 bg-primary/75 py-0.5 text-center text-[11px] font-medium text-primary-foreground">
          {current ? "Current" : hint}
        </span>
      ) : null}
    </button>
  );
}

export const photoPickerTool: EditorTool = {
  id: "replace",
  label: "Replace",
  icon: ImageIcon,
  scopes: ["slot", "cover"],
  order: 10,
  panelTitle: "Choose a photo",
  // M11: the page stays visible above the panel on phones while choosing.
  dockOnMobile: true,
  isAvailable: (ctx) => pickerTarget(ctx) !== null,
  Panel: PhotoPickerPanel,
};

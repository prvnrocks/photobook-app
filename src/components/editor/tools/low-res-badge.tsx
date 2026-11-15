"use client";

// Low-resolution warning on a photo slot (D-037 9): below 150 dpi effective at A5 for the photo's
// ORIGINAL size, layout slot and zoom. Never blocks anything; tap shows why.
// Rendered by EditablePage inside each slot overlay (edit mode only).
// M22 T6a (D-074): warm gold warning dot with an emerald focus outline; message on an emerald card.

import { TriangleAlert } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { isSlotLowRes } from "@/lib/book/resolution";
import type { BookDoc } from "@/lib/book/types";
import type { EditorPosition } from "@/lib/editor/store";
import type { EditorShellPhoto } from "@/lib/editor/types";
import { useEditor } from "../editor-context";

export const LOW_RES_MESSAGE = "This photo may look blurry when printed";

/** True when the photo in `page`/`slotIdx` would print below 150 dpi (unknown size → false). */
export function slotIsLowRes(
  doc: BookDoc,
  page: EditorPosition,
  slotIdx: number,
  byId: ReadonlyMap<string, Pick<EditorShellPhoto, "width" | "height">>,
): boolean {
  if (page === "cover") {
    const p = doc.cover.photoId !== null ? byId.get(doc.cover.photoId) : undefined;
    return p ? isSlotLowRes(p, doc.cover.layout, 0, 1, doc.format) : false;
  }
  const pg = doc.pages[page];
  const slot = pg?.slots[slotIdx];
  if (!pg || !slot || slot.photoId === null) return false;
  const p = byId.get(slot.photoId);
  return p ? isSlotLowRes(p, pg.layout, slotIdx, slot.crop.zoom, doc.format) : false;
}

export function LowResBadge({ page, slotIdx }: { page: EditorPosition; slotIdx: number }) {
  const { state, photos } = useEditor();
  const [open, setOpen] = useState(false);
  const low = slotIsLowRes(state.doc, page, slotIdx, photos.byId);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 4000);
    return () => clearTimeout(t);
  }, [open]);

  if (!low) return null;
  const toggle = (e: MouseEvent) => {
    e.stopPropagation(); // don't (de)select the slot underneath
    setOpen((o) => !o);
  };
  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={`Low resolution: ${LOW_RES_MESSAGE}`}
        aria-expanded={open}
        className="absolute top-0 left-0 z-10 flex size-11 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
        data-testid="low-res-badge"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-[#f3c969] text-[#2f2a14] shadow-[0_4px_10px_-4px_rgb(14_59_46/0.7)] ring-2 ring-white">
          <TriangleAlert className="size-4" aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <p
          role="status"
          className="pointer-events-none absolute top-11 right-1 left-1 z-10 rounded-lg bg-[#0e3b2e]/95 px-2.5 py-1.5 text-xs font-medium text-[#f2e8d8] shadow-[0_8px_18px_-10px_rgb(0_0_0/0.6)]"
          data-testid="low-res-message"
        >
          {LOW_RES_MESSAGE}
        </p>
      ) : null}
    </>
  );
}

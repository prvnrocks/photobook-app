"use client";

// The big editor page: the shared <BookPage> in "edit" mode plus tap targets for selection.
// - Photo slot → selects { slot } (cover photo → { cover, photo }); tap again deselects.
// - Caption area → selects { caption } (placeholder "Tap to add a caption" when empty).
// - Cover title/subtitle area → selects { cover, text }.
// - Tap on empty page space → clears the selection.
// Read-only: no tap targets, static captions.
// Cover text → CoverTextTarget overlay (Task 10; cover-text tool opens on select).
// Task 9 can add slot badges (low-res etc.) inside SlotOverlay; Task 10 replaces CaptionTarget's
// content (or opens its panel via a tool with openOnSelect).

import type { MouseEvent } from "react";
import { BookPage, type RenderCaption } from "@/components/book/BookPage";
import { INK_TEXT } from "@/components/book/PageParts";
import type { Ink } from "@/lib/design/backgrounds";
import { CAPTION_LINE_HEIGHT, captionSizeCqw, resolveBackground } from "@/lib/book/render";
import type { Caption } from "@/lib/book/types";
import type { EditorPosition, EditorSelection } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { useEditor } from "./editor-context";
import { LowResBadge } from "./tools/low-res-badge";

function sameSelection(a: EditorSelection, b: EditorSelection): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "slot" && b.kind === "slot") return a.pageIdx === b.pageIdx && a.slotIdx === b.slotIdx;
  if (a.kind === "caption" && b.kind === "caption") return a.pageIdx === b.pageIdx;
  if (a.kind === "cover" && b.kind === "cover") return a.part === b.part;
  return false;
}

export function EditablePage({ page, priority }: { page: EditorPosition; priority?: boolean }) {
  const { state, actions, photos, readOnly, book } = useEditor();
  const { doc, selection } = state;

  const toggle = (sel: EditorSelection) => (e: MouseEvent) => {
    e.stopPropagation();
    actions.select(sameSelection(selection, sel) ? null : sel);
  };

  // `owner` = the doc page holding the slot/caption (a spread's right half shows its left page's).
  const slotSel = (slotIdx: number, owner: number | "cover" = page): EditorSelection =>
    owner === "cover" ? { kind: "cover", part: "photo" } : { kind: "slot", pageIdx: owner, slotIdx };

  const label = page === "cover" ? "cover" : `page ${page + 1}`;

  const onBackground = (e: MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const target = e.target as HTMLElement;
    if (page === "cover" && target.closest("[data-cover-text]")) {
      actions.select(sameSelection(selection, { kind: "cover", part: "text" }) ? null : { kind: "cover", part: "text" });
      return;
    }
    if (selection !== null) actions.select(null);
  };

  const coverTextSelected = page === "cover" && sameSelection(selection, { kind: "cover", part: "text" });

  return (
    // The wrapper only receives taps that no slot/caption target handled (they stop propagation).
    <div
      onClick={onBackground}
      className={cn(
        "relative w-full shadow-md ring-1 ring-black/5",
        coverTextSelected && "[&_[data-cover-text]]:outline-4 [&_[data-cover-text]]:outline-solid [&_[data-cover-text]]:outline-primary [&_[data-cover-text]]:-outline-offset-4",
      )}
      data-testid="editor-page"
      data-position={String(page)}
    >
      <BookPage
        doc={doc}
        page={page}
        mode="edit"
        photos={photos.web}
        captionLang={book.captionLang}
        priority={priority}
        renderSlotOverlay={
          readOnly
            ? undefined
            : (slotIdx, owner) => (
                <>
                  <SlotOverlay
                    selected={sameSelection(selection, slotSel(slotIdx, owner))}
                    label={`Photo ${slotIdx + 1} on ${label}`}
                    onClick={toggle(slotSel(slotIdx, owner))}
                  />
                  <LowResBadge page={owner} slotIdx={slotIdx} />
                </>
              )
        }
        renderCoverTextOverlay={
          readOnly || page !== "cover"
            ? undefined
            : () => (
                <CoverTextTarget
                  empty={!doc.cover.title && !doc.cover.subtitle}
                  ink={resolveBackground(doc).ink}
                  selected={coverTextSelected}
                  onClick={toggle({ kind: "cover", part: "text" })}
                />
              )
        }
        renderCaption={
          readOnly || page === "cover"
            ? undefined
            : (caption, model, ink, owner) => (
                <CaptionTarget
                  caption={caption}
                  model={model}
                  ink={ink}
                  selected={sameSelection(selection, { kind: "caption", pageIdx: owner })}
                  onClick={toggle({ kind: "caption", pageIdx: owner })}
                />
              )
        }
      />
    </div>
  );
}

function SlotOverlay({ selected, label, onClick }: { selected: boolean; label: string; onClick: (e: MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        "absolute inset-0 block cursor-pointer outline-none focus-visible:ring-4 focus-visible:ring-primary/60 focus-visible:ring-inset",
        selected && "bg-primary/10 ring-4 ring-primary ring-inset",
      )}
      data-testid="slot-target"
      data-selected={selected ? "true" : undefined}
    />
  );
}

function CoverTextTarget({
  empty,
  ink,
  selected,
  onClick,
}: {
  empty: boolean;
  ink: Ink;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={empty ? "Add a cover title" : "Edit cover title"}
      className={cn(
        "absolute inset-0 flex cursor-pointer items-center justify-center outline-none focus-visible:ring-4 focus-visible:ring-primary/60 focus-visible:ring-inset",
        !selected && "hover:bg-black/5",
      )}
      data-testid="cover-text-target"
      data-selected={selected ? "true" : undefined}
    >
      {empty ? (
        <span className={cn("italic", ink === "light" ? "text-white/70" : "text-neutral-400")} style={{ fontSize: "4cqw" }}>
          Tap to add a title
        </span>
      ) : null}
    </button>
  );
}

function CaptionTarget({
  caption,
  model,
  ink,
  selected,
  onClick,
}: {
  caption: Caption | null;
  model: RenderCaption;
  /** Page background's text ink (M10a A6): same colour as the static caption. */
  ink: Ink;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={caption ? undefined : "Add a caption"}
      className={cn(
        "flex h-full w-full cursor-pointer flex-col justify-center rounded-sm outline-none focus-visible:ring-4 focus-visible:ring-primary/60",
        selected ? "ring-4 ring-primary ring-inset" : "hover:bg-black/5",
      )}
      data-testid="caption-target"
      data-selected={selected ? "true" : undefined}
    >
      {caption ? (
        <span
          dir="auto"
          lang={model.lang}
          className={cn("block w-full whitespace-pre-line break-words", INK_TEXT.caption[ink])}
          style={{
            fontFamily: model.fontFamily,
            textAlign: model.align,
            fontSize: `${captionSizeCqw(model)}cqw`,
            lineHeight: CAPTION_LINE_HEIGHT,
            ...model.typography,
          }}
          data-testid="page-caption"
        >
          {caption.text}
        </span>
      ) : (
        <span
          className={cn("block w-full text-center italic", ink === "light" ? "text-white/70" : "text-neutral-400")}
          style={{ fontSize: `${captionSizeCqw(model)}cqw`, lineHeight: CAPTION_LINE_HEIGHT }}
        >
          Tap to add a caption
        </span>
      )}
    </button>
  );
}

// Book cover: cover photo + title + subtitle, positioned by the "cover" layout data.
// Rendered through <BookPage page="cover"> in editor, viewer and print; can also be used directly.

import type { ReactNode } from "react";
import { backgroundColor, coverRenderModel, type RenderPhotos } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { Box, PageFrame, PhotoSlot, type BookRenderMode } from "./PageParts";

export type BookCoverProps = {
  doc: BookDoc;
  mode: BookRenderMode;
  photos: RenderPhotos;
  /** Book caption language (books.caption_lang); picks lang/fonts for text without letters yet. */
  captionLang?: string;
  /** Edit mode only: rendered inside the cover photo slot (always slot index 0). */
  renderSlotOverlay?: (slotIdx: number) => ReactNode;
  /** Edit mode only: rendered inside the cover text area (absolute-position it with `inset-0`). */
  renderTextOverlay?: () => ReactNode;
  className?: string;
  /** Load the cover photo eagerly with high fetch priority (above the fold). */
  priority?: boolean;
};

export function BookCover({ doc, mode, photos, captionLang, renderSlotOverlay, renderTextOverlay, className, priority }: BookCoverProps) {
  const m = coverRenderModel(doc, photos, captionLang, { bleed: mode === "print" });
  return (
    <PageFrame
      background={backgroundColor(doc.style.background)}
      mode={mode}
      className={className}
      data={{ "data-page": "cover", "data-layout": m.layoutId }}
    >
      {m.slot ? (
        <PhotoSlot
          slot={m.slot}
          mode={mode}
          priority={priority}
          overlay={renderSlotOverlay?.(0)}
        />
      ) : null}
      {m.textRect ? (
        <Box
          rect={m.textRect}
          className="flex flex-col items-center justify-center overflow-hidden text-center text-neutral-900"
          data={{ "data-cover-text": "true" }}
        >
          {m.title.text ? (
            <h2
              dir="auto"
              lang={m.title.lang}
              className="w-full font-semibold break-words"
              style={{ fontFamily: m.title.fontFamily, fontSize: `${m.title.sizeCqw}cqw`, lineHeight: 1.15 }}
              data-testid="cover-title"
            >
              {m.title.text}
            </h2>
          ) : null}
          {m.subtitle.text ? (
            <p
              dir="auto"
              lang={m.subtitle.lang}
              className="w-full break-words text-neutral-600"
              style={{ fontFamily: m.subtitle.fontFamily, fontSize: "3cqw", lineHeight: 1.3, marginTop: "1.5cqw" }}
              data-testid="cover-subtitle"
            >
              {m.subtitle.text}
            </p>
          ) : null}
          {mode === "edit" ? renderTextOverlay?.() : null}
        </Box>
      ) : null}
    </PageFrame>
  );
}

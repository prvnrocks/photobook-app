// The single shared page renderer. Editor, flipbook viewer and PDF (/print) all render through
// this component from the book document JSON. Layout positions are data (src/lib/layouts), all
// maths lives in src/lib/book/render.ts; this file only maps the render model to markup.
// No hooks / "use client": works in server components (viewer, print) and client ones (editor).

import type { ReactNode } from "react";
import {
  CAPTION_FONT_SIZE_CQW,
  CAPTION_LINE_HEIGHT,
  pageRenderModel,
  type RenderCaption,
  type RenderPhotos,
} from "@/lib/book/render";
import type { BookDoc, Caption } from "@/lib/book/types";
import { BookCover } from "./BookCover";
import { Box, PageFrame, PhotoSlot, type BookRenderMode } from "./PageParts";

export type { BookRenderMode } from "./PageParts";
export type { RenderCaption, RenderPhoto, RenderPhotos } from "@/lib/book/render";

export type BookPageProps = {
  doc: BookDoc;
  /** Index into `doc.pages`, or "cover". */
  page: number | "cover";
  mode: BookRenderMode;
  /** photoId → signed web URL + stored pixel size (original's dims; aspect is what matters here). */
  photos: RenderPhotos;
  /** Book caption language (books.caption_lang, default "en"): lang/font for text without letters. */
  captionLang?: string;
  /** Edit mode only: rendered inside each photo slot (absolute-position it with `inset-0`). */
  renderSlotOverlay?: (slotIdx: number) => ReactNode;
  /**
   * Edit mode only: replaces the static caption inside the layout's caption area (called for
   * every layout that HAS a caption area, with null when the page has no caption yet). The
   * second argument is the caption's render model (resolved font family, lang, align) so an
   * editable caption can look exactly like the static one.
   */
  renderCaption?: (caption: Caption | null, model: RenderCaption) => ReactNode;
  /** Edit mode only, cover only: rendered inside the cover text area (absolute, `inset-0`). */
  renderCoverTextOverlay?: () => ReactNode;
  className?: string;
  /** First visible page(s): eager load + high fetch priority. Print mode is always eager. */
  priority?: boolean;
};

export function BookPage(props: BookPageProps) {
  const { doc, page, mode, photos, captionLang, renderSlotOverlay, renderCaption, renderCoverTextOverlay, className, priority } =
    props;
  if (page === "cover") {
    return (
      <BookCover
        doc={doc}
        mode={mode}
        photos={photos}
        captionLang={captionLang}
        renderSlotOverlay={renderSlotOverlay}
        renderTextOverlay={renderCoverTextOverlay}
        className={className}
        priority={priority}
      />
    );
  }

  const m = pageRenderModel(doc, page, photos, captionLang);
  if (!m) {
    return <PageFrame background={doc.style.background} mode={mode} className={className} data={{ "data-page": "missing" }} />;
  }

  const c = m.caption;
  const editCaption = mode === "edit" && renderCaption && c ? renderCaption(c.caption, c) : null;

  return (
    <PageFrame
      background={doc.style.background}
      mode={mode}
      className={className}
      data={{ "data-page": String(page), "data-page-id": m.pageId, "data-layout": m.layoutId }}
    >
      {m.slots.map((slot) => (
        <PhotoSlot
          key={slot.index}
          slot={slot}
          mode={mode}
          priority={priority}
          overlay={renderSlotOverlay?.(slot.index)}
        />
      ))}
      {c && (editCaption !== null || c.text) ? (
        <Box
          rect={c.rect}
          className="flex flex-col justify-center overflow-hidden"
          data={{ "data-caption-area": "true" }}
        >
          {editCaption ?? (
            <p
              dir="auto"
              lang={c.lang}
              className="w-full whitespace-pre-line break-words text-neutral-800"
              style={{ fontFamily: c.fontFamily, textAlign: c.align, fontSize: `${CAPTION_FONT_SIZE_CQW}cqw`, lineHeight: CAPTION_LINE_HEIGHT }}
              data-testid="page-caption"
            >
              {c.text}
            </p>
          )}
        </Box>
      ) : null}
    </PageFrame>
  );
}

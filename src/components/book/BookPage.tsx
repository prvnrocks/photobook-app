// The single shared page renderer. Editor, flipbook viewer and PDF (/print) all render through
// this component from the book document JSON. Layout positions are data (src/lib/layouts), all
// maths lives in src/lib/book/render.ts; this file only maps the render model to markup.
// No hooks / "use client": works in server components (viewer, print) and client ones (editor).

import type { ReactNode } from "react";
import {
  CAPTION_LINE_HEIGHT,
  captionSizeCqw,
  pageRenderModel,
  resolveBackground,
  type RenderCaption,
  type RenderPhotos,
} from "@/lib/book/render";
import type { Ink } from "@/lib/design/backgrounds";
import type { BookDoc, Caption } from "@/lib/book/types";
import { BookCover } from "./BookCover";
import { Decorations } from "./Decoration";
import { BackgroundLayer, Box, INK_TEXT, PageFrame, PhotoSlot, TextPanel, type BookRenderMode } from "./PageParts";

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
  /**
   * Edit mode only: rendered inside each photo slot (absolute-position it with `inset-0`).
   * `ownerPage` = the doc.pages index whose `slots[slotIdx]` this is: the page itself, or for the
   * right half of a spread its left partner (spreads store every slot on the left page). Cover: "cover".
   */
  renderSlotOverlay?: (slotIdx: number, ownerPage: number | "cover") => ReactNode;
  /**
   * Edit mode only: replaces the static caption inside the layout's caption area (called for
   * every layout that HAS a caption area, with null when the page has no caption yet). The
   * second argument is the caption's render model (resolved font family, lang, align) so an
   * editable caption can look exactly like the static one. `ink` = the page background's text
   * colour family (INK_TEXT.caption[ink] is the static caption's class). `ownerPage` = the
   * doc.pages index that holds the caption (a spread's caption lives on its left page).
   */
  renderCaption?: (caption: Caption | null, model: RenderCaption, ink: Ink, ownerPage: number) => ReactNode;
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
        renderSlotOverlay={renderSlotOverlay ? (i) => renderSlotOverlay(i, "cover") : undefined}
        renderTextOverlay={renderCoverTextOverlay}
        className={className}
        priority={priority}
      />
    );
  }

  const m = pageRenderModel(doc, page, photos, captionLang, { bleed: mode === "print" });
  if (!m) {
    const bookBg = resolveBackground(doc, null, photos);
    return (
      <PageFrame
        background={bookBg.baseHex}
        layer={<BackgroundLayer bg={bookBg} mode={mode} format={doc.format} priority={priority} />}
        mode={mode}
        format={doc.format}
        className={className}
        data={{ "data-page": "missing" }}
      />
    );
  }

  // Each page (both spread halves too) shows its own background.
  const bg = resolveBackground(doc, doc.pages[page], photos);
  const c = m.caption;
  // Spread right half: slots + caption belong to the left page (m.spread.ownerIndex).
  const owner = m.spread ? (m.spread.ownerIndex ?? page) : page;
  const editCaption = mode === "edit" && renderCaption && c ? renderCaption(c.caption, c, bg.ink, owner) : null;
  const data: Record<`data-${string}`, string> = { "data-page": String(page), "data-page-id": m.pageId, "data-layout": m.layoutId };
  if (m.spread) data["data-spread-side"] = m.spread.side;

  return (
    <PageFrame
      background={bg.baseHex}
      layer={<BackgroundLayer bg={bg} mode={mode} format={doc.format} priority={priority} />}
      mode={mode}
      format={doc.format}
      className={className}
      data={data}
    >
      <Decorations items={m.decorations} layer="under" />
      {m.slots.map((slot) => (
        <PhotoSlot
          key={slot.index}
          slot={slot}
          mode={mode}
          priority={priority}
          overlay={renderSlotOverlay?.(slot.index, owner)}
        />
      ))}
      <Decorations items={m.decorations} layer="over" />
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
              className={`w-full whitespace-pre-line break-words ${INK_TEXT.caption[bg.ink]}`}
              style={{
                fontFamily: c.fontFamily,
                textAlign: c.align,
                fontSize: `${captionSizeCqw(c)}cqw`,
                lineHeight: CAPTION_LINE_HEIGHT,
                ...c.typography,
              }}
              data-testid="page-caption"
            >
              {c.text}
            </p>
          )}
        </Box>
      ) : null}
      {m.texts?.map((t, i) => <TextPanel key={i} panel={t} ink={bg.ink} />)}
    </PageFrame>
  );
}

// Book cover: cover photo + title + subtitle, positioned by the "cover" layout data.
// Rendered through <BookPage page="cover"> in editor, viewer and print; can also be used directly.

import type { ReactNode } from "react";
import { coverRenderModel, resolveBackground, scaleCqw, type RenderPhotos } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { Decorations } from "./Decoration";
import { BackgroundLayer, Box, INK_TEXT, PageFrame, PhotoSlot, SlicedPhotoSlot, TextPanel, type BookRenderMode } from "./PageParts";

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
  // The cover has no page entry, so no override: it always shows the book default background.
  const bg = resolveBackground(doc, null, photos);
  return (
    <PageFrame
      background={bg.baseHex}
      layer={<BackgroundLayer bg={bg} mode={mode} format={doc.format} priority={priority} />}
      mode={mode}
      format={doc.format}
      className={className}
      data={{ "data-page": "cover", "data-layout": m.layoutId }}
    >
      <Decorations items={m.decorations} layer="under" />
      {m.slot && m.slices ? (
        <SlicedPhotoSlot slot={m.slot} slices={m.slices} mode={mode} priority={priority} overlay={renderSlotOverlay?.(0)} />
      ) : m.slot ? (
        <PhotoSlot
          slot={m.slot}
          mode={mode}
          priority={priority}
          overlay={renderSlotOverlay?.(0)}
        />
      ) : null}
      <Decorations items={m.decorations} layer="over" />
      {m.panels ? (
        <>
          {/* Design-style cover (M10b): title + subtitle panels replace the stacked block. */}
          {m.panels.map((t, i) => (
            <TextPanel key={i} panel={t} ink={bg.ink} />
          ))}
          {m.textRect && mode === "edit" ? (
            <Box rect={m.textRect} data={{ "data-cover-text": "true" }}>
              {renderTextOverlay?.()}
            </Box>
          ) : null}
        </>
      ) : m.textRect ? (
        <Box
          rect={m.textRect}
          className={`flex flex-col items-center justify-center overflow-hidden text-center ${INK_TEXT.coverTitle[bg.ink]}`}
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
              className={`w-full break-words ${INK_TEXT.coverSubtitle[bg.ink]}`}
              style={{
                fontFamily: m.subtitle.fontFamily,
                fontSize: `${scaleCqw(3, m.textScale)}cqw`,
                lineHeight: 1.3,
                marginTop: `${scaleCqw(1.5, m.textScale)}cqw`,
              }}
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

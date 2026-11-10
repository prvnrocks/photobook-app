// The print document (M8 T5, D-050/D-052): sheets from..to of a book, each one <BookPage
// mode="print"> (sheetMm(doc.format): 154×216 / 216×154 mm incl. 3 mm bleed), one per PDF page. Used by the internal
// /print/[bookId] route and the dev-only /dev-print fixture so both render identical markup.
// Server component; <PrintReady> is the only client part. No app chrome, never a watermark.
// The wrapper re-points the renderer's font variables at static font files (./print-fonts.ts):
// variable fonts would be embedded as Type3 by Chromium.

import { BookPage } from "@/components/book/BookPage";
import type { RenderPhotos } from "@/lib/book/render";
import { sheetMm } from "@/lib/book/format";
import type { BookDoc, BookFormat } from "@/lib/book/types";
import type { PrintSheetTarget } from "@/lib/pdf/print-doc";
import { PRINT_FONT_CLASSES } from "./print-fonts";
import { PrintReady } from "./PrintReady";

/**
 * Page box = one sheet of `format` (sheetMm: portrait 154×216, landscape 216×154 mm), no margins;
 * one sheet per page, no break after the last. mergePdfs/printBoxes check the resulting MediaBox
 * orientation against doc.format (mismatch → merge_failed).
 */
export function printCss(format?: BookFormat | null): string {
  const sheet = sheetMm(format);
  return [
    `@page { size: ${sheet.w}mm ${sheet.h}mm; margin: 0; }`,
    "html, body { margin: 0; padding: 0; background: #fff; }",
    "[data-print-document] > [data-print-sheet] { break-after: page; page-break-after: always; }",
    "[data-print-document] > [data-print-sheet]:last-child { break-after: auto; page-break-after: auto; }",
  ].join("\n");
}

/** A5 portrait print CSS (M8 compat). Format-aware callers use printCss(doc.format). */
export const PRINT_CSS = printCss();

export function PrintDocument({
  doc,
  photos,
  captionLang,
  sheets,
}: {
  doc: BookDoc;
  /** photoId → print-asset URL + stored pixel size (see printRenderPhotos). */
  photos: RenderPhotos;
  captionLang: string;
  /** From printSheetTargets(doc.pages.length, from, to). */
  sheets: readonly PrintSheetTarget[];
}) {
  return (
    <>
      <style>{printCss(doc.format)}</style>
      <div data-print-document="" className={PRINT_FONT_CLASSES}>
        {sheets.map((t) => (
          <BookPage key={String(t)} doc={doc} page={t} mode="print" photos={photos} captionLang={captionLang} priority />
        ))}
      </div>
      <PrintReady />
    </>
  );
}

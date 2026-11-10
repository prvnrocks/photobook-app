// The print document (M8 T5, D-050/D-052): sheets from..to of a book, each one <BookPage
// mode="print"> (154×216 mm incl. 3 mm bleed), one per PDF page. Used by the internal
// /print/[bookId] route and the dev-only /dev-print fixture so both render identical markup.
// Server component; <PrintReady> is the only client part. No app chrome, never a watermark.

import { BookPage } from "@/components/book/BookPage";
import type { RenderPhotos } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { SHEET_MM } from "@/lib/layouts";
import type { PrintSheetTarget } from "@/lib/pdf/print-doc";
import { PrintReady } from "./PrintReady";

/** Page box = one sheet, no margins; one sheet per page, no break after the last. */
export const PRINT_CSS = [
  `@page { size: ${SHEET_MM.w}mm ${SHEET_MM.h}mm; margin: 0; }`,
  "html, body { margin: 0; padding: 0; background: #fff; }",
  "[data-print-document] > [data-print-sheet] { break-after: page; page-break-after: always; }",
  "[data-print-document] > [data-print-sheet]:last-child { break-after: auto; page-break-after: auto; }",
].join("\n");

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
      <style>{PRINT_CSS}</style>
      <div data-print-document="">
        {sheets.map((t) => (
          <BookPage key={String(t)} doc={doc} page={t} mode="print" photos={photos} captionLang={captionLang} priority />
        ))}
      </div>
      <PrintReady />
    </>
  );
}

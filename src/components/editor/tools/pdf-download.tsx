"use client";

// "PDF" tool (M8 T8): paid books get a toolbar entry with nothing selected (where free books see
// "Upgrade"), opening a sheet with <PdfDownload>. Pending saves are sent and awaited before the
// export starts, so the PDF has the latest edits (the server renders the saved doc, D-047).
// Closing the sheet stops polling; the server job keeps going and the next tap reuses it.

import { FileDown } from "lucide-react";
import { selectionKind } from "@/lib/editor/store";
import { PdfDownload } from "@/components/publish/PdfDownload";
import type { EditorPanelProps, EditorTool } from "./types";

export const PDF_TOOL_ID = "pdf";

export function PdfPanel({ ctx }: EditorPanelProps) {
  const { book, save } = ctx;
  const beforeStart = () => (save.settle ? save.settle() : save.flush());
  return (
    <div className="flex flex-col gap-3" data-testid="pdf-panel">
      <p className="text-sm text-muted-foreground">Download your book as a print-ready PDF. It includes your latest saved edits.</p>
      <PdfDownload
        bookId={book.id}
        isPaid={book.isPaid}
        paymentsEnabled={ctx.paymentsEnabled === true}
        returnTo={`/books/${book.id}/edit`}
        onBeforeStart={beforeStart}
      />
    </div>
  );
}

/** Toolbar entry: paid books only; visible with nothing selected, and whenever it is open. */
export const pdfDownloadTool: EditorTool = {
  id: PDF_TOOL_ID,
  label: "PDF",
  icon: FileDown,
  scopes: "always",
  order: 98,
  editsDoc: false,
  isAvailable: (ctx) => ctx.book.isPaid && (ctx.activeTool === PDF_TOOL_ID || selectionKind(ctx.state.selection) === "none"),
  Panel: PdfPanel,
  panelTitle: "Download PDF",
};

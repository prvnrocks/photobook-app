"use client";

// "PDF" tool (M8 T8): paid books get a toolbar entry with nothing selected (where free books see
// "Upgrade"), opening a sheet with <PdfDownload>. Pending saves are sent and awaited before the
// export starts, so the PDF has the latest edits (the server renders the saved doc, D-047).
// Closing the sheet stops polling; the server job keeps going and the next tap reuses it.

import { FileDown, FileText } from "lucide-react";
import { selectionKind } from "@/lib/editor/store";
import { PdfDownload, type PdfLook } from "@/components/publish/PdfDownload";
import { ED_CTA_EMERALD } from "../editor-classes";
import { TOOL_SECONDARY, TOOL_WELL_SURFACE } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

export const PDF_TOOL_ID = "pdf";

// M22 T6b (D-074): the share page's PDF card at editor density — emerald icon chip + body, emerald
// solid download, outlined emerald "Download again", ivory progress well. No gold (Share is the gold).
// Paid state is still only book.isPaid from the server (the tool isn't offered otherwise).
const PDF_EDITOR_LOOK: PdfLook = {
  primary: `${ED_CTA_EMERALD} w-full py-2 whitespace-normal sm:w-auto sm:self-start`,
  outline: `${TOOL_SECONDARY} w-full sm:w-auto sm:self-start`,
  well: TOOL_WELL_SURFACE,
};
const ICON_CHIP =
  "flex size-10 shrink-0 items-center justify-center rounded-full bg-[#e6efe9] text-[#0e3b2e] ring-1 ring-[#0e3b2e]/10";

export function PdfPanel({ ctx }: EditorPanelProps) {
  const { book, save } = ctx;
  const beforeStart = () => (save.settle ? save.settle() : save.flush());
  return (
    <div className="flex flex-col gap-4" data-testid="pdf-panel">
      <div className="flex items-start gap-3">
        <span className={ICON_CHIP} aria-hidden="true">
          <FileText className="size-4" />
        </span>
        <p className="min-w-0 pt-0.5 text-sm text-muted-foreground">Download your book as a high-quality A5 PDF. It includes your latest saved edits.</p>
      </div>
      <PdfDownload
        look={PDF_EDITOR_LOOK}
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
  label: "Download PDF",
  icon: FileDown,
  scopes: "always",
  order: 98,
  tier: "more",
  editsDoc: false,
  isAvailable: (ctx) => ctx.book.isPaid && (ctx.activeTool === PDF_TOOL_ID || selectionKind(ctx.state.selection) === "none"),
  Panel: PdfPanel,
  panelTitle: "Download PDF",
};

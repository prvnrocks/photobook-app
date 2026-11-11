// Visible progress for "Download PDF" (M11 T16, D-067). Pure: maps the controller's real export
// state (src/lib/pdf/ui.ts PdfUiState) to a short checklist. It never invents progress: a step is
// "current" only while the server reports that state, and "done" only once the export moved past it.
//   starting            → POST in flight              (request current)
//   preparing / queued  → server accepted, waiting    (request done, queue current)
//   preparing / rendering → the PDF is being made     (request + queue done, render current)
// A ready PDF (maybe reused without any queue/render) shows the success notice instead, and idle,
// timeout and error show no checklist; their status copy says what happened.

import type { PdfUiState } from "./ui";

export type PdfStepId = "request" | "queue" | "render" | "ready";
export type PdfStepState = "done" | "current" | "todo";

export type PdfStep = { id: PdfStepId; label: string; state: PdfStepState };

export const PDF_STEP_LABELS: Record<PdfStepId, string> = {
  request: "Request sent",
  queue: "Waiting for a free slot",
  render: "Making your pages",
  ready: "Ready to download",
};

const ORDER: PdfStepId[] = ["request", "queue", "render", "ready"];

/** null = no checklist for this state. */
export function pdfProgressSteps(s: PdfUiState): PdfStep[] | null {
  let at: number;
  switch (s.kind) {
    case "starting":
      at = 0;
      break;
    case "preparing":
      at = s.status === "queued" ? 1 : 2;
      break;
    default:
      return null;
  }
  return ORDER.map((id, i) => ({
    id,
    label: PDF_STEP_LABELS[id],
    state: i < at ? "done" : i === at ? "current" : "todo",
  }));
}

/** "Paused while this page is in the background" — the controller stops polling while hidden. */
export const PDF_PAUSED_COPY = "Paused while this page is in the background";

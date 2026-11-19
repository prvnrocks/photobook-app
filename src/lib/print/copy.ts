// Plain-language lines for print readiness issues (Task 10). Built on the server and sent to the
// browser as strings, so the client ships no readiness code. Never names a spec "print-ready" or
// "certified": the summary names what was checked ("Checks passed for digital A5 PDF").

import type { PrintReadinessReport, ReadinessIssue } from "./readiness";

/** Most issue lines a response / card shows (the rest are counted). */
export const READINESS_LINES_MAX = 8;

function where(sheet: number | null): string {
  if (sheet === null) return "Book";
  return sheet === 0 ? "Cover" : `Page ${sheet}`;
}

export function readinessIssueCopy(i: ReadinessIssue): string {
  const at = where(i.sheet);
  switch (i.code) {
    case "spec_incomplete":
      return "This print partner's specification is not filled in yet";
    case "format_unsupported":
      return "This book size is not offered for this output";
    case "page_count_low":
      return `The book needs at least ${i.limit ?? 1} ${i.limit === 1 ? "page" : "pages"}`;
    case "page_count_high":
      return `The book has more than ${i.limit ?? 0} pages — remove some pages`;
    case "page_count_multiple":
      return `The page count must be a multiple of ${i.limit ?? 1}`;
    case "blank_page":
      return `${at} is empty — add a photo or text, or delete the page`;
    case "missing_photo":
      return `${at}: a photo is missing — replace it or pick another layout`;
    case "text_overflow":
      return `${at}: the text is too long for its box — shorten it`;
    case "text_outside_safe":
      return `${at}: text sits too close to the edge`;
    case "low_dpi":
      return `${at}: a photo may look soft when printed${typeof i.dpi === "number" ? ` (${i.dpi} dpi)` : ""}`;
    case "empty_slot":
      return `${at}: a photo space is empty`;
    case "title_may_clip":
      return "Cover: the title is long and may be cut off — try a shorter title";
    case "text_tight":
      return `${at}: the text only just fits`;
  }
}

/** One summary line. */
export function readinessSummary(r: Pick<PrintReadinessReport, "errors" | "warnings" | "specLabel">): string {
  if (r.errors > 0) return `${r.errors} ${r.errors === 1 ? "thing" : "things"} to fix before the PDF can be made`;
  if (r.warnings > 0) return `Checks passed for ${r.specLabel}, with ${r.warnings} ${r.warnings === 1 ? "note" : "notes"}`;
  return `Checks passed for ${r.specLabel}`;
}

export type ReadinessView = {
  ok: boolean;
  summary: string;
  /** Errors first, then warnings; at most READINESS_LINES_MAX. */
  lines: { text: string; severity: "error" | "warning" }[];
  /** Issues not listed. */
  more: number;
};

/** What the share page / the export error shows. Duplicate lines (same text) are folded. */
export function readinessView(r: PrintReadinessReport, max = READINESS_LINES_MAX): ReadinessView {
  const ordered = [...r.issues.filter((i) => i.severity === "error"), ...r.issues.filter((i) => i.severity === "warning")];
  const seen = new Set<string>();
  const all: { text: string; severity: "error" | "warning" }[] = [];
  for (const i of ordered) {
    const text = readinessIssueCopy(i);
    if (seen.has(text)) continue;
    seen.add(text);
    all.push({ text, severity: i.severity });
  }
  return { ok: r.ok, summary: readinessSummary(r), lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

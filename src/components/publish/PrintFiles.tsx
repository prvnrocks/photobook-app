"use client";

// Print files on the share page (Task 10): "Get print files" asks POST /api/books/{id}/pdf/package
// for the cover PDF + the interior PDF of the book's ready PDF and shows two download links (10-min
// signed URLs). Paid books only (rendered by share-slots for paid state). Honest copy: the files are
// A5 with 3 mm bleed — they have not been checked against a print partner's specification.
// Share page only, so the editor bundle does not carry it.

import { Download, Loader2, Printer } from "lucide-react";
import { useState } from "react";

type File = { url: string; filename: string; pages: number };
type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ready"; cover: File; interior: File }
  | { kind: "error"; message: string };

export const PRINT_FILES_COPY = {
  button: "Get print files (cover + inside pages)",
  note: "Two PDFs for a printer: the front cover and the inside pages, A5 with 3 mm bleed. Not checked against a specific print partner's requirements yet.",
  pdfFirst: "Download the PDF first, then get the print files",
  failed: "We couldn't make the print files — try again",
  limited: "Too many tries — wait a few minutes and try again",
} as const;

function isFile(v: unknown): v is File {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return typeof f.url === "string" && /^https?:\/\//.test(f.url) && typeof f.filename === "string" && typeof f.pages === "number";
}

export function PrintFiles({ bookId, fetcher = fetch }: { bookId: string; fetcher?: typeof fetch }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function start() {
    setState({ kind: "busy" });
    try {
      const res = await fetcher(`/api/books/${encodeURIComponent(bookId)}/pdf/package`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && body && isFile(body.cover) && isFile(body.interior)) {
        setState({ kind: "ready", cover: body.cover, interior: body.interior });
        return;
      }
      const error = body?.error;
      setState({ kind: "error", message: error === "pdf_first" ? PRINT_FILES_COPY.pdfFirst : res.status === 429 ? PRINT_FILES_COPY.limited : PRINT_FILES_COPY.failed });
    } catch {
      setState({ kind: "error", message: PRINT_FILES_COPY.failed });
    }
  }

  return (
    <div className="type-small flex w-full min-w-0 flex-col gap-2 border-t border-[#e9dfca] pt-3" data-testid="print-files">
      <p className="text-muted-foreground">{PRINT_FILES_COPY.note}</p>
      {state.kind === "ready" ? (
        <div className="flex flex-col gap-2" data-testid="print-files-links">
          {[
            { f: state.cover, label: "Cover PDF", id: "cover" },
            { f: state.interior, label: `Inside pages PDF (${state.interior.pages} pages)`, id: "interior" },
          ].map(({ f, label, id }) => (
            <a
              key={id}
              href={f.url}
              download={f.filename}
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-2 font-medium underline underline-offset-4"
              data-testid={`print-files-${id}`}
            >
              <Download className="size-4 shrink-0" aria-hidden="true" />
              {label}
            </a>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={state.kind === "busy"}
          aria-busy={state.kind === "busy" || undefined}
          className="inline-flex min-h-11 items-center gap-2 self-start font-medium underline underline-offset-4 disabled:opacity-60"
          data-testid="print-files-button"
        >
          {state.kind === "busy" ? (
            <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Printer className="size-4 shrink-0" aria-hidden="true" />
          )}
          {state.kind === "error" ? "Try again" : PRINT_FILES_COPY.button}
        </button>
      )}
      <p role="status" aria-live="polite" className={state.kind === "error" ? "text-red-800" : "sr-only"} data-testid="print-files-status">
        {state.kind === "error" ? state.message : state.kind === "busy" ? "Making the print files…" : state.kind === "ready" ? "Print files ready" : ""}
      </p>
    </div>
  );
}

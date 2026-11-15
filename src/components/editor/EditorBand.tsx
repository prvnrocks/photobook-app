// Editor band (M22 T3, D-074): the emerald leather header of the editor, in the wizard / share-page
// language (WizardBand, ShareBand).
//   phones: one compact row (h-14 = 56 px ≤ 64 px): back · title + save chip · undo · redo · gold Share
//   ≥ lg:   a taller band: "EDITING" eyebrow over a foil hairline, title, save chip, page-count chip
//           "N / M pages", undo/redo, Share (with its note).
// Hook-free and import-light (no cn/buttonVariants/next/link): the back link, save status and Share
// button arrive as nodes from EditorShell. User text (the title) sits in an inner <span dir="auto">
// so the start-aligned block never flips with the script (lesson 2026-11-13).
// Contrast on the leather's lightest point #1f5443: cream 7.19, pale gold 5.25; chip tones ≥ 5.5.

import type { ReactNode } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { cx } from "@/lib/cx";
import {
  ED_BAND,
  ED_BAND_EYEBROW,
  ED_BAND_EYEBROW_RULE,
  ED_BAND_ICON_BTN,
  ED_BAND_ROW,
  ED_BAND_TITLE,
  ED_BAND_TITLE_WRAP,
  ED_CHIP,
  ED_CHIP_TONE,
} from "./editor-classes";

export type EditorBandHistory = { onClick: () => void; disabled: boolean };

export type EditorBandProps = {
  /** The back link (next/link from EditorShell; data-testid="editor-back", className ED_BAND_ICON_BTN). */
  back: ReactNode;
  /** Display title (user text). */
  title: string;
  /** <SaveStatus> chip. */
  saveStatus: ReactNode;
  undo: EditorBandHistory;
  redo: EditorBandHistory;
  /** <EditorShareButton>. */
  share: ReactNode;
  /** Pages in the doc (spread halves count) and the book's page limit; the chip hides when unknown. */
  pages?: { count: number; max: number | null | undefined };
};

/** "N / M pages", or null when the limit is unknown. Pure, exported for tests. */
export function pageCountLabel(count: number, max: number | null | undefined): string | null {
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return null;
  return `${count} / ${max} pages`;
}

export function EditorBand({ back, title, saveStatus, undo, redo, share, pages }: EditorBandProps) {
  const pageLabel = pages ? pageCountLabel(pages.count, pages.max) : null;
  return (
    <header className={ED_BAND} data-testid="editor-band">
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 start-3 -z-10 hidden w-px opacity-70 lg:block" />
      <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 end-3 -z-10 hidden w-px opacity-70 lg:block" />
      <div className={ED_BAND_ROW}>
        {back}
        <div className={ED_BAND_TITLE_WRAP}>
          <p className={ED_BAND_EYEBROW}>
            <span>Editing</span>
            <span aria-hidden="true" className={ED_BAND_EYEBROW_RULE} />
          </p>
          <div className="flex min-w-0 flex-col items-start gap-0.5 lg:flex-row lg:items-center lg:gap-3">
            {/* Block stays start-aligned for every script; only the text gets dir="auto". */}
            <h1 className={cx(ED_BAND_TITLE, "max-w-full text-start")} data-testid="editor-title">
              <span dir="auto">{title}</span>
            </h1>
            <div className="flex min-w-0 max-w-full items-center gap-2">
              {saveStatus}
              {pageLabel ? (
                // ≥ lg only. The wrapper hides it: ED_CHIP's inline-flex would beat a `hidden` on the chip.
                <span className="hidden shrink-0 lg:block">
                  <span className={cx(ED_CHIP, ED_CHIP_TONE.saving)} data-testid="editor-page-count">
                    {pageLabel}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <button type="button" onClick={undo.onClick} disabled={undo.disabled} aria-label="Undo" className={ED_BAND_ICON_BTN} data-testid="editor-undo">
          <Undo2 className="size-5" aria-hidden="true" />
        </button>
        <button type="button" onClick={redo.onClick} disabled={redo.disabled} aria-label="Redo" className={ED_BAND_ICON_BTN} data-testid="editor-redo">
          <Redo2 className="size-5" aria-hidden="true" />
        </button>
        <div className="shrink-0 lg:ms-2">{share}</div>
      </div>
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
    </header>
  );
}

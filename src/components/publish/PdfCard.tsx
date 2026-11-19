// Share page PDF card (M21 T4; D-002 / D-051). Hook-free: the page renders it on the server and
// hands it to the panel as a slot. Anchor #pdf (My books "PDF" link).
// - Paid (`isPaid` = server state, books.is_paid): the PDF download the page passes in
//   (<PdfDownload look={PDF_SHARE_LOOK}>, testid publish-pdf, all pdf-* testids inside).
// - Free: a locked card — "PDF download comes with the upgrade" and an "Upgrade for PDF" link to
//   the plan card (#upgrade). It renders no download control and never calls /api/…/pdf.

import { FileText, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { SHARE_CARD, SHARE_CARD_HEADING, SHARE_CTA_EMERALD, SHARE_ICON_CHIP } from "./share-classes";

export type PdfCardProps = {
  /** books.is_paid from the server (getPublishState). */
  isPaid: boolean;
  /** Paid: the download control (<PdfDownload look={PDF_SHARE_LOOK} …/> or the View in fixtures). */
  download?: ReactNode;
  /** Task 10, paid: the print checks of the saved book (<PrintChecks>), shown above the button. */
  checks?: ReactNode;
  /** Task 10, paid: the print files control (cover + interior PDFs). */
  printFiles?: ReactNode;
};

const CARD = cx(SHARE_CARD, "flex flex-col gap-4");

export const PDF_CARD_COPY = {
  heading: "PDF download",
  paidBody: "Download your book as a high-quality A5 PDF.",
  lockedBody: "A high-quality PDF of your book comes with the upgrade.",
  lockedCta: "Upgrade for PDF",
} as const;

export function PdfCard({ isPaid, download, checks, printFiles }: PdfCardProps) {
  if (!isPaid) {
    return (
      <section id="pdf" className={CARD} data-testid="publish-pdf-locked" aria-labelledby="publish-pdf-locked-title">
        <div className="flex items-start gap-3">
          <span className={cx(SHARE_ICON_CHIP, "bg-[#f4eee2] text-muted-foreground")} aria-hidden="true">
            <Lock className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id="publish-pdf-locked-title" className={SHARE_CARD_HEADING}>
              {PDF_CARD_COPY.heading}
            </h2>
            <p className="type-small mt-1 text-muted-foreground">{PDF_CARD_COPY.lockedBody}</p>
          </div>
        </div>
        <a href="#upgrade" className={cx(SHARE_CTA_EMERALD, "self-start")} data-testid="publish-pdf-upgrade-link">
          {PDF_CARD_COPY.lockedCta}
        </a>
      </section>
    );
  }
  return (
    <section id="pdf" className={CARD} data-testid="publish-pdf" aria-labelledby="publish-pdf-title">
      <div className="flex items-start gap-3">
        <span className={SHARE_ICON_CHIP} aria-hidden="true">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id="publish-pdf-title" className={SHARE_CARD_HEADING}>
            {PDF_CARD_COPY.heading}
          </h2>
          <p className="type-small mt-1 text-muted-foreground">{PDF_CARD_COPY.paidBody}</p>
        </div>
      </div>
      {checks}
      {download}
      {printFiles}
    </section>
  );
}

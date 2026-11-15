// Server-renderable parts of the share page (M21 T5): the book preview (with "Open flipbook" while
// the link is live), the plan card and the PDF card. They only change with server state (paid,
// published, expired), so the page renders them on the server and passes them to <PublishPanel> as
// slots — their markup, icons and compare data stay out of the panel's client bundle. Every
// `isPaid` here is the server's (getPublishState).
// - Server page: no `refresh` → the router-wired <UpgradeButton> / <PdfDownload>.
// - Router-free renders (dev fixture, unit tests): pass `refresh` → the *View components.
// Hook-free; no cn/buttonVariants/next/link.

import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { PublishPreview, PublishState } from "@/app/books/[id]/publish/actions";
import { UpgradeButton, UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
import type { PdfTransport } from "@/lib/pdf/ui";
import type { PublishCompare } from "@/lib/publish/compare";
import { shareStatus, type ShareStatusKind } from "@/lib/publish/status";
import { SHARE_COPY } from "@/lib/publish/ui";
import { PdfCard } from "./PdfCard";
import { PdfDownload, PdfDownloadView } from "./PdfDownload";
import { PlanCard } from "./PlanCard";
import { PDF_SHARE_LOOK, SHARE_UPGRADE_CLASS, SHARE_UPGRADE_SECONDARY_CLASS } from "./share-classes";
import { SHARE_OPEN_LINK } from "./share-page-classes";
import { SharePreview } from "./SharePreview";


export type ShareSlots = { preview: ReactNode; plan: ReactNode; pdf: ReactNode };

export type ShareSlotsInput = {
  bookId: string;
  title: string;
  state: PublishState;
  /** getPublishState().preview; null → no preview slot. */
  preview: PublishPreview | null;
  compare: PublishCompare;
  paymentsEnabled: boolean;
  now?: Date;
  /** Router-free render: use the View components with this refresh. */
  refresh?: () => void;
  /** PDF API transport for router-free renders (dev fixture / tests). */
  pdfTransport?: PdfTransport;
};

export function shareSlots(input: ShareSlotsInput): ShareSlots {
  const { bookId, title, state, preview, compare, paymentsEnabled, refresh, pdfTransport } = input;
  const returnTo = `/books/${bookId}/publish`;
  const status = shareStatus(state, input.now ?? new Date());
  const live = state.published && state.slug !== null && status.kind !== "expired";

  const upgradeProps = {
    bookId,
    returnTo,
    isPaid: state.isPaid,
    paymentsEnabled,
    testId: "publish-upgrade",
    className: upgradeClass(status.kind, state.canPublishReason !== null),
  };
  const upgrade = refresh ? <UpgradeButtonView {...upgradeProps} refresh={refresh} /> : <UpgradeButton {...upgradeProps} />;

  const pdfProps = { bookId, isPaid: state.isPaid, paymentsEnabled, returnTo, look: PDF_SHARE_LOOK };
  const download = state.isPaid ? (
    refresh ? (
      <PdfDownloadView {...pdfProps} refresh={refresh} transport={pdfTransport} />
    ) : (
      <PdfDownload {...pdfProps} />
    )
  ) : null;

  return {
    preview: preview ? (
      <SharePreview
        responsive
        preview={preview}
        title={title}
        pageCount={state.pageCount}
        open={live ? <OpenFlipbook href={`/b/${state.slug}`} /> : undefined}
      />
    ) : null,
    plan: <PlanCard compare={compare} isPaid={state.isPaid} upgrade={state.isPaid ? null : upgrade} />,
    pdf: <PdfCard isPaid={state.isPaid} download={download} />,
  };
}

/**
 * One gold call to action per screen: while the page's primary is Publish / Update link (draft or
 * changes, not blocked) the plan card's Upgrade is the emerald secondary; otherwise (live free book,
 * blocked publish — e.g. over the free page limit, where upgrading is the fix) it stays gold.
 */
export function upgradeClass(kind: ShareStatusKind, blocked: boolean): string {
  const publishIsPrimary = (kind === "draft" || kind === "changes") && !blocked;
  return publishIsPrimary ? SHARE_UPGRADE_SECONDARY_CLASS : SHARE_UPGRADE_CLASS;
}

/** The live book in a new tab (testid publish-open): a plain <a> — the viewer is its own app. */
function OpenFlipbook({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={SHARE_OPEN_LINK} data-testid="publish-open">
      <ExternalLink className="size-4" aria-hidden="true" />
      {SHARE_COPY.openFlipbook}
    </a>
  );
}

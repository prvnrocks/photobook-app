"use client";

// "Download PDF" (M8 T8, D-051). Paid books: POST /api/books/{id}/pdf, poll while the server
// renders, then navigate to the signed URL (window.location.assign — iOS-safe, no window.open
// after an await) and keep a "Download again" link while the URL is valid (~10 min).
// Free books: no PDF button — "PDF download comes with the upgrade" + the existing UpgradeButton.
// Flow + copy live in src/lib/pdf/ui.ts; this component only renders the controller's state.
//
// <PdfDownload> wires next/navigation (refresh for the upgrade fallback); <PdfDownloadView> is
// router-free (PublishPanelView, unit tests, dev fixtures). Paid status comes from the server.

import { Circle, CircleCheck, CircleDot, Download, FileDown, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BTN } from "@/components/app/button-classes";
import { Notice } from "@/components/app/Notice";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
import { track } from "@/lib/analytics/client";
import {
  createPdfDownloadController,
  fetchPdfTransport,
  isPdfBusy,
  PDF_DOWNLOAD_AGAIN_LABEL,
  PDF_FREE_COPY,
  pdfButtonLabel,
  pdfReadyDetail,
  pdfStatusCopy,
  type PdfController,
  type PdfTransport,
  type PdfUiState,
} from "@/lib/pdf/ui";
import { PDF_PAUSED_COPY, pdfProgressSteps } from "@/lib/pdf/progress";

export type PdfDownloadProps = {
  bookId: string;
  /** books.is_paid from the server. */
  isPaid: boolean;
  /** isPaymentsEnabled() from the server, for the upgrade fallback (absent = false). */
  paymentsEnabled?: boolean;
  /** Where the upgrade's Stripe cancel URL / sign-in link return to. */
  returnTo: string;
  /** Awaited before the export starts (editor: settle pending saves). */
  onBeforeStart?: () => unknown;
};

// Shared Button looks (M11, D-067), precomputed (BTN) so the publish route ships no cn/ui-button.
const PRIMARY = BTN.ctaPrimaryWrap;
const OUTLINE = BTN.ctaOutlineCard;

export function PdfDownload(props: PdfDownloadProps) {
  // Not a bare router.refresh(): it can stay pending forever under edit/loading.tsx.
  const [, refresh] = useRefreshTransition();
  return <PdfDownloadView {...props} refresh={refresh} />;
}

export function PdfDownloadView({
  bookId,
  isPaid,
  paymentsEnabled = false,
  returnTo,
  onBeforeStart,
  refresh = noop,
  initialState,
  transport = fetchPdfTransport,
  navigate,
}: PdfDownloadProps & {
  /** Upgrade fallback: re-render as paid when the server says already_paid. */
  refresh?: () => void;
  /** Render a given state (static-render tests / dev fixtures); the controller starts idle. */
  initialState?: PdfUiState;
  transport?: PdfTransport;
  navigate?: (url: string) => void;
}) {
  const [state, setState] = useState<PdfUiState>(initialState ?? { kind: "idle" });
  const controller = useRef<PdfController | null>(null);
  // Latest callbacks without re-creating the controller (it owns timers for a running export).
  const latest = useRef({ transport, navigate, onBeforeStart });
  useEffect(() => {
    latest.current = { transport, navigate, onBeforeStart };
  }, [transport, navigate, onBeforeStart]);

  useEffect(() => {
    if (!isPaid) return;
    // analytics (M9 T14): one pdf_downloaded per ready; reused = no queued/rendering step seen.
    let rendered = false;
    const c = createPdfDownloadController({
      bookId,
      onChange: (s) => {
        if (s.kind === "starting") rendered = false;
        else if (s.kind === "preparing") rendered = true;
        else if (s.kind === "ready") track("pdf_downloaded", { pages: s.pageCount, reused: !rendered }, { beacon: true });
        setState(s);
      },
      transport: (m, u) => latest.current.transport(m, u),
      navigate: (url) => (latest.current.navigate ? latest.current.navigate(url) : window.location.assign(url)),
      beforeStart: () => latest.current.onBeforeStart?.(),
    });
    controller.current = c;
    return () => {
      // Unmount (sheet closed, page left): stop polling. The server job keeps going; the next tap
      // reuses it (D-051).
      c.dispose();
      controller.current = null;
    };
  }, [bookId, isPaid]);

  if (!isPaid) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-3" data-testid="pdf-download-free">
        <p className="type-small text-foreground">{PDF_FREE_COPY}</p>
        <UpgradeButtonView
          bookId={bookId}
          returnTo={returnTo}
          isPaid={false}
          paymentsEnabled={paymentsEnabled}
          variant="outline"
          testId="pdf-upgrade"
          refresh={refresh}
        />
      </div>
    );
  }

  const busy = isPdfBusy(state);
  const copy = pdfStatusCopy(state);
  const isError = state.kind === "error";
  const notPaid = state.kind === "error" && state.code === "not_paid";

  return (
    <div className="flex w-full min-w-0 flex-col gap-3" data-testid="pdf-download-wrap">
      {state.kind !== "ready" && !notPaid ? (
        <button
          type="button"
          onClick={() => void controller.current?.start()}
          disabled={busy}
          aria-busy={busy || undefined}
          className={PRIMARY}
          data-testid="pdf-download"
        >
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FileDown className="size-4 shrink-0" aria-hidden="true" />}
          <span className="min-w-0">{pdfButtonLabel(state)}</span>
        </button>
      ) : null}

      {/* The one live region for PDF status: children (progress, Notice) carry no role of their own. */}
      <div
        role={isError && !notPaid ? "alert" : "status"}
        aria-live={isError && !notPaid ? "assertive" : "polite"}
        data-testid="pdf-status" data-state={state.kind} data-code={state.kind === "error" ? state.code : undefined}>
        {copy && busy ? (
          <PdfProgress state={state} copy={copy} />
        ) : copy ? (
          <Notice live={false} tone={isError ? (notPaid ? "info" : "error") : state.kind === "ready" ? "success" : "info"}>
            <span data-testid="pdf-status-text">{copy}</span>
            {state.kind === "ready" ? (
              <span className="block text-muted-foreground" data-testid="pdf-ready-detail">
                {pdfReadyDetail(state)}
              </span>
            ) : null}
            {state.kind === "error" && state.code === "unauthenticated" ? (
              <>
                {" "}
                <Link href={`/login?next=${encodeURIComponent(returnTo)}`} className="font-medium underline underline-offset-4">
                  Sign in
                </Link>
              </>
            ) : null}
          </Notice>
        ) : null}
      </div>

      {state.kind === "ready" ? (
        <a href={state.url} download={state.filename} rel="noopener noreferrer" className={OUTLINE} data-testid="pdf-download-again">
          <Download className="size-4 shrink-0" aria-hidden="true" />
          {PDF_DOWNLOAD_AGAIN_LABEL}
        </a>
      ) : null}

      {notPaid ? (
        <UpgradeButtonView
          bookId={bookId}
          returnTo={returnTo}
          isPaid={false}
          paymentsEnabled={paymentsEnabled}
          variant="outline"
          testId="pdf-upgrade"
          refresh={refresh}
        />
      ) : null}
    </div>
  );
}

/** Busy export: spinner + copy + the real-state checklist (src/lib/pdf/progress.ts). */
function PdfProgress({ state, copy }: { state: PdfUiState; copy: string }) {
  const steps = pdfProgressSteps(state);
  const paused = state.kind === "preparing" && state.paused;
  return (
    <div className="type-small rounded-xl border border-border bg-background p-4" data-testid="pdf-progress">
      <p className="flex items-start gap-2 font-medium text-foreground">
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent-strong motion-reduce:animate-none" aria-hidden="true" />
        <span className="min-w-0" data-testid="pdf-status-text">
          {copy}
        </span>
      </p>
      {steps ? (
        <ol className="mt-3 flex flex-col gap-2 ps-1" aria-label="PDF progress">
          {steps.map((step) => (
            <li
              key={step.id}
              data-step={step.id}
              data-state={step.state}
              aria-current={step.state === "current" ? "step" : undefined}
              className={`flex items-center gap-2 ${step.state === "todo" ? "text-muted-foreground" : "text-foreground"}${
                step.state === "current" ? " font-medium" : ""
              }`}
            >
              {step.state === "done" ? (
                <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : step.state === "current" ? (
                <CircleDot className="size-4 shrink-0 text-accent-strong" aria-hidden="true" />
              ) : (
                <Circle className="size-4 shrink-0 text-input" aria-hidden="true" />
              )}
              {step.label}
              <span className="sr-only">{step.state === "done" ? " (done)" : step.state === "current" ? " (in progress)" : ""}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {paused ? (
        <p className="mt-2 text-muted-foreground" data-testid="pdf-paused">
          {PDF_PAUSED_COPY}
        </p>
      ) : null}
    </div>
  );
}

function noop(): void {}

"use client";

// "Download PDF" (M8 T8, D-051). Paid books: POST /api/books/{id}/pdf, poll while the server
// renders, then navigate to the signed URL (window.location.assign — iOS-safe, no window.open
// after an await) and keep a "Download again" link while the URL is valid (~10 min).
// Free books: no PDF button — "PDF download comes with the upgrade" + the existing UpgradeButton.
// Flow + copy live in src/lib/pdf/ui.ts; this component only renders the controller's state.
//
// <PdfDownload> wires next/navigation (refresh for the upgrade fallback); <PdfDownloadView> is
// router-free (PublishPanelView, unit tests, dev fixtures). Paid status comes from the server.

import { Download, FileDown, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { UpgradeButtonView } from "@/components/upgrade/UpgradeButton";
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

const BTN =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-5 text-center text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = `${BTN} bg-primary text-primary-foreground hover:bg-primary/90`;
const OUTLINE = `${BTN} border bg-background hover:bg-muted`;

export function PdfDownload(props: PdfDownloadProps) {
  const router = useRouter();
  return <PdfDownloadView {...props} refresh={() => router.refresh()} />;
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
    const c = createPdfDownloadController({
      bookId,
      onChange: setState,
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
        <p className="text-sm">{PDF_FREE_COPY}</p>
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
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" /> : <FileDown className="size-4 shrink-0" aria-hidden="true" />}
          <span className="min-w-0">{pdfButtonLabel(state)}</span>
        </button>
      ) : null}

      <div aria-live="polite" data-testid="pdf-status" data-state={state.kind} data-code={state.kind === "error" ? state.code : undefined}>
        {copy ? (
          <div
            role={isError ? "alert" : "status"}
            className={
              isError && !notPaid
                ? "rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                : state.kind === "ready"
                  ? "rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                  : "flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm"
            }
          >
            {busy ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" /> : null}
            <p className="min-w-0">
              <span data-testid="pdf-status-text">{copy}</span>
              {state.kind === "ready" ? (
                <span className="block text-xs text-emerald-800/80" data-testid="pdf-ready-detail">
                  {pdfReadyDetail(state)}
                </span>
              ) : null}
              {state.kind === "error" && state.code === "unauthenticated" ? (
                <>
                  {" "}
                  <Link href={`/login?next=${encodeURIComponent(returnTo)}`} className="font-medium underline">
                    Sign in
                  </Link>
                </>
              ) : null}
            </p>
          </div>
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

function noop(): void {}

// "Stop sharing" (M6 T8; M21 T4 restyle of UnpublishSection): quiet, last on the share page —
// turning the link off is rare and must never sit next to Share. A hairline, a small heading, one
// quiet red text button; the confirm step is a soft red panel with the solid Unpublish + Cancel.
// The panel owns the action + busy state. Testids kept: unpublish-section, unpublish-button,
// unpublish-confirm, unpublish-confirm-button.

import { Loader2 } from "lucide-react";
import { useId } from "react";
import { SHARE_CTA_DANGER_QUIET, SHARE_CTA_DANGER_SOLID, SHARE_CTA_EMERALD } from "./share-classes";

export type DangerZoneProps = {
  isPaid: boolean;
  confirming: boolean;
  onConfirmChange: (confirming: boolean) => void;
  onUnpublish: () => void;
  /** Unpublish is in flight. */
  busy: boolean;
  /** Any action / refresh in flight. */
  locked: boolean;
};

export function DangerZone({ isPaid, confirming, onConfirmChange, onUnpublish, busy, locked }: DangerZoneProps) {
  const headingId = useId();
  return (
    <section
      className="mt-2 flex flex-col gap-3 border-t border-[#e2d7c1] px-1 pt-5 sm:px-2"
      data-testid="unpublish-section"
      aria-labelledby={headingId}
    >
      <div>
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          Stop sharing
        </h2>
        <p className="type-small mt-0.5 text-muted-foreground">Unpublishing turns the link off for everyone.</p>
      </div>
      {confirming ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-destructive-border bg-destructive-soft p-4" data-testid="unpublish-confirm">
          <p className="type-small text-foreground">
            Unpublish this book? The link stops working for everyone.
            {isPaid ? "" : " Publishing again keeps the same link and expiry date."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onUnpublish} disabled={locked} className={SHARE_CTA_DANGER_SOLID} data-testid="unpublish-confirm-button">
              {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              Unpublish
            </button>
            <button type="button" onClick={() => onConfirmChange(false)} disabled={busy} className={SHARE_CTA_EMERALD}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onConfirmChange(true)}
          disabled={locked}
          className={`${SHARE_CTA_DANGER_QUIET} -ms-4 self-start`}
          data-testid="unpublish-button"
        >
          Unpublish
        </button>
      )}
    </section>
  );
}

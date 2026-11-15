// "Stop sharing" (M6 T8): quiet, at the bottom of the share page — turning the link off is rare and
// should never sit next to Share. Moved out of PublishPanel in M21 T3 unchanged (T4 restyles it).
// The panel owns the action + busy state; this renders the confirm step.

import { Loader2 } from "lucide-react";
import { useId } from "react";
import { BTN } from "@/components/app/button-classes";

export type UnpublishSectionProps = {
  isPaid: boolean;
  confirming: boolean;
  onConfirmChange: (confirming: boolean) => void;
  onUnpublish: () => void;
  /** Unpublish is in flight. */
  busy: boolean;
  /** Any action / refresh in flight. */
  locked: boolean;
};

const SPIN = "size-4 animate-spin motion-reduce:animate-none";

export function UnpublishSection({ isPaid, confirming, onConfirmChange, onUnpublish, busy, locked }: UnpublishSectionProps) {
  const headingId = useId();
  return (
    <section className="mt-4 flex flex-col gap-3 border-t border-border pt-stack" data-testid="unpublish-section" aria-labelledby={headingId}>
      <div>
        <h2 id={headingId} className="type-eyebrow">
          Stop sharing
        </h2>
        <p className="type-small mt-1 text-muted-foreground">Unpublishing turns the link off for everyone.</p>
      </div>
      {confirming ? (
        <div className="flex flex-col gap-3 rounded-xl border border-destructive-border bg-destructive-soft p-4" data-testid="unpublish-confirm">
          <p className="type-small text-foreground">
            Unpublish this book? The link stops working for everyone.
            {isPaid ? "" : " Publishing again keeps the same link and expiry date."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onUnpublish} disabled={locked} className={BTN.touchDestructiveSolid} data-testid="unpublish-confirm-button">
              {busy ? <Loader2 className={SPIN} aria-hidden="true" /> : null}
              Unpublish
            </button>
            <button type="button" onClick={() => onConfirmChange(false)} disabled={busy} className={BTN.touchOutlineCard}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => onConfirmChange(true)} disabled={locked} className={BTN.touchGhostDanger} data-testid="unpublish-button">
          Unpublish
        </button>
      )}
    </section>
  );
}

// The expired-link screen without its client islands (D-002, D-039). Everyone sees the expiry copy;
// the owner branch shows `ownerUpgrade` (ExpiredBook passes the live "Payment cancelled" notice +
// UpgradeButton; the dev-viewer preview passes a static stand-in) and the editor link. Visitors get
// the gold "Create your own". No title or cover for anyone (D-040).
// No hooks and no client imports, so a server page can render it without referencing /b's client
// modules (the dev-viewer ?state= previews — a cross-route client reference changes /b's chunks).
// M23 T5: one gold per screen — owner: Upgrade (gold) + "Open in editor" (emerald outline);
// visitor: "Create your own" (gold). Plain <a> links (no next/link on /b).

import { Clock } from "lucide-react";
import type { ReactNode } from "react";
import { VW_CTA_EMERALD_OUTLINE, VW_CTA_GOLD } from "@/components/viewer/viewer-classes";
import { cx } from "@/lib/cx";
import { UPGRADE } from "@/lib/pricing";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";
import { ViewerMessage } from "./ViewerMessage";

/** The owner's gold Upgrade button label and classes (the screen's one gold action). */
export const EXPIRED_UPGRADE_LABEL = `Upgrade to bring it back — ${UPGRADE.label}`;
export const EXPIRED_UPGRADE_CLASS = cx(VW_CTA_GOLD, "w-full py-2 text-balance");

export function ExpiredBookScreen({
  isOwner,
  editorHref,
  ownerUpgrade,
}: {
  isOwner: boolean;
  editorHref?: string | null;
  /** Owner only: the upgrade block (notice + button) above the editor link. */
  ownerUpgrade?: ReactNode;
}) {
  return (
    <ViewerMessage
      eyebrow="Link expired"
      title="This photobook has expired"
      icon={<Clock className="size-6" />}
      description={
        isOwner
          ? "Free links stay open for 30 days. Your book is still safe in your account — upgrade it to bring the link back for good."
          : "The link to this book is no longer active. You can make a photobook of your own in a few minutes."
      }
      testId="expired-book"
    >
      {isOwner ? (
        <>
          {ownerUpgrade}
          {editorHref ? (
            <a href={editorHref} className={cx(VW_CTA_EMERALD_OUTLINE, "w-full")} data-testid="expired-open-editor">
              Open in editor
            </a>
          ) : null}
        </>
      ) : (
        <a href={CREATE_YOURS_HREF} className={cx(VW_CTA_GOLD, "w-full")} data-testid="expired-create">
          Create your own
        </a>
      )}
    </ViewerMessage>
  );
}

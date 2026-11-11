// /b/[slug] when a free link has expired (D-002, D-039). Everyone sees the expiry + "Create your
// own"; the signed-in owner also sees "Upgrade to bring it back — AED 39" (M7 T6: live Stripe
// Checkout, disabled + "Payments unavailable" without Stripe keys), the "Payment cancelled" notice
// after a cancelled Checkout, and a link back to the editor. No title or cover for anyone (D-040).
// The book id reaches client props only in the owner branch (like the editor link).

import { Clock } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { UpgradeButton } from "@/components/upgrade/UpgradeButton";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { UPGRADE } from "@/lib/pricing";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";
import { VIEWER_PRIMARY_LINK, VIEWER_SECONDARY_LINK, ViewerMessage, ViewerMessageIcon } from "./ViewerMessage";

export type ExpiredBookUpgrade = {
  bookId: string;
  /** /b/{slug} — Stripe's cancel URL returns here. */
  returnTo: string;
  /** isPaymentsEnabled() from the server. */
  paymentsEnabled: boolean;
};

export function ExpiredBook({
  isOwner,
  editorHref,
  upgrade,
}: {
  isOwner: boolean;
  editorHref?: string | null;
  /** Owner only. */
  upgrade?: ExpiredBookUpgrade | null;
}) {
  return (
    <ViewerMessage
      title="This photobook has expired"
      art={
        <ViewerMessageIcon>
          <Clock className="size-6" />
        </ViewerMessageIcon>
      }
      description={
        isOwner
          ? "Free links stay open for 30 days. Your book is still safe in your account — upgrade it to bring the link back for good."
          : "The link to this book is no longer active. You can make a photobook of your own in a few minutes."
      }
      testId="expired-book"
    >
      {isOwner ? (
        <>
          <Suspense fallback={null}>
            <UpgradeCancelledNotice />
          </Suspense>
          {upgrade ? (
            <UpgradeButton
              bookId={upgrade.bookId}
              returnTo={upgrade.returnTo}
              // Only free links expire.
              isPaid={false}
              paymentsEnabled={upgrade.paymentsEnabled}
              variant="viewer"
              label={`Upgrade to bring it back — ${UPGRADE.label}`}
              testId="expired-upgrade"
            />
          ) : null}
          {editorHref ? (
            <Link href={editorHref} className={VIEWER_SECONDARY_LINK} data-testid="expired-open-editor">
              Open in editor
            </Link>
          ) : null}
        </>
      ) : (
        <Link href={CREATE_YOURS_HREF} className={VIEWER_PRIMARY_LINK} data-testid="expired-create">
          Create your own
        </Link>
      )}
    </ViewerMessage>
  );
}

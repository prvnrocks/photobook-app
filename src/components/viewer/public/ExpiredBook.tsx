// /b/[slug] when a free link has expired (D-002, D-039). ExpiredBookScreen with the live owner
// islands: the "Payment cancelled" notice after a cancelled Checkout and "Upgrade to bring it
// back — AED 39" (M7 T6: live Stripe Checkout, disabled + "Payments unavailable" without Stripe
// keys). The book id reaches client props only in the owner branch (like the editor link).

import { Suspense } from "react";
import { UpgradeButton } from "@/components/upgrade/UpgradeButton";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import { EXPIRED_UPGRADE_CLASS, EXPIRED_UPGRADE_LABEL, ExpiredBookScreen } from "./ExpiredBookScreen";

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
    <ExpiredBookScreen
      isOwner={isOwner}
      editorHref={editorHref}
      ownerUpgrade={
        isOwner ? (
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
                className={EXPIRED_UPGRADE_CLASS}
                label={EXPIRED_UPGRADE_LABEL}
                testId="expired-upgrade"
              />
            ) : null}
          </>
        ) : null
      }
    />
  );
}

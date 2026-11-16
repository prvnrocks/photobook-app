"use client";

// "Upgrade this book — AED 39" (M7 T6). Starts the Stripe Checkout via the upgrade server action
// and navigates there; it never marks a book paid (only the Stripe webhook does).
//
// - Hidden when the book is already paid.
// - paymentsEnabled comes from the server (isPaymentsEnabled() in a server component, passed down
//   as a boolean): false → disabled button + "Payments unavailable".
// - <UpgradeButton> wires next/navigation; <UpgradeButtonView> takes `refresh` (router-free:
//   PublishPanelView, unit tests).
// Client code imports types only from @/lib/upgrade/* — never src/lib/payments or src/lib/stripe.

import { Gem, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { startUpgradeCheckout } from "@/app/books/[id]/upgrade/actions";
import { Notice } from "@/components/app/Notice";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { UPGRADE_BUTTON_OUTLINE, UPGRADE_BUTTON_PRIMARY } from "@/components/upgrade/upgrade-button-classes";
import { track } from "@/lib/analytics/client";
import type { StartUpgradeCheckoutResult, StartUpgradeErrorCode } from "@/lib/upgrade/types";
import { PAYMENTS_UNAVAILABLE_HINT, runUpgradeCheckout, UPGRADE_BUTTON_LABEL } from "@/lib/upgrade/ui";

export type UpgradeButtonProps = {
  bookId: string;
  /** Where Stripe's cancel URL returns to: /books/{id}/publish | /books/{id}/edit | /b/{slug}. */
  returnTo: string;
  isPaid: boolean;
  /** isPaymentsEnabled() from the server. */
  paymentsEnabled: boolean;
  variant?: "primary" | "outline" | "viewer";
  label?: string;
  /** Root test id; the message / hint get `-message` / `-unavailable` suffixes. */
  testId?: string;
  /** Called on tap before the action runs (editor: flush pending saves). */
  onBeforeStart?: () => void;
  /** Replaces the variant's button classes (share page: the gold pill). Must keep a 44 px target + focus ring. */
  className?: string;
};

// Default looks (M26, D-078): emerald pills — 48 px solid / 44 px outline, visible focus ring,
// whitespace-normal so the label wraps on narrow screens. Plain strings (upgrade-button-classes.ts):
// this ships on /b, publish and the editor, which must not pull in cn/ui-button. A caller's
// className replaces these entirely (share PlanCard, viewer ExpiredBook, editor UpgradeSheet).
const VARIANTS: Record<NonNullable<UpgradeButtonProps["variant"]>, string> = {
  primary: UPGRADE_BUTTON_PRIMARY,
  outline: UPGRADE_BUTTON_OUTLINE,
  viewer: UPGRADE_BUTTON_PRIMARY,
};

export function UpgradeButton(props: UpgradeButtonProps) {
  // Not a bare router.refresh(): it can stay pending forever under a route loading.tsx (editor).
  const [, refresh] = useRefreshTransition();
  return <UpgradeButtonView {...props} refresh={refresh} />;
}

type Message = { code: StartUpgradeErrorCode; text: string };

export function UpgradeButtonView({
  bookId,
  returnTo,
  isPaid,
  paymentsEnabled,
  variant = "primary",
  label = UPGRADE_BUTTON_LABEL,
  testId = "upgrade-button",
  onBeforeStart,
  className,
  refresh,
  start = startUpgradeCheckout,
  navigate = defaultNavigate,
}: UpgradeButtonProps & {
  refresh: () => void;
  /** Injected in tests / dev fixtures; defaults to the server action. */
  start?: (bookId: string, returnTo?: string) => Promise<StartUpgradeCheckoutResult>;
  navigate?: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  // Back from Stripe via the bfcache restores the page with busy=true — reset it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  if (isPaid) return null;

  const hintId = `${testId}-unavailable`;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    onBeforeStart?.();
    const outcome = await runUpgradeCheckout({
      start: () => start(bookId, returnTo),
      navigate: (url) => {
        // analytics (M9 T14): beacon, the page is about to leave for Stripe.
        track("checkout_started", {}, { beacon: true });
        navigate(url);
      },
      refresh,
    });
    // Navigating: keep the spinner until the page unloads.
    if (outcome.kind === "error") {
      setBusy(false);
      setMessage({ code: outcome.code, text: outcome.text });
    }
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-testid={`${testId}-wrap`} data-payments={paymentsEnabled ? "on" : "off"}>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={!paymentsEnabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={paymentsEnabled ? undefined : hintId}
        className={className ?? VARIANTS[variant]}
        data-testid={testId}
      >
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Gem className="size-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0">{label}</span>
      </button>
      {!paymentsEnabled ? (
        <p id={hintId} className="type-small text-center text-muted-foreground" data-testid={hintId}>
          {PAYMENTS_UNAVAILABLE_HINT}
        </p>
      ) : null}
      <div aria-live="polite">
        {message ? (
          <Notice tone={message.code === "already_paid" ? "success" : "error"}>
            {/* The testid sits on the text itself (Notice adds a screen-reader tone prefix). */}
            <p data-testid={`${testId}-message`} data-code={message.code}>
              {message.text}
              {message.code === "unauthenticated" ? (
                <>
                  {" "}
                  <Link href={`/login?next=${encodeURIComponent(returnTo)}`} className="font-medium underline underline-offset-4">
                    Sign in
                  </Link>
                </>
              ) : null}
            </p>
          </Notice>
        ) : null}
      </div>
    </div>
  );
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

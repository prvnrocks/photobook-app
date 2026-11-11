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
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { startUpgradeCheckout } from "@/app/books/[id]/upgrade/actions";
import { BTN } from "@/components/app/button-classes";
import { Notice } from "@/components/app/Notice";
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
};

// Shared Button looks (M11, D-067): 44 px touch / 48 px cta, token colours, visible focus ring.
// whitespace-normal: the label may wrap on narrow screens instead of overflowing. Precomputed (BTN):
// this ships on /b and publish, which must not pull in cn/ui-button.
const VARIANTS: Record<NonNullable<UpgradeButtonProps["variant"]>, string> = {
  primary: BTN.ctaPrimaryWrap,
  outline: BTN.touchOutlineWrap,
  viewer: BTN.ctaPrimaryWrap,
};

export function UpgradeButton(props: UpgradeButtonProps) {
  const router = useRouter();
  return <UpgradeButtonView {...props} refresh={() => router.refresh()} />;
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
        className={VARIANTS[variant]}
        data-testid={testId}
      >
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" /> : <Gem className="size-4 shrink-0" aria-hidden="true" />}
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

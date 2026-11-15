// Full-screen message used by the public viewer's non-book states (expired, password, unavailable,
// 404). M23 T5 (D-075): full-bleed emerald leather with one cream card — icon seal, eyebrow (fixed
// copy, never user text), serif heading, body, then the actions. The brand link sits under the card
// on the leather. Safe-area padding on every side (VW_MESSAGE_SCREEN); fits 320 px.
// No hooks — usable from server components. PasswordGate (client) imports this, so it stays tiny:
// no next/link (plain <a>), no EmptyState / cn / button variants; recipes come from viewer-classes.

import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/brand";
import { cx } from "@/lib/cx";
import {
  VW_MESSAGE_BODY,
  VW_MESSAGE_BRAND_LINK,
  VW_MESSAGE_CARD,
  VW_MESSAGE_EYEBROW,
  VW_MESSAGE_HEADING,
  VW_MESSAGE_SCREEN,
  VW_MESSAGE_SEAL,
} from "@/components/viewer/viewer-classes";

export function ViewerMessage({
  eyebrow,
  title,
  description,
  icon,
  children,
  testId,
}: {
  /** Short fixed label above the heading ("Private book"). Never user text (it is letter-spaced). */
  eyebrow: string;
  title: string;
  /** One or two lines of help under the title. */
  description?: ReactNode;
  /** The state icon (lucide, size-6) shown in the seal. */
  icon: ReactNode;
  /** Actions / form under the text. */
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div className={cx(VW_MESSAGE_SCREEN, "flex-col gap-4")} data-testid={testId}>
      <main className="flex w-full min-w-0 flex-1 items-center justify-center">
        <section className={cx(VW_MESSAGE_CARD, "vw-card-in min-w-0 text-center break-words")}>
          <span className={VW_MESSAGE_SEAL} aria-hidden="true">
            {icon}
          </span>
          <p className={cx(VW_MESSAGE_EYEBROW, "mt-5")}>{eyebrow}</p>
          <h1 dir="auto" className={cx(VW_MESSAGE_HEADING, "mt-2")}>
            {title}
          </h1>
          {description ? (
            <p dir="auto" className={cx(VW_MESSAGE_BODY, "mx-auto mt-3 max-w-xs text-balance")}>
              {description}
            </p>
          ) : null}
          {children ? <div className="mt-6 flex w-full min-w-0 flex-col gap-3">{children}</div> : null}
        </section>
      </main>
      <footer className="text-center">
        {/* Plain <a> on purpose: next/link would ship in PasswordGate's island (M23 guardrail). */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className={VW_MESSAGE_BRAND_LINK}>
          {APP_NAME}
        </a>
      </footer>
    </div>
  );
}

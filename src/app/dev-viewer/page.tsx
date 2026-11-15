// Dev-only: the flipbook with fixture data, for 375 px / spread checks without auth or Supabase.
// `?paid=0|1`, `?lang=en|ar` and `?pages=1..100` (default 12), `?bg=RRGGBB` (page background) are passed through for the viewer chrome tasks (watermark, footer,
// end card). `?format=landscape` renders the fixture as an A5 landscape book (M10a A3; portrait layouts until M10b).
// `?sample=modern-portrait|modern-landscape` (M10c: also geometric-|scrapbook-portrait|landscape, `-ar` for Arabic) (M10b A13) shows a modern sample book instead (spreads, text panels,
// sliced cover; src/lib/book/dev-sample.ts); `pages`/`bg`/`format` are ignored then.
// `?state=password|expired|expiredOwner|unavailable|notFound` (M23 T6) shows a non-book screen instead
// (`&payments=1` shows the owner's Upgrade button enabled instead of "Payments unavailable").
// These previews are STATIC: rendered on this server page from the same server-only screens /b uses
// (PasswordGateScreen, ExpiredBookScreen, BookUnavailable, BookNotFoundScreen) with no client islands
// — the form doesn't submit and the Upgrade button is a stand-in. Never import /b's client modules
// (PasswordGate, ExpiredBook → UpgradeButton…) here or in the client island: a cross-route client
// reference changes /b's chunk splitting (lesson M22).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { parseDevFormat } from "@/lib/book/dev-preview";
import { parseDevSample } from "@/lib/book/dev-sample";
import { Gem } from "lucide-react";
import { BookNotFoundScreen } from "@/components/viewer/public/BookNotFoundScreen";
import { BookUnavailable } from "@/components/viewer/public/BookUnavailable";
import {
  EXPIRED_UPGRADE_CLASS,
  EXPIRED_UPGRADE_LABEL,
  ExpiredBookScreen,
} from "@/components/viewer/public/ExpiredBookScreen";
import { PasswordGateScreen } from "@/components/viewer/public/PasswordGateScreen";
import { PAYMENTS_UNAVAILABLE_HINT } from "@/lib/upgrade/ui";
import { devViewerBackground, devViewerPageCount } from "@/lib/viewer/dev-fixture";
import { DevViewerClient } from "./DevViewerClient";

export const dynamic = "force-dynamic";

export const viewport: Viewport = { viewportFit: "cover" };

const DEV_STATES = ["password", "expired", "expiredOwner", "unavailable", "notFound"] as const;
type DevState = (typeof DEV_STATES)[number];

function parseDevState(v: string | string[] | undefined): DevState | null {
  return typeof v === "string" && (DEV_STATES as readonly string[]).includes(v) ? (v as DevState) : null;
}

/**
 * Static stand-in for ExpiredBook's UpgradeButton (same wrapper / testids / classes / hint markup),
 * so this page references no client module. Not wired: tapping does nothing.
 */
function DevUpgradeStandIn({ paymentsEnabled }: { paymentsEnabled: boolean }) {
  const hintId = "expired-upgrade-unavailable";
  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-testid="expired-upgrade-wrap" data-payments={paymentsEnabled ? "on" : "off"}>
      <button
        type="button"
        disabled={!paymentsEnabled}
        aria-describedby={paymentsEnabled ? undefined : hintId}
        className={EXPIRED_UPGRADE_CLASS}
        data-testid="expired-upgrade"
      >
        <Gem className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{EXPIRED_UPGRADE_LABEL}</span>
      </button>
      {paymentsEnabled ? null : (
        <p id={hintId} className="type-small text-center text-muted-foreground" data-testid={hintId}>
          {PAYMENTS_UNAVAILABLE_HINT}
        </p>
      )}
    </div>
  );
}

function DevStateScreen({ state, paymentsEnabled }: { state: DevState; paymentsEnabled: boolean }) {
  switch (state) {
    case "password":
      return <PasswordGateScreen />;
    case "expired":
      return <ExpiredBookScreen isOwner={false} />;
    case "expiredOwner":
      return (
        <ExpiredBookScreen
          isOwner
          editorHref="/dev-editor"
          ownerUpgrade={<DevUpgradeStandIn paymentsEnabled={paymentsEnabled} />}
        />
      );
    case "unavailable":
      return <BookUnavailable />;
    case "notFound":
      return <BookNotFoundScreen />;
  }
}

export default async function DevViewerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const state = parseDevState(params.state);
  if (state) return <DevStateScreen state={state} paymentsEnabled={params.payments === "1"} />;
  const paid = params.paid === "1";
  const lang = params.lang === "ar" ? "ar" : "en";
  return (
    <DevViewerClient
      paid={paid}
      lang={lang}
      pages={devViewerPageCount(params.pages)}
      background={devViewerBackground(params.bg)}
      format={parseDevFormat(params.format)}
      sample={parseDevSample(params.sample)}
    />
  );
}

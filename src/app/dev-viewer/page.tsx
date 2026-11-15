// Dev-only: the flipbook with fixture data, for 375 px / spread checks without auth or Supabase.
// `?paid=0|1`, `?lang=en|ar` and `?pages=1..100` (default 12), `?bg=RRGGBB` (page background) are passed through for the viewer chrome tasks (watermark, footer,
// end card). `?format=landscape` renders the fixture as an A5 landscape book (M10a A3; portrait layouts until M10b).
// `?sample=modern-portrait|modern-landscape` (M10c: also geometric-|scrapbook-portrait|landscape, `-ar` for Arabic) (M10b A13) shows a modern sample book instead (spreads, text panels,
// sliced cover; src/lib/book/dev-sample.ts); `pages`/`bg`/`format` are ignored then.
// `?state=password|expired|expiredOwner|unavailable|notFound` (M23 T6) shows a non-book screen instead
// (`&payments=1` enables the owner's Upgrade button — tapping it runs the real action and fails, no
// such book). Rendered here on the server page: the client island never imports viewer/app modules
// (lesson M22 — a cross-route client import changes the /b chunks).
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { parseDevFormat } from "@/lib/book/dev-preview";
import { parseDevSample } from "@/lib/book/dev-sample";
import BookNotFound from "@/app/b/[slug]/not-found";
import { BookUnavailable } from "@/components/viewer/public/BookUnavailable";
import { ExpiredBook } from "@/components/viewer/public/ExpiredBook";
import { PasswordGate } from "@/components/viewer/public/PasswordGate";
import { devViewerBackground, devViewerPageCount } from "@/lib/viewer/dev-fixture";
import { DevViewerClient } from "./DevViewerClient";

export const dynamic = "force-dynamic";

export const viewport: Viewport = { viewportFit: "cover" };

const DEV_STATES = ["password", "expired", "expiredOwner", "unavailable", "notFound"] as const;
type DevState = (typeof DEV_STATES)[number];

function parseDevState(v: string | string[] | undefined): DevState | null {
  return typeof v === "string" && (DEV_STATES as readonly string[]).includes(v) ? (v as DevState) : null;
}

function DevStateScreen({ state, paymentsEnabled }: { state: DevState; paymentsEnabled: boolean }) {
  switch (state) {
    case "password":
      return <PasswordGate slug="dev-viewer" />;
    case "expired":
      return <ExpiredBook isOwner={false} />;
    case "expiredOwner":
      return (
        <ExpiredBook
          isOwner
          editorHref="/dev-editor"
          upgrade={{ bookId: "dev-book", returnTo: "/dev-viewer?state=expiredOwner", paymentsEnabled }}
        />
      );
    case "unavailable":
      return <BookUnavailable />;
    case "notFound":
      return <BookNotFound />;
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

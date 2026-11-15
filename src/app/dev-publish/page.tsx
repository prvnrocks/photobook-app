// Dev-only: the whole share page (header, ShareBand, panel + slots) with fixture states and stubbed
// actions, for 375 px checks and screenshots without auth or a database.
//   ?state=draft|draft-paid|empty|page_limit|invalid_doc|live|live-paid|changes|password|expired|
//          unpublished|expiring|paid|blocked
//   ?result=ok|conflict|conflict2|failed — what Publish returns (conflict = first call only,
//          conflict2 = both calls).
//   ?shared=live|changes — landed from the editor's Share (M13 T9): one-time message + celebration.
//   ?format=landscape · ?style=classic|modern|geometric|scrapbook · ?cover=photo (sample cover)
//   ?title=… (book title; Arabic welcome) · ?motion=reduce (start with reduced motion simulated)
//   ?toolbar=0 — hide the fixture toolbar (screenshots).
// Upgrade: enabled when the server has Stripe keys (isPaymentsEnabled); the real action runs, so
// without a session it answers "Please sign in again". `?upgrade=cancelled` shows the cancel notice.
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import { notFound } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { DESIGN_STYLES } from "@/lib/book/schema";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { publishCompare } from "@/lib/publish/compare";
import { parseDevPublishState } from "@/lib/publish/dev-fixture";
import { isPaymentsEnabled } from "@/lib/stripe";
import { DevPublishClient } from "./DevPublishClient";

export const dynamic = "force-dynamic";

const SAMPLE_COVER = "/home/books/08-the-day-we-said-yes-cover.png";

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function DevPublishPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const result = ["ok", "conflict", "conflict2", "failed"].includes(String(params.result)) ? String(params.result) : "ok";
  const shared = params.shared === "live" || params.shared === "changes" ? params.shared : null;
  const format: BookFormat = one(params.format) === "landscape" ? "A5_LANDSCAPE" : "A5_PORTRAIT";
  const style = one(params.style) ?? "";
  const designStyle: DesignStyle = (DESIGN_STYLES as readonly string[]).includes(style) ? (style as DesignStyle) : "classic";
  const title = (one(params.title) ?? "").slice(0, 120) || "Sara & Omar";
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader displayName="Sara" variant="plain" width="library" />
      <DevPublishClient
        name={parseDevPublishState(params.state)}
        result={result as "ok" | "conflict" | "conflict2" | "failed"}
        paymentsEnabled={isPaymentsEnabled()}
        compare={publishCompare()}
        shared={shared}
        title={title}
        preview={{ coverThumbUrl: one(params.cover) === "photo" ? SAMPLE_COVER : null, format, designStyle }}
        reduceMotion={one(params.motion) === "reduce"}
        toolbar={one(params.toolbar) !== "0"}
      />
    </div>
  );
}

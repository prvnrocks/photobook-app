// Dev-only: the whole share page (header, ShareBand, panel + slots) with fixture states and stubbed
// actions, for 375 px checks and screenshots without auth or a database.
//   ?state=draft|draft-paid|empty|page_limit|invalid_doc|live|live-paid|changes|password|expired|
//          unpublished|expiring|paid|blocked
//   ?result=ok|conflict|conflict2|failed — what Publish returns (conflict = first call only,
//          conflict2 = both calls).
//   ?shared=live|changes — landed from the editor's Share (M13 T9): one-time message + celebration.
//   ?format=landscape · ?style=classic|modern|geometric|scrapbook · ?cover=photo (sample cover)
//   ?cover=real (the real cover via <BookPage>: modern/geometric/scrapbook sample doc, classic preview doc)
//   + ?layout=<cover layout id> (e.g. s-p-cover-tape) + ?occasion=baby|wedding|…
//   ?title=… (book title; Arabic welcome) · ?motion=reduce (start with reduced motion simulated)
//   ?toolbar=0 — hide the fixture toolbar (screenshots).
//   ?checks=ok|notes|errors — Task 10 print checks on the PDF card (paid states only).
// Upgrade: enabled when the server has Stripe keys (isPaymentsEnabled); the real action runs, so
// without a session it answers "Please sign in again". `?upgrade=cancelled` shows the cancel notice.
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import { notFound } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { DESIGN_STYLES } from "@/lib/book/schema";
import { devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
import { devSampleDoc, devSamplePhotos, parseDevSample } from "@/lib/book/dev-sample";
import { OCCASIONS } from "@/lib/book/options";
import { getLayout } from "@/lib/layouts";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { readinessView, type ReadinessView } from "@/lib/print/copy";
import type { ReadinessIssue } from "@/lib/print/readiness";
import { publishCompare } from "@/lib/publish/compare";
import { parseDevPublishState } from "@/lib/publish/dev-fixture";
import { isPaymentsEnabled } from "@/lib/stripe";
import { DevPublishClient } from "./DevPublishClient";

export const dynamic = "force-dynamic";

const SAMPLE_COVER = "/home/books/08-the-day-we-said-yes-cover.png";

/** Task 10: fixture print-check results (what getPrintReadinessView returns for a real book). */
function devChecks(kind: string | undefined): ReadinessView | null {
  const sets: Record<string, ReadinessIssue[]> = {
    ok: [],
    notes: [
      { code: "low_dpi", severity: "warning", sheet: 4, slot: 0, dpi: 112 },
      { code: "empty_slot", severity: "warning", sheet: 7, slot: 1 },
    ],
    errors: [
      { code: "blank_page", severity: "error", sheet: 5 },
      { code: "text_overflow", severity: "error", sheet: 9, panel: 0 },
      { code: "low_dpi", severity: "warning", sheet: 4, slot: 0, dpi: 112 },
    ],
  };
  const issues = kind ? sets[kind] : undefined;
  if (!issues) return null;
  const errors = issues.filter((i) => i.severity === "error").length;
  return readinessView({ specId: "generic-a5-digital", specLabel: "digital A5 PDF", providerVerified: false, ok: errors === 0, sheets: 21, interiorPages: 20, issues, errors, warnings: issues.length - errors });
}

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
  let cover = null;
  if (one(params.cover) === "real") {
    const sample = parseDevSample(`${designStyle}-${format === "A5_LANDSCAPE" ? "landscape" : "portrait"}`);
    const base = sample ? devSampleDoc(sample) : devPreviewDoc();
    const layout = getLayout(one(params.layout) ?? "");
    const occ = one(params.occasion);
    const doc = {
      ...base,
      pages: [],
      chapters: [],
      occasion: (OCCASIONS as readonly string[]).includes(occ ?? "") ? (occ as (typeof OCCASIONS)[number]) : base.occasion,
      cover: { ...base.cover, title, layout: layout && layout.role === "cover" && layout.format === base.format ? layout.id : base.cover.layout },
    };
    cover = { doc, photos: sample ? devSamplePhotos() : devPreviewPhotos(), captionLang: /[\u0600-\u06FF]/.test(title) ? ("ar" as const) : ("en" as const) };
  }
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
        preview={{ coverThumbUrl: one(params.cover) === "photo" ? SAMPLE_COVER : null, format: cover?.doc.format ?? format, designStyle, cover }}
        reduceMotion={one(params.motion) === "reduce"}
        toolbar={one(params.toolbar) !== "0"}
        readiness={devChecks(one(params.checks))}
      />
    </div>
  );
}

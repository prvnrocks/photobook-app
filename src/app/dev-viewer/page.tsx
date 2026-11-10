// Dev-only: the flipbook with fixture data, for 375 px / spread checks without auth or Supabase.
// `?paid=0|1`, `?lang=en|ar` and `?pages=1..100` (default 12), `?bg=RRGGBB` (page background) are passed through for the viewer chrome tasks (watermark, footer,
// end card). 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { devViewerBackground, devViewerPageCount } from "@/lib/viewer/dev-fixture";
import { DevViewerClient } from "./DevViewerClient";

export const dynamic = "force-dynamic";

export const viewport: Viewport = { viewportFit: "cover" };

export default async function DevViewerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const paid = params.paid === "1";
  const lang = params.lang === "ar" ? "ar" : "en";
  return (
    <DevViewerClient
      paid={paid}
      lang={lang}
      pages={devViewerPageCount(params.pages)}
      background={devViewerBackground(params.bg)}
    />
  );
}

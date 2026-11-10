// Internal print route (M8 T5, D-048): opened only by the headless-Chromium PDF renderer with a
// 5-minute signed token → sheets from..to of the export's doc snapshot. The token comes in the
// `x-print-token` request header (N6: the renderer adds it to same-origin navigations only, so it
// never sits in a URL). The `?token=` query is accepted ONLY outside production (manual debugging);
// a production build ignores it.
// Anything wrong (token, export row, rev, status ≠ rendering, range, doc, DB error) is a plain
// 404. Images point at the print-asset origin (src/lib/pdf/print-assets.ts), served by the
// renderer's request interception.
// noindex/no-store/no-referrer headers come from next.config.ts.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PrintDocument } from "@/components/print/PrintDocument";
import { parseBookDoc } from "@/lib/book/schema";
import { getExportForRender } from "@/lib/db/exports";
import { listPrintPhotoDims } from "@/lib/db/print";
import { printPhotoIds, printRenderPhotos, printSheetTargets } from "@/lib/pdf/print-doc";
import { PRINT_TOKEN_HEADER, readPrintToken } from "@/lib/pdf/print-token-source";
import { verifyPrintToken } from "@/lib/pdf/print-token";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Print",
  robots: { index: false, follow: false },
};

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { bookId } = await params;
  const token = readPrintToken((await headers()).get(PRINT_TOKEN_HEADER), (await searchParams).token);
  const grant = verifyPrintToken(token, { bookId, nowSec: Math.floor(Date.now() / 1000) });
  if (!grant) notFound();

  // A DB error is a 404 like everything else (never a 500 page with details). notFound() must
  // stay outside the try: it works by throwing.
  let exp: Awaited<ReturnType<typeof getExportForRender>> = null;
  try {
    exp = await getExportForRender(grant.exportId);
  } catch {
    exp = null;
  }
  // Only a claimed export renders (runExport claims → status 'rendering' before opening /print).
  if (!exp || exp.bookId.toLowerCase() !== grant.bookId || exp.docRev !== grant.docRev || exp.status !== "rendering") {
    notFound();
  }

  const parsed = parseBookDoc(exp.doc);
  if (!parsed.ok) notFound();
  const doc = parsed.doc;
  const sheets = printSheetTargets(doc.pages.length, grant.from, grant.to);
  if (!sheets) notFound();

  let dims: Awaited<ReturnType<typeof listPrintPhotoDims>> | null = null;
  try {
    dims = await listPrintPhotoDims(exp.bookId, printPhotoIds(doc, sheets));
  } catch {
    dims = null;
  }
  if (!dims) notFound();
  const photos = printRenderPhotos(dims);
  return <PrintDocument doc={doc} photos={photos} captionLang={exp.captionLang} sheets={sheets} />;
}

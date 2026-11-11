// Dev-only visual check for print mode (D-050 bleed): the dev fixture doc rendered through
// <BookPage mode="print"> at real size (154×216 mm sheets = 148×210 trim + 3 mm bleed), cover +
// a few pages incl. Arabic captions. Dashed guides (outside <BookPage>) mark the trim (red) and
// the 4 mm text safe zone (blue); `?guides=0` hides them. `?format=landscape` renders the fixture
// as an A5 landscape book (216×154 mm sheets; portrait layouts until M10b) — also with `?sheets=`.
// `?sheets=from-to` instead renders exactly what /print/[bookId] renders (<PrintDocument>, the
// print CSS and the __PRINT_READY__ signal) for that sheet range of the fixture doc, without the
// DB or a token — for Playwright / page.pdf checks. Add `?printAssets=1` to point every photo at
// the print-asset origin (as /print does; images then fail unless the client intercepts them).
// `?bg=tile|wash|photo|mix` adds page backgrounds (M10a A6, see withDevBackgrounds).
// PDF spread checks (M10b A14), with `?sample=` + `?sheets=`: `?lead=N` (0–60) prepends N single
// full-bleed pages, so a spread can straddle the real 20-sheet chunk boundary (lead=14 puts the
// panorama on sheets 19 | 20); `?scale=N` (1–8, with printAssets=1) multiplies the photos' pixel
// sizes, simulating high-res originals so the print plan reaches 300 dpi on spreads.
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import { notFound } from "next/navigation";
import { BookPage } from "@/components/book/BookPage";
import { PrintDocument } from "@/components/print/PrintDocument";
import { PRINT_FONT_CLASSES } from "@/components/print/print-fonts";
import {
  devPreviewDoc,
  devPreviewPhotos,
  devPreviewPhotosWithBackgrounds,
  parseDevBackgrounds,
  parseDevFormat,
  withDevBackgrounds,
} from "@/lib/book/dev-preview";
import { devSampleDoc, devSamplePhotos, parseDevSample } from "@/lib/book/dev-sample";
import { pageMm, sheetMm, type SizeMm } from "@/lib/book/format";
import type { BookDoc } from "@/lib/book/types";
import { BLEED_MM, SAFE_MM } from "@/lib/layouts";
import { printRenderPhotos, printSheetTargets } from "@/lib/pdf/print-doc";

export const dynamic = "force-dynamic";

function Guides({ sheet }: { sheet: SizeMm }) {
  const box = (inset: number, color: string) => (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `${inset}mm`,
        top: `${inset}mm`,
        width: `${sheet.w - 2 * inset}mm`,
        height: `${sheet.h - 2 * inset}mm`,
        outline: `0.3mm dashed ${color}`,
      }}
    />
  );
  return (
    <>
      {box(BLEED_MM, "#dc2626")}
      {box(BLEED_MM + SAFE_MM, "#2563eb")}
    </>
  );
}

function intParam(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** `lead` single full-bleed pages before the sample's pages (spreads stay on even indices for even lead). */
function withLeadPages(doc: BookDoc, lead: number): BookDoc {
  const layout = doc.format === "A5_LANDSCAPE" ? "m-l-full-bleed" : "m-p-full";
  const extra = Array.from({ length: lead }, (_, i) => ({
    id: `lead${i}`,
    chapterId: doc.pages[0]?.chapterId ?? null,
    layout,
    slots: [{ photoId: `sp${40 + (i % 20)}`, crop: { x: 0.5, y: 0.5, zoom: 1 } }],
    caption: null,
  }));
  return { ...doc, pages: [...extra, ...doc.pages] };
}

export default async function DevPrintPreview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const guides = sp.guides !== "0";
  // `?sample=modern-portrait|modern-landscape` (M10c: also geometric-|scrapbook-portrait|landscape, `-ar` for Arabic) (M10b A9): the modern sample book instead of the fixture.
  const sample = parseDevSample(sp.sample);
  const format = sample ? devSampleDoc(sample).format : parseDevFormat(sp.format);
  const bgKind = parseDevBackgrounds(sp.bg);
  const lead = sample ? intParam(sp.lead, 0, 60) : null;
  const base = sample ? (lead ? withLeadPages(devSampleDoc(sample), lead) : devSampleDoc(sample)) : devPreviewDoc(format);
  const doc = bgKind ? withDevBackgrounds(base, bgKind) : base;
  const sheet = sheetMm(format);
  const trim = pageMm(format);
  const photos = sample ? devSamplePhotos() : bgKind ? devPreviewPhotosWithBackgrounds() : devPreviewPhotos();
  if (typeof sp.sheets === "string") {
    const m = /^(\d{1,3})-(\d{1,3})$/.exec(sp.sheets);
    const sheets = m ? printSheetTargets(doc.pages.length, Number(m[1]), Number(m[2])) : null;
    if (!sheets) notFound();
    const k = intParam(sp.scale, 1, 8) ?? 1;
    const shown =
      sp.printAssets === "1"
        ? printRenderPhotos(
            Object.entries(photos).map(([id, p]) => ({
              id,
              width: p?.width ? p.width * k : null,
              height: p?.height ? p.height * k : null,
            })),
          )
        : photos;
    return <PrintDocument doc={doc} photos={shown} captionLang="ar" sheets={sheets} />;
  }
  const pick = ["full-page", "one-portrait", "two-vertical", "three-mixed"];
  const pages = sample
    ? doc.pages.map((_p, i) => i)
    : pick.map((id) => doc.pages.findIndex((p) => p.layout === id)).filter((i) => i >= 0);
  const targets: (number | "cover")[] = ["cover", ...pages];
  return (
    <main className={`bg-neutral-300 p-4 ${PRINT_FONT_CLASSES}`} data-testid="dev-print">
      <h1 className="mb-1 text-lg font-semibold">Print preview (dev only)</h1>
      <p className="mb-4 text-sm text-neutral-700">
        Sheet {sheet.w}×{sheet.h} mm, trim {trim.w}×{trim.h} mm (red), text safe zone {SAFE_MM} mm (blue).
      </p>
      <div className="flex flex-col items-start gap-6">
        {targets.map((t) => (
          <div key={String(t)} className="relative shadow-lg">
            <BookPage doc={doc} page={t} mode="print" photos={photos} captionLang="ar" priority />
            {guides ? <Guides sheet={sheet} /> : null}
          </div>
        ))}
      </div>
    </main>
  );
}

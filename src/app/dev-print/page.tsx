// Dev-only visual check for print mode (D-050 bleed): the dev fixture doc rendered through
// <BookPage mode="print"> at real size (154×216 mm sheets = 148×210 trim + 3 mm bleed), cover +
// a few pages incl. Arabic captions. Dashed guides (outside <BookPage>) mark the trim (red) and
// the 4 mm text safe zone (blue); `?guides=0` hides them.
// 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import { notFound } from "next/navigation";
import { BookPage } from "@/components/book/BookPage";
import { devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
import { BLEED_MM, PAGE_MM, SAFE_MM, SHEET_MM } from "@/lib/layouts";

export const dynamic = "force-dynamic";

function Guides() {
  const box = (inset: number, color: string) => (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `${inset}mm`,
        top: `${inset}mm`,
        width: `${SHEET_MM.w - 2 * inset}mm`,
        height: `${SHEET_MM.h - 2 * inset}mm`,
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

export default async function DevPrintPreview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const guides = (await searchParams).guides !== "0";
  const doc = devPreviewDoc();
  const photos = devPreviewPhotos();
  const pick = ["full-page", "one-portrait", "two-vertical", "three-mixed"];
  const pages = pick.map((id) => doc.pages.findIndex((p) => p.layout === id)).filter((i) => i >= 0);
  const targets: (number | "cover")[] = ["cover", ...pages];
  return (
    <main className="bg-neutral-300 p-4" data-testid="dev-print">
      <h1 className="mb-1 text-lg font-semibold">Print preview (dev only)</h1>
      <p className="mb-4 text-sm text-neutral-700">
        Sheet {SHEET_MM.w}×{SHEET_MM.h} mm, trim {PAGE_MM.w}×{PAGE_MM.h} mm (red), text safe zone {SAFE_MM} mm (blue).
      </p>
      <div className="flex flex-col items-start gap-6">
        {targets.map((t) => (
          <div key={String(t)} className="relative shadow-lg">
            <BookPage doc={doc} page={t} mode="print" photos={photos} captionLang="ar" priority />
            {guides ? <Guides /> : null}
          </div>
        ))}
      </div>
    </main>
  );
}

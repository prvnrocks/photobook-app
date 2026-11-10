// Dev-only font sheet (M10b A3): every registry face with Latin + Arabic samples through the real
// font-family chains (bookFontFamily), plus the modern style roles. `?mode=print` wraps it in the
// print font classes with A5 @page CSS for page.pdf checks (Type0 only, Arabic in the Arabic face);
// default = screen faces (<BookFonts>). 404s in production builds.

import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { BookFonts } from "@/components/book/BookFonts";
import { PRINT_FONT_CLASSES } from "@/components/print/print-fonts";
import { BOOK_FONT_NAMES, BOOK_FONTS, bookFontFamily, type BookFontName } from "@/lib/book/fonts";
import { roleFont, TEXT_ROLES } from "@/lib/design/styles";

export const dynamic = "force-dynamic";

const LATIN = "Summer in Abu Dhabi 2026 — “Beach day” & café · ½ ñ ü ø";
const ARABIC = "رحلة العائلة إلى أبوظبي ٢٠٢٦ — أجمل ليلة بدأت بضحكة";
const MIXED = "Eid with Teta عيد سعيد 2026 → ♥ ★ ✓";

function Sample({ font, weight, italic }: { font: BookFontName; weight: number; italic?: boolean }) {
  const style: CSSProperties = { fontFamily: bookFontFamily(font), fontWeight: weight, fontStyle: italic ? "italic" : "normal" };
  return (
    <div className="border-t border-neutral-200 py-[1.2mm]" data-font={font} data-weight={weight}>
      <div className="font-sans text-[2.4mm] text-neutral-500">
        {BOOK_FONTS[font].label} {weight}
        {italic ? " italic" : ""} · {BOOK_FONTS[font].pair}
      </div>
      <p dir="auto" style={{ ...style, fontSize: "5mm", lineHeight: 1.25 }}>
        {LATIN}
      </p>
      <p dir="auto" lang="ar" style={{ ...style, fontSize: "5mm", lineHeight: 1.45 }}>
        {ARABIC}
      </p>
      <p dir="auto" style={{ ...style, fontSize: "4mm", lineHeight: 1.4 }}>
        {MIXED}
      </p>
    </div>
  );
}

function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <section data-font-sheet="" className="box-border bg-white p-[8mm] text-neutral-900" style={{ width: "148mm", minHeight: "210mm" }}>
      {children}
    </section>
  );
}

export default async function DevFonts({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const print = sp.mode === "print";
  const faces = BOOK_FONT_NAMES.flatMap((f) => [
    ...BOOK_FONTS[f].weights.map((w) => ({ f, w, italic: false })),
    ...(BOOK_FONTS[f].italic ? [{ f, w: 400, italic: true }] : []),
  ]);
  const m10b = faces.filter((x) => BOOK_FONTS[x.f].screenConst);
  const classic = faces.filter((x) => !BOOK_FONTS[x.f].screenConst);
  const sheets = (
    <>
      <Sheet>
        <h1 className="mb-[2mm] font-sans text-[4mm] font-semibold">M10b faces (1/3)</h1>
        {m10b.slice(0, 5).map((x) => (
          <Sample key={`${x.f}${x.w}${x.italic}`} font={x.f} weight={x.w} italic={x.italic} />
        ))}
      </Sheet>
      <Sheet>
        <h1 className="mb-[2mm] font-sans text-[4mm] font-semibold">M10b faces (2/3)</h1>
        {m10b.slice(5).map((x) => (
          <Sample key={`${x.f}${x.w}${x.italic}`} font={x.f} weight={x.w} italic={x.italic} />
        ))}
      </Sheet>
      <Sheet>
        <h1 className="mb-[2mm] font-sans text-[4mm] font-semibold">Modern roles (3/3)</h1>
        {TEXT_ROLES.map((r) =>
          [ "Our summer by the sea", "صيفنا على البحر" ].map((t) => {
            const rf = roleFont("modern", r, t);
            return (
              <p
                key={r + t}
                dir="auto"
                data-role={r}
                data-font={rf.font}
                style={{ fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, fontStyle: rf.fontStyle, textTransform: rf.textTransform, fontSize: "6mm", lineHeight: 1.4 }}
              >
                {t} <span className="font-sans text-[2.4mm] text-neutral-500">({r})</span>
              </p>
            );
          }),
        )}
        <h2 className="mt-[3mm] font-sans text-[3mm] text-neutral-500">Classic faces</h2>
        {classic.map((x) => (
          <p key={`${x.f}${x.w}`} dir="auto" style={{ fontFamily: bookFontFamily(x.f), fontWeight: x.w, fontSize: "3.6mm" }}>
            {x.f} {x.w}: Beach day · {ARABIC}
          </p>
        ))}
      </Sheet>
    </>
  );
  if (print) {
    return (
      <>
        <style>{`@page { size: 148mm 210mm; margin: 0; } html, body { margin: 0; padding: 0; background: #fff; } [data-font-sheet] { break-after: page; } [data-font-sheet]:last-child { break-after: auto; }`}</style>
        <div data-print-document="" className={PRINT_FONT_CLASSES}>
          {sheets}
        </div>
      </>
    );
  }
  return (
    <BookFonts>
      <main className="flex flex-col items-center gap-4 bg-neutral-300 p-4" data-testid="dev-fonts">
        {sheets}
      </main>
    </BookFonts>
  );
}

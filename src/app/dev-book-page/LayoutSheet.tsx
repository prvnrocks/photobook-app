// Dev-only contact sheet for the M30 styles: `/dev-book-page?sheet=<magazine|editorial>-<portrait|
// landscape>` renders EVERY registered layout of that style + format (auto cover, pages, spreads,
// cover styles) as a grid of labelled pages.
// Switches: `&ar=1` Arabic text, `&desc=0` no chapter descriptions, `&cw=<colourway id>`,
// `&mode=edit` edit markup, `&mode=print` the print sheets alone (one per PDF page, print fonts),
// `&photos=real` real photographs from public/dev-photos (real-photos.ts) instead of placeholders.
// Server component: fixtures are built on the server page, only <BookPage> markup ships.

import { BookPage, type RenderPhotos } from "@/components/book/BookPage";
import { printCss } from "@/components/print/PrintDocument";
import { PRINT_FONT_CLASSES } from "@/components/print/print-fonts";
import type { M30SheetItem } from "@/lib/book/dev-m30";

export function LayoutSheet({
  title,
  items,
  photos,
  itemPhotos,
  mode,
  captionLang,
}: {
  title: string;
  items: readonly M30SheetItem[];
  photos: RenderPhotos;
  /** Per-item photos (same order as `items`); an item without an entry uses `photos`. */
  itemPhotos?: readonly RenderPhotos[];
  mode: "view" | "edit" | "print";
  captionLang: "en" | "ar";
}) {
  if (mode === "print") {
    // Same wrapper markup as <PrintDocument>: sheets at real size, print CSS, static print fonts.
    return (
      <>
        <style>{printCss(items[0]?.doc.format)}</style>
        <div data-print-document="" className={PRINT_FONT_CLASSES} data-testid="dev-layout-sheet-print">
          {items.flatMap((it, idx) =>
            it.targets.map((t) => (
              <BookPage
                key={`${it.layout.id}-${t}`}
                doc={it.doc}
                page={t}
                mode="print"
                photos={itemPhotos?.[idx] ?? photos}
                captionLang={captionLang}
                priority
              />
            )),
          )}
        </div>
      </>
    );
  }
  return (
    <main className="bg-neutral-200 p-3 md:p-4" data-testid="dev-layout-sheet">
      <h1 className="mb-3 text-base font-semibold">
        Layout sheet: {title} · {items.length} layouts
      </h1>
      {items.length === 0 ? <p className="text-sm text-neutral-600">No layouts registered for this style and format yet.</p> : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-5 md:grid-cols-3 xl:grid-cols-4">
        {items.map((it, idx) => (
          <figure
            key={it.layout.id}
            className={it.targets.length === 2 ? "col-span-2" : undefined}
            data-testid="dev-sheet-item"
            data-layout-id={it.layout.id}
          >
            <div className={`shadow-md ${it.targets.length === 2 ? "grid grid-cols-2" : ""}`}>
              {it.targets.map((t) => (
                <BookPage
                  key={String(t)}
                  doc={it.doc}
                  page={t}
                  mode={mode}
                  photos={itemPhotos?.[idx] ?? photos}
                  captionLang={captionLang}
                  priority
                />
              ))}
            </div>
            <figcaption className="mt-1 text-xs leading-tight break-all text-neutral-700">
              <span className="font-mono font-medium text-neutral-900">{it.layout.id}</span>
              <span className="block text-neutral-500">
                {it.layout.role} · {it.layout.photoCount} photo{it.layout.photoCount === 1 ? "" : "s"} · {it.layout.name}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}

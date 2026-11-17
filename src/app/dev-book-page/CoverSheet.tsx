// Dev-only contact sheet for M29 cover styles: `/dev-book-page?covers=<theme>-<portrait|landscape>`.
// Every cover of that theme × format (pre-M29 ones marked "existing"), each with an English, a long
// English and a 120-code-point Arabic title. Server component; renders through <BookPage>.

import { BookPage, type RenderPhotos } from "@/components/book/BookPage";
import { coverStylesFor } from "@/lib/book/spreads";
import type { BookDoc, BookFormat, DesignStyle } from "@/lib/book/types";

const AR_120 = Array.from(
  "رحلتنا الطويلة إلى الجبال والبحر مع العائلة كلها في صيف لا ينسى أبدا مليء بالضحك والحب والذكريات الجميلة معا في كل يوم جديد",
)
  .slice(0, 120)
  .join("");
const VARIANTS = [
  { key: "en", title: "Lanes & Light", subtitle: "A week away · 2026", lang: "en" },
  {
    key: "long",
    title: "Our long summer by the sea with grandma, the cousins, three dogs and far too much ice cream every single day",
    subtitle: "Summer 2026 · Abu Dhabi, Muscat and the long road home",
    lang: "en",
  },
  { key: "ar", title: AR_120, subtitle: "أسبوع بعيدًا، ٢٠٢٦", lang: "ar" },
] as const;

export function CoverSheet({ style, format, photos }: { style: DesignStyle; format: BookFormat; photos: RenderPhotos }) {
  const covers = coverStylesFor(format, style);
  const doc = (layout: string, v: (typeof VARIANTS)[number]): BookDoc => ({
    version: 2,
    format,
    occasion: "travel",
    cover: { layout, photoId: "d0", title: v.title, subtitle: v.subtitle },
    chapters: [],
    pages: [],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: style, font: v.lang === "ar" ? "Amiri" : "Cormorant" },
  });
  return (
    <main className="bg-neutral-200 p-4" data-testid="dev-cover-sheet">
      <h1 className="mb-3 text-base font-semibold">
        Cover styles: {style} · {format === "A5_PORTRAIT" ? "portrait" : "landscape"}
      </h1>
      <div className="flex flex-col gap-6">
        {covers.map((l) => (
          <section key={l.id}>
            <h2 className="mb-1 text-sm font-medium">
              {l.name ?? l.id} <span className="text-neutral-500">({l.id}{l.autoPick === false ? "" : " · existing"})</span>
            </h2>
            <div className="grid grid-cols-3 gap-3">
              {VARIANTS.map((v) => (
                <div key={v.key} className="shadow-md">
                  <BookPage doc={doc(l.id, v)} page="cover" mode="view" photos={photos} captionLang={v.lang} priority />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

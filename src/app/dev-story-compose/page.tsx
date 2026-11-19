// Dev-only (Task 7): composed storybook fixtures rendered by the shared <BookPage> — the visual
// regression screens (e2e/task7-story-compose.spec.ts) and the template overflow probe. 404s in
// production builds (incl. Vercel previews, NODE_ENV=production). No DB, no AI, no network:
// fixture storybooks + inline SVG placeholder photos (src/lib/storybook/compose/dev-fixture.ts).
//
//   ?style=modern&format=portrait[&photos=24][&lang=ar][&lowres=5,9][&mode=edit|print]
//       a fixture storybook composed deterministically: cover + every page, each in a
//       <figure data-family data-page-id> (screenshots pick pages by family)
//   ?sheet=modern-portrait[&lang=ar][&all=1]
//       every new story template of that style + format with the longest AI texts (overflow probe)

import { notFound } from "next/navigation";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { BOOK_FORMATS, DESIGN_STYLES } from "@/lib/book/schema";
import type { BookDoc, BookFormat, DesignStyle } from "@/lib/book/types";
import { getPageTemplate } from "@/lib/layouts/templates";
import { composeStoryDoc } from "@/lib/storybook/compose";
import { devStoryRenderPhotos, storyFixture } from "@/lib/storybook/compose/dev-fixture";
import { templateSheetDoc } from "@/lib/storybook/compose/dev-sheet";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function DevStoryCompose({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const lang = one(sp.lang) === "ar" ? "ar" : "en";
  const mode: BookRenderMode = one(sp.mode) === "edit" ? "edit" : one(sp.mode) === "print" ? "print" : "view";

  const sheet = /^([a-z]+)-(portrait|landscape)$/.exec(one(sp.sheet) ?? "");
  if (sheet && (DESIGN_STYLES as readonly string[]).includes(sheet[1]!)) {
    const design = { designStyle: sheet[1] as DesignStyle, format: (sheet[2] === "portrait" ? "A5_PORTRAIT" : "A5_LANDSCAPE") as BookFormat };
    const { doc, photos } = templateSheetDoc(design, lang, one(sp.all) === "1" ? "all" : "new");
    return <Book doc={doc} photos={devStoryRenderPhotos(photos)} mode={mode} lang={lang} title={`templates · ${sheet[0]}${lang === "ar" ? " · Arabic" : ""}`} />;
  }

  const style = (DESIGN_STYLES as readonly string[]).includes(one(sp.style) ?? "") ? (one(sp.style) as DesignStyle) : "classic";
  const format: BookFormat = one(sp.format) === "landscape" ? "A5_LANDSCAPE" : BOOK_FORMATS[0];
  const count = Math.min(120, Math.max(1, Number(one(sp.photos) ?? 24) || 24));
  const lowRes = (one(sp.lowres) ?? "5").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const design = { format, designStyle: style };
  const f = storyFixture({ photos: count, lang, design, lowRes });
  const r = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang, occasion: "travel", bookTitle: null, maxPages: Number(one(sp.max) ?? 20) || 20 });
  return (
    <Book
      doc={r.doc}
      photos={devStoryRenderPhotos(f.photos)}
      mode={mode}
      lang={lang}
      title={`${style} · ${format === "A5_PORTRAIT" ? "portrait" : "landscape"} · ${count} photos${lang === "ar" ? " · Arabic" : ""} — ${r.report.interiorPages} pages, narrative ${Math.round(r.report.balance.narrativeShare * 100)} %`}
    />
  );
}

function Book({ doc, photos, mode, lang, title }: { doc: BookDoc; photos: ReturnType<typeof devStoryRenderPhotos>; mode: BookRenderMode; lang: "en" | "ar"; title: string }) {
  const landscape = doc.format === "A5_LANDSCAPE";
  return (
    <main className="mx-auto max-w-6xl bg-neutral-200 p-3 md:p-6" data-testid="dev-story-compose">
      <h1 className="mb-3 text-base font-semibold" data-testid="dev-story-title">
        {title}
      </h1>
      <div className={`grid gap-4 ${landscape ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 md:grid-cols-3"}`}>
        <figure className="shadow-md" data-family="cover" data-page-id="cover">
          <BookPage doc={doc} page="cover" mode={mode} photos={photos} captionLang={lang} priority />
        </figure>
        {doc.pages.map((p, i) => (
          <figure key={p.id} className="shadow-md" data-family={getPageTemplate(p.layout)?.family ?? "other"} data-page-id={p.id}>
            <BookPage doc={doc} page={i} mode={mode} photos={photos} captionLang={lang} priority />
          </figure>
        ))}
      </div>
    </main>
  );
}

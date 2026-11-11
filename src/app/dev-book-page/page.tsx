// Dev-only visual check for the shared <BookPage> renderer (every layout, edit/view, Arabic
// captions, cover). 404s in production builds (incl. Vercel previews, which run NODE_ENV=production).

import { notFound } from "next/navigation";
import { BookPage } from "@/components/book/BookPage";
import { devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
import { devSampleDoc, devSamplePhotos, parseDevSample } from "@/lib/book/dev-sample";
import { SampleBook } from "./SampleBook";

// `?sample=modern-portrait|modern-landscape` (M10b A9): a modern sample book as open spreads
// (cover alone, then page pairs; spread layouts meet at the fold), one page per row below md.
// Add `&mode=edit` for edit-mode markup.

export default async function DevBookPagePreview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const sample = parseDevSample(sp.sample);
  if (sample) {
    return <SampleBook doc={devSampleDoc(sample)} photos={devSamplePhotos()} mode={sp.mode === "edit" ? "edit" : "view"} title={sample} />;
  }
  const doc = devPreviewDoc();
  const photos = devPreviewPhotos();
  return (
    <main className="mx-auto max-w-5xl p-4">
      <h1 className="mb-4 text-lg font-semibold">BookPage preview (dev only)</h1>
      <section className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <BookPage doc={doc} page="cover" mode="view" photos={photos} priority />
        <BookPage doc={doc} page={0} mode="view" photos={photos} priority captionLang="ar" />
      </section>
      <h2 className="mb-2 font-medium">Edit mode</h2>
      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <BookPage doc={doc} page="cover" mode="edit" photos={{}} />
        {doc.pages.map((p, i) => (
          <BookPage key={p.id} doc={doc} page={i} mode="edit" photos={photos} />
        ))}
      </section>
      <h2 className="mb-2 font-medium">Strip thumbnails (view)</h2>
      <section className="flex gap-2 overflow-x-auto pb-2">
        {doc.pages.map((p, i) => (
          <div key={p.id} className="w-20 shrink-0">
            <BookPage doc={doc} page={i} mode="view" photos={photos} />
          </div>
        ))}
      </section>
    </main>
  );
}

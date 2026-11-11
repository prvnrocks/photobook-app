// Dev-only open-book view of a sample doc (M10b A9): cover alone, then pages[0,1], [2,3], … side by
// side from md up (the pairing editor + viewer use), stacked on phones. Every page is <BookPage>.

import { BookPage, type BookRenderMode, type RenderPhotos } from "@/components/book/BookPage";
import type { BookDoc } from "@/lib/book/types";

export function SampleBook({
  doc,
  photos,
  mode,
  title,
  captionLang = "en",
}: {
  doc: BookDoc;
  photos: RenderPhotos;
  mode: BookRenderMode;
  title: string;
  captionLang?: "en" | "ar";
}) {
  const pairs: number[][] = [];
  for (let i = 0; i < doc.pages.length; i += 2) pairs.push(i + 1 < doc.pages.length ? [i, i + 1] : [i]);
  const landscape = doc.format === "A5_LANDSCAPE";
  return (
    <main className="mx-auto max-w-6xl bg-neutral-200 p-3 md:p-6" data-testid="dev-sample-book">
      <h1 className="mb-3 text-base font-semibold">Sample book: {title} ({mode})</h1>
      <div className="flex flex-col gap-6">
        <div className={`mx-auto w-full shadow-md md:w-1/2 ${landscape ? "" : "max-w-md md:max-w-none"}`}>
          <BookPage doc={doc} page="cover" mode={mode} photos={photos} captionLang={captionLang} priority />
        </div>
        {pairs.map((pair) => (
          <div key={pair[0]} className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-0" data-testid="dev-sample-spread">
            {pair.map((i) => (
              <div key={i} className="shadow-md">
                <BookPage doc={doc} page={i} mode={mode} photos={photos} captionLang={captionLang} priority={i < 2} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}

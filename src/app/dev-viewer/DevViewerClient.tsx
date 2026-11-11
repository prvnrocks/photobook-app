"use client";

// Mounts the real viewer (ViewerShell + flipbook) with the fixture book (dev-only route).

import { useMemo } from "react";
import { ViewerShell } from "@/components/viewer/ViewerShell";
import { devSampleDoc, devSamplePhotos, type DevSample } from "@/lib/book/dev-sample";
import type { BookFormat } from "@/lib/book/types";
import { devViewerDoc, devViewerPhotos } from "@/lib/viewer/dev-fixture";

export function DevViewerClient({
  paid,
  lang,
  pages,
  background,
  format = "A5_PORTRAIT",
  sample = null,
}: {
  paid: boolean;
  lang: "en" | "ar";
  pages: number;
  background: string;
  format?: BookFormat;
  /** Modern sample book (M10b A13) instead of the classic fixture. */
  sample?: DevSample | null;
}) {
  const doc = useMemo(
    () => (sample ? devSampleDoc(sample) : devViewerDoc({ lang, pages, background, format })),
    [sample, lang, pages, background, format],
  );
  const photos = useMemo(() => (sample ? devSamplePhotos() : devViewerPhotos()), [sample]);
  const shareUrl = "https://example.com/b/dev-viewer";
  return (
    <main data-lang={lang}>
      <ViewerShell
        doc={doc}
        photos={photos}
        captionLang={lang}
        title={doc.cover.title}
        isPaid={paid}
        shareUrl={shareUrl}
        shareTitle={doc.cover.title}
      />
    </main>
  );
}

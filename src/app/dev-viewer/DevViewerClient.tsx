"use client";

// Mounts the real viewer (ViewerShell + flipbook) with the fixture book (dev-only route).

import { useMemo } from "react";
import { ViewerShell } from "@/components/viewer/ViewerShell";
import { devViewerDoc, devViewerPhotos } from "@/lib/viewer/dev-fixture";

export function DevViewerClient({
  paid,
  lang,
  pages,
  background,
}: {
  paid: boolean;
  lang: "en" | "ar";
  pages: number;
  background: string;
}) {
  const doc = useMemo(() => devViewerDoc({ lang, pages, background }), [lang, pages, background]);
  const photos = useMemo(() => devViewerPhotos(), []);
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

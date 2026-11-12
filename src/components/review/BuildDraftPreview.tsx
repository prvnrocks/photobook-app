// Read-only strip of the draft book on the build screen (M13 T7, D-070 (3)): the cover and first
// pages of the rule-based album, rendered by the shared <BookPage mode="view"> (never a fork) with
// 512 px thumbs. Not interactive: it shows that the book already exists while AI polishes it.
// Server component (no hooks); the build page passes it into <BuildProgress> as a slot.

import { BookFonts } from "@/components/book/BookFonts";
import { BookPage } from "@/components/book/BookPage";
import type { RenderPhotos } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import type { DraftPreviewItem } from "@/lib/runs/draft-preview";
import { cn } from "@/lib/utils";

export type BuildDraftPreviewProps = {
  doc: BookDoc;
  items: readonly DraftPreviewItem[];
  photos: RenderPhotos;
  captionLang?: string;
};

export function BuildDraftPreview({ doc, items, photos, captionLang }: BuildDraftPreviewProps) {
  const landscape = doc.format === "A5_LANDSCAPE";
  return (
    <BookFonts>
      <div className="min-w-0" data-testid="build-draft" data-format={doc.format ?? "A5_PORTRAIT"}>
        <p className="type-small mb-2 font-medium text-foreground">Your book so far</p>
        {/* Sideways scroll stays inside the strip: the page itself never scrolls sideways at 375 px. */}
        <ol
          // Scrollable → reachable by keyboard (arrow keys scroll it), with a visible focus ring.
          tabIndex={0}
          className="-mx-1 flex snap-x gap-2 overflow-x-auto rounded-md px-1 pt-1 pb-2 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Draft pages (preview)"
          data-testid="build-draft-strip"
        >
          {items.map((item, i) => (
            <li
              key={item === "cover" ? "cover" : doc.pages[item]?.id ?? item}
              className={cn("shrink-0 snap-start", landscape ? "w-40" : "w-28")}
              data-testid="build-draft-page"
            >
              <div className="overflow-hidden rounded-sm shadow-card ring-1 ring-border">
                <BookPage doc={doc} page={item} mode="view" photos={photos} captionLang={captionLang} priority={i < 3} />
              </div>
              <span className="mt-1 block text-center text-xs text-muted-foreground">
                {item === "cover" ? "Cover" : `Page ${item + 1}`}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </BookFonts>
  );
}

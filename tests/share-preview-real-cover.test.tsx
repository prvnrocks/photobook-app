// @vitest-environment jsdom
// Share page preview shows the book's REAL cover (chosen cover style, title, occasion sticker)
// through <BookPage page="cover"> when getPublishState passes `cover`; the generic shelf cover
// (with the title plate) stays the fallback.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SharePreview, type SharePreviewData } from "@/components/publish/SharePreview";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import type { BookDoc } from "@/lib/book/types";

function dom(html: string) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

function preview(layout: string, occasion: BookDoc["occasion"], title = "Sara & Omar"): SharePreviewData {
  const base = devSampleDoc("scrapbook-portrait");
  const doc: BookDoc = { ...base, pages: [], chapters: [], occasion, cover: { ...base.cover, layout, title } };
  return { coverThumbUrl: "https://example.test/t.jpg", format: doc.format, designStyle: "scrapbook", cover: { doc, photos: devSamplePhotos(), captionLang: "en" } };
}

describe("SharePreview with the real cover", () => {
  for (const variant of [{}, { compact: true }, { responsive: true }]) {
    it(`renders the chosen cover layout, its title and stickers, no plate (${JSON.stringify(variant)})`, () => {
      const el = dom(renderToStaticMarkup(<SharePreview preview={preview("s-p-cover-tape", "baby")} title="Sara & Omar" pageCount={12} {...variant} />));
      const real = el.querySelector('[data-testid="share-preview-cover"]')!;
      expect(real).not.toBeNull();
      expect(real.querySelector('[data-layout="s-p-cover-tape"]')).not.toBeNull();
      expect(real.querySelectorAll("[data-decoration]").length).toBeGreaterThan(0);
      expect(real.querySelector('[data-testid="text-coverTitle"]')!.textContent).toBe("Sara & Omar");
      expect(el.querySelector('[data-testid="share-preview-cover-title"]')).toBeNull();
      expect(el.querySelector('[data-testid="book-cover"]')).toBeNull();
    });
  }

  it("the occasion picks the accent sticker (same as editor and viewer)", () => {
    const html = (o: BookDoc["occasion"]) => el(o).querySelector('[data-testid="share-preview-cover"]')!.innerHTML;
    const el = (o: BookDoc["occasion"]) => dom(renderToStaticMarkup(<SharePreview preview={preview("s-p-cover-tape", o)} title="x" pageCount={1} />));
    expect(html("baby")).not.toBe(html("wedding"));
  });

  it("cover: null keeps the generic shelf cover with the title plate", () => {
    const p = { ...preview("s-p-cover-tape", "baby"), cover: null };
    const el = dom(renderToStaticMarkup(<SharePreview preview={p} title="Sara & Omar" pageCount={12} />));
    expect(el.querySelector('[data-testid="share-preview-cover"]')).toBeNull();
    expect(el.querySelector('[data-testid="book-cover"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="share-preview-cover-title"]')).not.toBeNull();
  });
});

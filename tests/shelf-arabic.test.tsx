// M14 final: one Arabic sample book on the home shelf (cover title, preview title, sample line).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShelfCover } from "@/components/marketing/ShelfCover";
import { ShelfPreview } from "@/components/marketing/ShelfPreview";
import { displayTitle, SAMPLE_LINE_MAX_WORDS, SHELF_BOOKS } from "@/lib/marketing/shelf";

const ARABIC = /[؀-ۿ]/;
const arabicBooks = SHELF_BOOKS.filter((b) => b.arabic);
const reunion = SHELF_BOOKS.find((b) => b.id === "family-reunion")!;

describe("Arabic sample book", () => {
  it("exactly one book (Family Reunion) carries Arabic, native script, line ≤ 18 words", () => {
    expect(arabicBooks.map((b) => b.id)).toEqual(["family-reunion"]);
    expect(reunion.category).toBe("family");
    expect(reunion.arabic!.title).toBe("لمّة العائلة");
    expect(reunion.arabic!.title).toMatch(ARABIC);
    expect(reunion.arabic!.line).toMatch(ARABIC);
    expect(reunion.arabic!.line).not.toMatch(/[A-Za-z]/);
    expect(reunion.arabic!.line.trim().split(/\s+/).length).toBeLessThanOrEqual(SAMPLE_LINE_MAX_WORDS);
    // English title stays the accessible name (spine PNG text is English)
    expect(reunion.title).toBe("Family Reunion");
  });

  it("displayTitle prefers Arabic only when present", () => {
    expect(displayTitle(reunion)).toEqual({ text: "لمّة العائلة", lang: "ar" });
    const other = SHELF_BOOKS.find((b) => !b.arabic)!;
    expect(displayTitle(other)).toEqual({ text: other.title, lang: "en" });
  });

  it("built cover shows the Arabic title (lang=ar, dir=auto, Arabic font) with the English subtitle", () => {
    const html = renderToStaticMarkup(<ShelfCover book={reunion} />);
    expect(html).toMatch(/<p lang="ar" data-testid="shelf-cover-title-ar" class="[^"]*font-arabic[^"]*"[^>]*><span dir="auto">لمّة العائلة<\/span>/);
    expect(html).toContain('<span dir="auto">Family Reunion</span>');
    // other built covers unchanged: English title only, no Arabic
    const plain = renderToStaticMarkup(<ShelfCover book={SHELF_BOOKS.find((b) => b.id === "sunday-walks")!} />);
    expect(plain).not.toMatch(ARABIC);
    expect(plain).not.toContain("shelf-cover-title-ar");
  });

  it("preview: Arabic heading (English in its accessible name) and an RTL-safe Arabic sample line", () => {
    const html = renderToStaticMarkup(
      <ShelfPreview book={reunion} open originEl={() => null} onClose={() => {}} cta={<a href="/x">cta</a>} />,
    );
    expect(html).toMatch(/<h2 id="[^"]+" class="[^"]*font-arabic[^"]*"><span lang="ar" dir="auto">لمّة العائلة<\/span><span class="sr-only"> \(Family Reunion\)<\/span><\/h2>/);
    expect(html).toMatch(/<p lang="ar" dir="auto" data-testid="sample-caption-ar" class="[^"]*font-arabic[^"]*">اجتمعنا/);
    expect(html).not.toMatch(/type-eyebrow[^>]*>[^<]*[؀-ۿ]/);
    const plain = renderToStaticMarkup(
      <ShelfPreview book={SHELF_BOOKS[0]} open originEl={() => null} onClose={() => {}} cta={null} />,
    );
    expect(plain).not.toContain("sample-caption-ar");
  });
});

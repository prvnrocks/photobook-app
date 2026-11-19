// Task 10 (requirement 9): the editor, the viewer and the PDF render a storybook from the SAME doc
// through the SAME <BookPage>: every page's texts, chapter titles and photos appear in all three
// modes, in the same order, for both formats. (Pixel parity is covered by the existing goldens.)
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { BookPage } from "@/components/book/BookPage";
import type { BookDoc } from "@/lib/book/types";
import { devStoryPrintBook } from "@/lib/storybook/compose/dev-print-book";

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function render(doc: BookDoc, photos: ReturnType<typeof devStoryPrintBook>["photos"], page: "cover" | number, mode: "edit" | "view" | "print"): string {
  return decode(renderToStaticMarkup(React.createElement(BookPage, { doc, page, mode, photos, captionLang: "en" })));
}

const photoIdsIn = (html: string) => [...html.matchAll(/00000000-0000-4000-8000-\d{12}/g)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i);

describe("one renderer for editor, viewer and PDF", () => {
  for (const [style, format] of [["magazine", "A5_PORTRAIT"], ["classic", "A5_LANDSCAPE"], ["editorial", "A5_LANDSCAPE"]] as const) {
    it(`${style} ${format}: same texts and photos in edit / view / print`, () => {
      const { doc, photos } = devStoryPrintBook(style, format, "en", { photos: 20, edits: true });
      for (const t of ["cover" as const, ...doc.pages.map((_p, i) => i)]) {
        const [edit, view, print] = (["edit", "view", "print"] as const).map((m) => render(doc, photos, t, m));
        const page = t === "cover" ? null : doc.pages[t]!;
        for (const text of page ? (page.texts ?? []).map((x) => x.text) : [doc.cover.title]) {
          for (const html of [edit, view, print]) expect(html).toContain(text.slice(0, 40));
        }
        const ids = photoIdsIn(view);
        expect(photoIdsIn(print)).toEqual(ids);
        expect(photoIdsIn(edit)).toEqual(ids);
      }
    });
  }
});

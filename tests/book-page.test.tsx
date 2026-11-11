import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookCover } from "@/components/book/BookCover";
import { BookPage } from "@/components/book/BookPage";
import { cropToStyle } from "@/lib/book/crop";
import {
  coverRenderModel,
  coverTitleSizeCqw,
  pageRenderModel,
  type RenderPhotos,
} from "@/lib/book/render";
import { slotSizeMm } from "@/lib/book/resolution";
import type { BookDoc, BookPage as DocPage } from "@/lib/book/types";
import { getLayout, LAYOUTS } from "@/lib/layouts";

const AR = "أجمل ليلة بدأت بضحكة";

function page(id: string, layout: string, photoIds: (string | null)[], caption: DocPage["caption"] = null): DocPage {
  return {
    id,
    chapterId: null,
    layout,
    slots: photoIds.map((photoId) => ({ photoId, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
    caption,
  };
}

function makeDoc(pages: DocPage[], cover?: Partial<BookDoc["cover"]>): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "wedding",
    cover: { layout: "cover", photoId: "p1", title: "Sara & Omar", subtitle: "Abu Dhabi · 2026", ...cover },
    chapters: [],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  };
}

const photos: RenderPhotos = {
  p1: { url: "https://x.test/p1.jpg", width: 3000, height: 4000 },
  p2: { url: "https://x.test/p2.jpg", width: 4000, height: 3000 },
  p3: { url: "https://x.test/p3.jpg", width: 1200, height: 1600 },
  p4: { url: "https://x.test/p4.jpg", width: 1600, height: 1600 },
};

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const pct = (n: number) => `${n}%`;

describe("<BookPage> slots", () => {
  const pageLayouts = LAYOUTS.filter((l) => l.role === "page");

  it.each(pageLayouts.map((l) => [l.id, l] as const))("%s renders one positioned slot per layout slot", (_id, layout) => {
    const ids = Array.from({ length: layout.photoCount }, (_, i) => `p${(i % 4) + 1}`);
    const doc = makeDoc([page("pg1", layout.id, ids)]);
    const out = html(<BookPage doc={doc} page={0} mode="view" photos={photos} />);
    expect(count(out, /data-slot-index="/g)).toBe(layout.slots.length);
    expect(count(out, /<img /g)).toBe(layout.slots.length);
    layout.slots.forEach((r, i) => {
      const re = new RegExp(
        `style="left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.w)};height:${pct(r.h)}"[^>]*data-slot-index="${i}"`,
      );
      expect(out).toMatch(re);
    });
    expect(out).toContain('data-layout="' + layout.id + '"');
    expect(out).toContain("aspect-[148/210]");
    expect(out).toContain("container-type:inline-size");
  });

  it("applies the crop maths as absolute % box (no object-fit)", () => {
    const doc = makeDoc([page("pg1", "two-vertical", ["p2", "p3"])]);
    doc.pages[0].slots[0].crop = { x: 0.2, y: 0.5, zoom: 1.5 };
    const m = pageRenderModel(doc, 0, photos)!;
    const mm = slotSizeMm(getLayout("two-vertical")!.slots[0]);
    const expected = cropToStyle(4000, 3000, mm.w, mm.h, { x: 0.2, y: 0.5, zoom: 1.5 });
    expect(m.slots[0].photo?.style).toEqual(expected);
    const out = html(<BookPage doc={doc} page={0} mode="view" photos={photos} />);
    expect(out).toContain(
      `left:${expected.left}%;top:${expected.top}%;width:${expected.width}%;height:${expected.height}%;max-width:none`,
    );
    expect(out).not.toContain("object-fit");
    expect(out).toContain('decoding="async"');
  });

  it("lazy by default, eager with priority and always eager in print", () => {
    const doc = makeDoc([page("pg1", "full-page", ["p1"])]);
    expect(html(<BookPage doc={doc} page={0} mode="view" photos={photos} />)).toContain('loading="lazy"');
    const pri = html(<BookPage doc={doc} page={0} mode="view" photos={photos} priority />);
    expect(pri).toContain('loading="eager"');
    expect(pri).toMatch(/fetchpriority="high"/i);
    expect(html(<BookPage doc={doc} page={0} mode="print" photos={photos} />)).toContain('loading="eager"');
  });

  it("empty slot: 'Add photo' placeholder in edit, blank in view/print", () => {
    const doc = makeDoc([page("pg1", "two-vertical", ["p1", null])]);
    const edit = html(<BookPage doc={doc} page={0} mode="edit" photos={photos} />);
    expect(edit).toContain("Add photo");
    expect(edit).toContain('data-slot-empty="true"');
    for (const mode of ["view", "print"] as const) {
      const out = html(<BookPage doc={doc} page={0} mode={mode} photos={photos} />);
      expect(out).not.toContain("Add photo");
      expect(count(out, /<img /g)).toBe(1);
      expect(count(out, /data-slot-index="/g)).toBe(2);
    }
  });

  it("a photo missing from the photos map renders as an empty slot", () => {
    const doc = makeDoc([page("pg1", "full-page", ["gone"])]);
    expect(html(<BookPage doc={doc} page={0} mode="edit" photos={photos} />)).toContain("Add photo");
    expect(html(<BookPage doc={doc} page={0} mode="view" photos={photos} />)).not.toContain("<img");
  });

  it("slot overlay and caption render props are edit-only", () => {
    const doc = makeDoc([page("pg1", "one-portrait", ["p1"], { text: "Hello", font: "Inter", align: "left", source: "user" })]);
    const props = {
      doc,
      page: 0,
      photos,
      renderSlotOverlay: (i: number) => <span data-testid="ov">ov{i}</span>,
      renderCaption: () => <textarea data-testid="cap-edit" />,
    };
    const edit = html(<BookPage {...props} mode="edit" />);
    expect(edit).toContain("ov0");
    expect(edit).toContain('data-testid="cap-edit"');
    expect(edit).not.toContain('data-testid="page-caption"');
    for (const mode of ["view", "print"] as const) {
      const out = html(<BookPage {...props} mode={mode} />);
      expect(out).not.toContain("ov0");
      expect(out).not.toContain("cap-edit");
      expect(out).toContain('data-testid="page-caption"');
    }
  });

  it("renderCaption is called with null for an empty caption area, never for layouts without one", () => {
    const calls: unknown[] = [];
    const rc = (c: unknown) => {
      calls.push(c);
      return <i>add caption</i>;
    };
    const doc = makeDoc([page("a", "one-portrait", ["p1"]), page("b", "full-page", ["p2"])]);
    expect(html(<BookPage doc={doc} page={0} mode="edit" photos={photos} renderCaption={rc} />)).toContain("add caption");
    expect(html(<BookPage doc={doc} page={1} mode="edit" photos={photos} renderCaption={rc} />)).not.toContain("add caption");
    expect(calls).toEqual([null]);
  });

  it("out-of-range page or unknown layout renders an empty frame, not a crash", () => {
    const doc = makeDoc([page("pg1", "nope", ["p1"])]);
    expect(html(<BookPage doc={doc} page={5} mode="view" photos={photos} />)).toContain('data-page="missing"');
    const out = html(<BookPage doc={doc} page={0} mode="view" photos={photos} />);
    expect(out).not.toContain("<img");
    expect(pageRenderModel(doc, 0, photos)?.knownLayout).toBe(false);
  });

  it("print mode has no edit affordances", () => {
    const doc = makeDoc([page("pg1", "four-grid", [null, null, null, null])]);
    const out = html(<BookPage doc={doc} page={0} mode="print" photos={photos} />);
    expect(out).not.toMatch(/hover:|cursor-|<button|Add photo/);
    expect(out).toContain('data-mode="print"');
  });
});

describe("<BookPage> captions", () => {
  it("Latin caption: dir=auto, no lang, Playfair font, text-align from caption", () => {
    const doc = makeDoc([page("pg1", "one-portrait", ["p1"], { text: "Best night", font: "Playfair", align: "right", source: "ai" })]);
    const out = html(<BookPage doc={doc} page={0} mode="view" photos={photos} />);
    const p = out.match(/<p [^>]*data-testid="page-caption"[^>]*>/)?.[0] ?? "";
    expect(p).toContain('dir="auto"');
    expect(p).not.toContain("lang=");
    expect(p).toContain("font-family:var(--font-playfair), var(--font-cairo), var(--font-tajawal), serif");
    expect(p).toContain("text-align:right");
    expect(p).toMatch(/font-size:[\d.]+cqw/);
    expect(out).toContain("Best night");
  });

  it("Arabic caption gets lang=ar and Cairo", () => {
    const doc = makeDoc([page("pg1", "two-vertical", ["p1", "p2"], { text: AR, font: "Cairo", align: "center", source: "ai" })]);
    const out = html(<BookPage doc={doc} page={0} mode="view" photos={photos} captionLang="ar" />);
    const p = out.match(/<p [^>]*data-testid="page-caption"[^>]*>/)?.[0] ?? "";
    expect(p).toContain('dir="auto"');
    expect(p).toContain('lang="ar"');
    expect(p).toMatch(/font-family:var\(--font-cairo\)/);
    expect(out).toContain(AR);
  });

  it("unknown font falls back to the default for the text (Arabic → Cairo)", () => {
    const doc = makeDoc([page("pg1", "one-portrait", ["p1"], { text: AR, font: "Comic Sans", align: "center", source: "user" })]);
    expect(pageRenderModel(doc, 0, photos)?.caption?.fontFamily).toMatch(/^var\(--font-cairo\)/);
  });

  it("empty caption text renders no caption block in view", () => {
    const doc = makeDoc([page("pg1", "one-portrait", ["p1"], { text: "", font: "Inter", align: "center", source: "user" })]);
    expect(html(<BookPage doc={doc} page={0} mode="view" photos={photos} />)).not.toContain("page-caption");
  });
});

describe("cover", () => {
  it("renders cover photo, title and subtitle via BookPage page='cover'", () => {
    const doc = makeDoc([]);
    const out = html(<BookPage doc={doc} page="cover" mode="view" photos={photos} priority />);
    expect(out).toContain('data-page="cover"');
    expect(out).toContain('src="https://x.test/p1.jpg"');
    expect(out).toContain('loading="eager"');
    expect(out).toMatch(/<h2 dir="auto"[^>]*data-testid="cover-title"[^>]*>Sara &amp; Omar<\/h2>/);
    expect(out).toContain("Abu Dhabi · 2026");
    expect(out).toContain("var(--font-playfair)");
    // Same markup as using BookCover directly.
    expect(out).toBe(html(<BookCover doc={doc} mode="view" photos={photos} priority />));
  });

  it("Arabic cover title gets lang=ar and an Arabic font", () => {
    const doc = makeDoc([], { title: "سارة وعمر", subtitle: "" });
    const m = coverRenderModel(doc, photos);
    expect(m.title.lang).toBe("ar");
    expect(m.title.fontFamily).toMatch(/^var\(--font-cairo\)/);
    const out = html(<BookCover doc={doc} mode="view" photos={photos} />);
    expect(out).not.toContain("cover-subtitle");
  });

  it("no cover photo: placeholder in edit, blank in view", () => {
    const doc = makeDoc([], { photoId: null });
    expect(html(<BookCover doc={doc} mode="edit" photos={photos} />)).toContain("Add photo");
    expect(html(<BookCover doc={doc} mode="view" photos={photos} />)).not.toMatch(/Add photo|<img/);
  });

  it("long titles shrink instead of being cut", () => {
    expect(coverTitleSizeCqw("Sara & Omar")).toBeGreaterThan(coverTitleSizeCqw("a".repeat(60)));
    expect(coverTitleSizeCqw("a".repeat(120))).toBeLessThan(coverTitleSizeCqw("a".repeat(60)));
    const long = "x".repeat(120);
    expect(html(<BookCover doc={makeDoc([], { title: long })} mode="view" photos={photos} />)).toContain(long);
  });
});

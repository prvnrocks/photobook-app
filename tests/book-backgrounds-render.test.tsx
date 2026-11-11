// M10a A6: backgrounds rendered everywhere (colour / texture tile / texture wash / faded photo) in
// edit, view and print; ink switching; print photo ids + image plan for background photos; and a
// guard that print markup never contains a CSS `filter` (A7: rasterises the whole subtree).
// Colour docs stay byte-identical to M9 — proven by tests/golden (not regenerated).
// M10c: the guard also covers shaped / tilted / framed slots, decorations and label plates — the
// test-only M10c layouts are added to the catalogue and a doc using all of them is printed over
// every background kind.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BookCover } from "@/components/book/BookCover";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { PrintDocument } from "@/components/print/PrintDocument";
import { rgbaOf, textureLayerStyle } from "@/lib/book/background-style";
import {
  DEV_BG_PHOTO_UUID,
  devPreviewDoc,
  devPreviewPhotos,
  devPreviewPhotosWithBackgrounds,
  parseDevBackgrounds,
  withDevBackgrounds,
} from "@/lib/book/dev-preview";
import { sheetMm } from "@/lib/book/format";
import { colorInk, resolveBackground, type RenderPhotos } from "@/lib/book/render";
import type { Background, BookDoc, BookFormat, PageBackground } from "@/lib/book/types";
import { BACKGROUND_SWATCHES, textureById, type Texture } from "@/lib/design/backgrounds";
import { BACKGROUND_PRINT_DPI, backgroundPhotoUses, neededPx, planPrintImages, PRINT_DPI } from "@/lib/pdf/image-plan";
import { printPhotoIds, printRenderPhotos, printSheetTargets } from "@/lib/pdf/print-doc";
import { backgroundImageSources } from "@/lib/pdf/print-ready";
import { tailwindFilterClasses } from "./fixtures/no-filter";
import { testM10cDoc } from "./fixtures/test-m10c-layouts";

vi.mock("@/lib/layouts", async (orig) => {
  const { withTestM10c } = await import("./fixtures/test-m10c-layouts");
  return withTestM10c(await orig());
});

const BG = "11111111-1111-4111-8111-111111111111";
const MODES: BookRenderMode[] = ["edit", "view", "print"];
const FORMATS: BookFormat[] = ["A5_PORTRAIT", "A5_LANDSCAPE"];

const photos: RenderPhotos = {
  ...devPreviewPhotos(),
  [BG]: { url: "https://img.test/web/bg.jpg", width: 4000, height: 3000 },
};

const tex = (id: string): Texture => textureById(id)!;
const cream: Background = { kind: "texture", textureId: "paper-cream" };
const blushWash: Background = { kind: "texture", textureId: "watercolour-blush" };
const tintedKraft: Background = { kind: "texture", textureId: "kraft", tint: "#CFE1F0" };
const photoWhite: Background = { kind: "photo", photoId: BG, veil: 0.75, veilColor: "#FFFFFF" };
const photoNavy: Background = { kind: "photo", photoId: BG, veil: 0.6, veilColor: "#1E2A47" };
const navy: Background = { kind: "color", hex: "#1E2A47" };

function docWith(bg: Background, format: BookFormat = "A5_PORTRAIT"): BookDoc {
  const d = devPreviewDoc(format);
  return { ...d, style: { ...d.style, background: bg } };
}

function withPageBg(doc: BookDoc, index: number, bg: PageBackground | null): BookDoc {
  return { ...doc, pages: doc.pages.map((p, i) => (i === index ? { ...p, background: bg } : p)) };
}

const capIdx = (doc: BookDoc) => doc.pages.findIndex((p) => p.caption && p.caption.text);
const page = (doc: BookDoc, i: number, mode: BookRenderMode, ph: RenderPhotos = photos) =>
  renderToStaticMarkup(<BookPage doc={doc} page={i} mode={mode} photos={ph} captionLang="en" />);
const cover = (doc: BookDoc, mode: BookRenderMode, ph: RenderPhotos = photos) =>
  renderToStaticMarkup(<BookCover doc={doc} mode={mode} photos={ph} captionLang="en" />);

describe("resolveBackground", () => {
  it("colour: hex + base, ink from the swatch; non-swatch hex keeps the M9 dark ink", () => {
    expect(resolveBackground(docWith({ kind: "color", hex: "#FFFFFF" }))).toEqual({ kind: "color", hex: "#FFFFFF", baseHex: "#FFFFFF", ink: "dark" });
    expect(resolveBackground(docWith(navy)).ink).toBe("light");
    expect(resolveBackground(docWith({ kind: "color", hex: "#34373c" })).ink).toBe("light"); // charcoal, lower-case
    expect(resolveBackground(docWith({ kind: "color", hex: "#1F2937" })).ink).toBe("dark"); // golden case
    for (const s of BACKGROUND_SWATCHES) expect(colorInk(s.hex)).toBe(s.ink);
  });

  it("texture: catalogue entry, tint, base colour, ink", () => {
    const r = resolveBackground(docWith(cream));
    expect(r).toMatchObject({ kind: "texture", baseHex: tex("paper-cream").baseHex, ink: "dark" });
    expect(r.kind === "texture" && r.texture.id).toBe("paper-cream");
    expect(r.kind === "texture" && "tint" in r).toBe(false);
    expect(resolveBackground(docWith(tintedKraft))).toMatchObject({ kind: "texture", tint: "#CFE1F0" });
  });

  it("photo: src from the map (absent → veil only), veil + ink from veil colour", () => {
    expect(resolveBackground(docWith(photoWhite), null, photos)).toEqual({
      kind: "photo",
      photoId: BG,
      veil: 0.75,
      veilColor: "#FFFFFF",
      baseHex: "#FFFFFF",
      ink: "dark",
      photoSrc: "https://img.test/web/bg.jpg",
    });
    const noMap = resolveBackground(docWith(photoNavy));
    expect(noMap).toMatchObject({ kind: "photo", ink: "light", baseHex: "#1E2A47" });
    expect("photoSrc" in noMap).toBe(false);
  });

  it("page override beats the book default; null override → book default; cover = book default", () => {
    const d = withPageBg(docWith(cream), 1, { ...navy, source: "user" });
    expect(resolveBackground(d, d.pages[1]).kind).toBe("color");
    expect(resolveBackground(d, d.pages[0]).kind).toBe("texture");
    expect(resolveBackground(withPageBg(d, 0, null), d.pages[0]).kind).toBe("texture");
  });
});

describe("textureLayerStyle", () => {
  it("tile: screen = 40 mm of page width in cqw (webp), print = 40 mm (jpg) from the trim corner", () => {
    expect(textureLayerStyle(tex("paper-cream"), "A5_PORTRAIT", "screen")).toEqual({
      backgroundImage: 'url("/design/textures/paper-cream.webp")',
      backgroundRepeat: "repeat",
      backgroundSize: "27.027cqw auto",
      backgroundPosition: "0 0",
    });
    expect(textureLayerStyle(tex("paper-cream"), "A5_LANDSCAPE", "screen").backgroundSize).toBe("19.0476cqw auto");
    expect(textureLayerStyle(tex("paper-cream"), "A5_LANDSCAPE", "print")).toEqual({
      backgroundImage: 'url("/design/textures/paper-cream.jpg")',
      backgroundRepeat: "repeat",
      backgroundSize: "40mm 40mm",
      backgroundPosition: "3mm 3mm",
    });
  });

  it("wash: per-orientation file; screen shows the trim area of the full-sheet image, print covers the sheet", () => {
    expect(textureLayerStyle(tex("watercolour-blush"), "A5_PORTRAIT", "screen")).toEqual({
      backgroundImage: 'url("/design/textures/watercolour-blush-portrait.webp")',
      backgroundRepeat: "no-repeat",
      backgroundSize: "104.0541% 102.8571%",
      backgroundPosition: "center",
    });
    expect(textureLayerStyle(tex("watercolour-blush"), "A5_LANDSCAPE", "print")).toMatchObject({
      backgroundImage: 'url("/design/textures/watercolour-blush-landscape.jpg")',
      backgroundSize: "cover",
    });
  });

  it("rgbaOf", () => {
    expect(rgbaOf("#1E2A47", 0.6)).toBe("rgba(30, 42, 71, 0.6)");
    expect(rgbaOf("#FFFFFF", 0.75)).toBe("rgba(255, 255, 255, 0.75)");
    expect(rgbaOf("nope", 2)).toBe("rgba(255, 255, 255, 1)");
  });
});

describe("<BookPage>/<BookCover> background layers, every kind × mode × format", () => {
  for (const format of FORMATS) {
    for (const mode of MODES) {
      const target = mode === "print" ? "print" : "screen";
      it(`${format} ${mode}: colour = frame background only, no layer`, () => {
        const d = docWith({ kind: "color", hex: "#F5EEDC" }, format);
        const html = page(d, capIdx(d), mode);
        expect(html).toContain("background:#F5EEDC");
        expect(html).not.toContain("data-bg=");
      });

      it(`${format} ${mode}: texture tile — ${target} file, frame base colour`, () => {
        const d = docWith(cream, format);
        const html = page(d, capIdx(d), mode);
        const ext = target === "print" ? "jpg" : "webp";
        expect(html).toContain(`background-image:url(&quot;/design/textures/paper-cream.${ext}&quot;)`);
        expect(html).toContain('data-bg="texture"');
        expect(html).toContain(`background:${tex("paper-cream").baseHex}`);
        expect(html).toContain(target === "print" ? "background-size:40mm 40mm" : "cqw auto");
        expect(html.includes('data-bg-src="/design/textures/paper-cream.jpg"')).toBe(mode === "print");
        // The layer is painted before any slot.
        expect(html.indexOf('data-bg="texture"')).toBeLessThan(html.indexOf("data-slot-index"));
      });

      it(`${format} ${mode}: texture wash — per-orientation ${target} file`, () => {
        const d = docWith(blushWash, format);
        const o = format === "A5_LANDSCAPE" ? "landscape" : "portrait";
        const ext = target === "print" ? "jpg" : "webp";
        expect(page(d, 0, mode)).toContain(`/design/textures/watercolour-blush-${o}.${ext}`);
        expect(cover(d, mode)).toContain(`/design/textures/watercolour-blush-${o}.${ext}`);
      });

      it(`${format} ${mode}: tinted texture — multiply colour layer`, () => {
        const html = page(docWith(tintedKraft, format), 0, mode);
        expect(html).toContain('data-bg="tint"');
        expect(html).toContain("background:#CFE1F0;mix-blend-mode:multiply");
      });

      it(`${format} ${mode}: photo — object-cover <img> + rgba veil`, () => {
        const d = docWith(photoWhite, format);
        const html = page(d, capIdx(d), mode);
        expect(html).toMatch(/<img src="https:\/\/img\.test\/web\/bg\.jpg"[^>]*object-cover[^>]*data-bg="photo"/);
        expect(html).toContain('style="background:rgba(255, 255, 255, 0.75)" data-bg="veil"');
        expect(html).toContain(mode === "print" ? 'loading="eager"' : 'loading="lazy"');
        expect(cover(d, mode)).toContain('data-bg="photo"');
      });
    }
  }

  it("print: the layer covers the whole bleed sheet (sibling before the trim box)", () => {
    for (const bg of [cream, photoWhite]) {
      const html = page(docWith(bg), 0, "print");
      const sheet = html.indexOf('data-print-sheet="true"');
      const layer = html.indexOf("data-bg=");
      const trim = html.indexOf('data-print-trim="true"');
      expect(sheet).toBeLessThan(layer);
      expect(layer).toBeLessThan(trim);
    }
  });

  it("photo background missing from the map → veil only (no broken <img>)", () => {
    const html = page(docWith(photoWhite), 0, "view", devPreviewPhotos());
    expect(html).not.toContain('data-bg="photo"');
    expect(html).toContain('data-bg="veil"');
  });

  it("page override renders its own background; cover uses the book default", () => {
    const d = withPageBg(docWith(cream), 0, { ...photoNavy, source: "ai" });
    expect(page(d, 0, "view")).toContain('data-bg="photo"');
    expect(page(d, 0, "view")).not.toContain('data-bg="texture"');
    expect(cover(d, "view")).toContain('data-bg="texture"');
  });

  it("missing page index renders the book default background", () => {
    const html = page(docWith(cream), 999, "view");
    expect(html).toContain('data-page="missing"');
    expect(html).toContain('data-bg="texture"');
  });
});

describe("ink", () => {
  const capOf = (html: string) => /<p [^>]*data-testid="page-caption"/.exec(html)?.[0] ?? "";
  it("dark ink keeps the M9 classes; light ink = white captions and cover text", () => {
    for (const mode of MODES) {
      const light = [navy, { kind: "color", hex: "#34373C" } as Background, photoNavy];
      for (const bg of light) {
        const d = docWith(bg);
        expect(capOf(page(d, capIdx(d), mode))).toContain("text-white");
        const c = cover(d, mode);
        expect(c).toMatch(/data-cover-text="true"/);
        expect(c).toContain("text-center text-white");
        expect(c).toContain("break-words text-neutral-200");
      }
      for (const bg of [cream, photoWhite, { kind: "color", hex: "#FFFFFF" } as Background]) {
        const d = docWith(bg);
        expect(capOf(page(d, capIdx(d), mode))).toContain("text-neutral-800");
        const c = cover(d, mode);
        expect(c).toContain("text-center text-neutral-900");
        expect(c).toContain("break-words text-neutral-600");
      }
    }
  });

  it("renderCaption receives the ink", () => {
    const seen: string[] = [];
    const d = docWith(navy);
    renderToStaticMarkup(
      <BookPage doc={d} page={capIdx(d)} mode="edit" photos={photos} renderCaption={(_c, _m, ink) => (seen.push(ink), null)} />,
    );
    expect(seen).toEqual(["light"]);
  });
});

describe("print: no CSS filter anywhere (A7 guard)", () => {
  it("print markup of every kind, cover + all pages, both formats has no `filter`", () => {
    for (const format of FORMATS) {
      for (const kind of ["tile", "wash", "photo", "mix"] as const) {
        const doc = withDevBackgrounds(devPreviewDoc(format), kind);
        const ph = devPreviewPhotosWithBackgrounds();
        const shown = printRenderPhotos(Object.entries(ph).map(([id, p]) => ({ id, width: p?.width ?? null, height: p?.height ?? null })));
        const sheets = printSheetTargets(doc.pages.length, 0, doc.pages.length)!;
        const html = renderToStaticMarkup(<PrintDocument doc={doc} photos={shown} captionLang="ar" sheets={sheets} />);
        expect(html).toContain("data-bg=");
        expect(html).not.toMatch(/filter/i);
        expect(tailwindFilterClasses(html)).toEqual([]);
      }
    }
  });

  it("M10c shapes, tilt, frames, shadows, decorations and plates: print markup has no `filter`", () => {
    const shown = printRenderPhotos(Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, width: 3000, height: 2000 })));
    for (const bg of [null, cream, blushWash, tintedKraft, navy] as const) {
      const base = testM10cDoc();
      const doc = bg ? { ...base, style: { ...base.style, background: bg } } : base;
      const sheets = printSheetTargets(doc.pages.length, 0, doc.pages.length)!;
      const html = renderToStaticMarkup(<PrintDocument doc={doc} photos={shown} captionLang="en" sheets={sheets} />);
      expect(html).toContain("clip-path:polygon(");
      expect(html).toContain("transform:rotate(");
      expect(html).toContain("box-shadow:");
      expect(html).toContain("data-decoration=");
      expect(html).toContain("data-text-plate=");
      expect(html).not.toMatch(/filter/i);
      expect(html).not.toMatch(/<(image|text|filter|foreignObject)\b/);
      expect(tailwindFilterClasses(html)).toEqual([]);
    }
  });

  it("the Tailwind class check catches filter utilities (incl. variants, arbitrary values, negatives)", () => {
    const html = [
      'class="blur-sm md:grayscale"',
      'class="hover:drop-shadow-lg sepia brightness-50"',
      'class="contrast-125 saturate-[.5] -hue-rotate-15 invert backdrop-blur"',
      'class="blur grayscale-0 invert-0 backdrop-brightness-75"',
      'class="h-full w-full object-cover shadow-md text-neutral-800 rounded-sm"',
    ].join("");
    expect(tailwindFilterClasses(html)).toEqual([
      "blur-sm", "md:grayscale", "hover:drop-shadow-lg", "sepia", "brightness-50", "contrast-125",
      "saturate-[.5]", "-hue-rotate-15", "invert", "backdrop-blur", "blur", "grayscale-0", "invert-0",
      "backdrop-brightness-75",
    ]);
  });
});

describe("print photo ids + image plan", () => {
  const PLAN_PHOTOS = [
    { id: BG, width: 4000, height: 3000 },
    { id: "d1", width: 4000, height: 2667 },
    { id: "d0", width: 1200, height: 1600 },
  ];

  it("printPhotoIds adds the background photo of each rendered sheet (cover = book default)", () => {
    const d = docWith(photoWhite);
    expect(printPhotoIds(d, ["cover"])).toEqual(["d0", BG]);
    expect(printPhotoIds(d, [0])).toEqual([...d.pages[0].slots.map((s) => s.photoId).filter(Boolean), BG]);
    const o = withPageBg(docWith(cream), 2, { ...photoNavy, source: "user" });
    expect(printPhotoIds(o, ["cover", 0, 1])).not.toContain(BG);
    expect(printPhotoIds(o, [2])).toContain(BG);
    // A null override falls back to the book default.
    expect(printPhotoIds(withPageBg(docWith(photoWhite), 0, null), [0])).toContain(BG);
    // v1-shaped input (hex string background) still works.
    expect(printPhotoIds({ cover: { photoId: "a" }, pages: [], style: { background: "#FFFFFF" } }, ["cover"])).toEqual(["a"]);
  });

  it("backgroundPhotoUses: book default (cover) + overrides", () => {
    expect(backgroundPhotoUses(docWith(cream))).toEqual([]);
    expect(backgroundPhotoUses(docWith(photoWhite))).toEqual([BG]);
    expect(backgroundPhotoUses(withPageBg(docWith(cream), 3, { ...photoNavy, source: "user" }))).toEqual([BG]);
  });

  for (const format of FORMATS) {
    it(`${format}: background photo planned at ${BACKGROUND_PRINT_DPI} dpi for the full sheet (cover-fit)`, () => {
      const d = docWith(photoWhite, format);
      const plan = planPrintImages(d, PLAN_PHOTOS);
      const s = sheetMm(format);
      const n = neededPx(4000, 3000, s.w, s.h, 1, BACKGROUND_PRINT_DPI);
      expect(plan.get(BG)).toEqual({ width: Math.round(n.w), height: Math.round(n.h) });
      // Cover-fit: at least 150 dpi on both sheet axes.
      const t = plan.get(BG)!;
      const scale = Math.max(s.w / 4000, s.h / 3000); // mm per original px
      expect(((t.width / 4000) * 25.4) / scale).toBeCloseTo(150, 0);
    });
  }

  it("a photo used in a slot AND as background gets the larger need (slot at 300 dpi wins)", () => {
    const base = docWith({ kind: "photo", photoId: "d1", veil: 0.75, veilColor: "#FFFFFF" } as Background);
    const withoutBg = planPrintImages(devPreviewDoc(), PLAN_PHOTOS);
    const both = planPrintImages(base, PLAN_PHOTOS);
    expect(both.get("d1")).toEqual(withoutBg.get("d1"));
    // Background only (d1 removed from slots): smaller, 150 dpi need.
    const bgOnly = {
      ...base,
      pages: base.pages.map((p) => ({ ...p, slots: p.slots.map((sl) => (sl.photoId === "d1" ? { ...sl, photoId: null } : sl)) })),
    };
    const t = planPrintImages(bgOnly, PLAN_PHOTOS).get("d1")!;
    const n = neededPx(4000, 2667, 154, 216, 1, 150);
    expect(t).toEqual({ width: Math.round(n.w), height: Math.round(n.h) });
    expect(t.width).toBeLessThan(withoutBg.get("d1")!.width);
  });

  it("background dpi is capped by a lower pass dpi; unknown size → max box", () => {
    const d = docWith(photoWhite);
    const lo = planPrintImages(d, PLAN_PHOTOS, { dpi: 100 }).get(BG)!;
    const n = neededPx(4000, 3000, 154, 216, 1, 100);
    expect(lo).toEqual({ width: Math.round(n.w), height: Math.round(n.h) });
    expect(planPrintImages(d, [{ id: BG, width: null, height: null }]).get(BG)).toEqual({ width: 3000, height: 3000 });
    expect(PRINT_DPI).toBeGreaterThan(BACKGROUND_PRINT_DPI);
  });
});

describe("print ready waits for CSS texture images", () => {
  it("backgroundImageSources: distinct data-bg-src values in order", () => {
    const el = (v: string | null) => ({ getAttribute: () => v }) as unknown as Element;
    const root = { querySelectorAll: () => [el("/a.jpg"), el("/b.jpg"), el("/a.jpg"), el(null), el("")] };
    expect(backgroundImageSources(root)).toEqual(["/a.jpg", "/b.jpg"]);
  });
});

describe("dev fixtures", () => {
  it("parseDevBackgrounds + withDevBackgrounds produce schema-valid photo ids", () => {
    expect(parseDevBackgrounds("mix")).toBe("mix");
    expect(parseDevBackgrounds("x")).toBeNull();
    const d = withDevBackgrounds(devPreviewDoc(), "photo");
    expect(d.style.background).toMatchObject({ kind: "photo", photoId: DEV_BG_PHOTO_UUID });
    expect(devPreviewPhotosWithBackgrounds()[DEV_BG_PHOTO_UUID]).toBeDefined();
  });
});

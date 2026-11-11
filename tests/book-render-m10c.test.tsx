// M10c T8a + T8b: shaped / tilted / framed slots and decorations in the shared renderer. Uses the
// test-only layouts of tests/fixtures/test-m10c-layouts.ts (real geometric / scrapbook layouts land
// separately). Plain layouts are proven byte-identical by tests/golden (not regenerated).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { cropToStyle } from "@/lib/book/crop";
import { pageMm } from "@/lib/book/format";
import { coverRenderModel, pageRenderModel, stickerArt, type RenderPhotos } from "@/lib/book/render";
import { layoutIssues } from "@/lib/book/schema";
import { bleedRect } from "@/lib/book/bleed";
import { clipPathFor, photoRectOf } from "@/lib/book/slot-geometry";
import { DECORATION_STICKER_IDS, plateInk, STICKERS, STICKER_IDS } from "@/lib/design/stickers";
import { STYLE_TOKENS } from "@/lib/design/styles";
import { TEST_M10C_COVER, TEST_M10C_LAYOUTS, TEST_M10C_PAGE, TEST_M10C_SPREAD, testM10cDoc } from "./fixtures/test-m10c-layouts";
import { tailwindFilterClasses } from "./fixtures/no-filter";

vi.mock("@/lib/layouts", async (orig) => {
  const { withTestM10c } = await import("./fixtures/test-m10c-layouts");
  return withTestM10c(await orig());
});

const MODES: BookRenderMode[] = ["edit", "view", "print"];
const photos: RenderPhotos = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [`p${i}`, { url: `https://img.test/p${i}.jpg`, width: 3000, height: 2000 }]),
);
const PAGE = pageMm("A5_PORTRAIT");
const stickerKinds = new Map(STICKER_IDS.map((id) => [id, STICKERS[id].kind] as const));

const html = (page: number | "cover", mode: BookRenderMode, doc = testM10cDoc()) =>
  renderToStaticMarkup(
    <BookPage
      doc={doc}
      page={page}
      mode={mode}
      photos={photos}
      captionLang="en"
      renderSlotOverlay={mode === "edit" ? (i) => <span data-overlay={i} /> : undefined}
    />,
  );

describe("test fixtures", () => {
  it("are valid M10c layouts against the real sticker catalogue", () => {
    for (const l of TEST_M10C_LAYOUTS) {
      expect(layoutIssues(l, { stickerIds: new Set(DECORATION_STICKER_IDS), stickerKinds }), l.id).toEqual([]);
    }
  });
});

describe("render model: slot look (T8a)", () => {
  const m = pageRenderModel(testM10cDoc(), 0, photos)!;
  const byIndex = (i: number) => m.slots.find((s) => s.index === i)!;

  it("paints slots in z order (ties keep slot order)", () => {
    expect(m.slots.map((s) => s.index)).toEqual([2, 3, 4, 5, 1, 0]);
  });

  it("polaroid: rotate, lifted shadow, frame colour, photo rect = photoRectOf, crop on the photo rect", () => {
    const s = byIndex(0);
    const pr = photoRectOf(TEST_M10C_PAGE, 0, "A5_PORTRAIT")!;
    const lifted = STYLE_TOKENS.scrapbook.shadows!.lifted;
    // Drawn shadow: the token's mm offset as % of the slot box (CSS translate), flat colour.
    const tx = Math.round(((lifted.dxMm / (0.5 * PAGE.w)) * 100) * 1e4) / 1e4;
    const ty = Math.round(((lifted.dyMm / (0.36 * PAGE.h)) * 100) * 1e4) / 1e4;
    expect(s.look).toMatchObject({ rotate: -4, shadow: { translate: `${tx}% ${ty}%`, color: lifted.color } });
    expect(s.look!.frame).toMatchObject({ kind: "polaroid", color: STYLE_TOKENS.scrapbook.palette!.frame });
    const f = s.look!.frame!.photo;
    expect(f.x).toBeCloseTo(((pr.x - 8) / 50) * 100, 3);
    expect(f.y).toBeCloseTo(((pr.y - 6) / 36) * 100, 3);
    expect(f.w).toBeCloseTo((pr.w / 50) * 100, 3);
    expect(f.h).toBeCloseTo((pr.h / 36) * 100, 3);
    const photoMm = { w: (pr.w / 100) * PAGE.w, h: (pr.h / 100) * PAGE.h };
    expect(s.photo!.style).toEqual(cropToStyle(3000, 2000, photoMm.w, photoMm.h, { x: 0.5, y: 0.5, zoom: 1 }));
    expect(s.look!.shape).toBeUndefined();
    expect(s.look!.clipPath).toBeUndefined();
  });

  it("rounded + border frame: border-radius outer and inner (radius − inset), soft shadow", () => {
    const s = byIndex(1);
    expect(s.look!.shape).toBe("rounded");
    const w = 0.38 * PAGE.w;
    const h = 0.26 * PAGE.h;
    expect(s.look!.borderRadius).toBe(`${Math.round((4 / w) * 1e6) / 1e4}% / ${Math.round((4 / h) * 1e6) / 1e4}%`);
    expect(s.look!.shadow!.color).toBe(STYLE_TOKENS.scrapbook.shadows!.soft.color);
    expect(s.look!.shadow!.translate).toMatch(/^[\d.]+% [\d.]+%$/);
    expect(s.look!.frame).toMatchObject({ kind: "border", color: "#FFFFFF" });
    expect(s.look!.frame!.borderRadius).toMatch(/% \/ .*%$/);
    expect(s.look!.clipPath).toBeUndefined();
  });

  it("circle: border-radius 50 %, no frame", () => {
    expect(byIndex(2).look).toEqual({ shape: "circle", borderRadius: "50%" });
  });

  it("polygons: clip-path (screen = slot box); the drawn shadow reuses it (no box-shadow)", () => {
    expect(byIndex(3).look!.clipPath).toBe(clipPathFor({ kind: "hexagon" }, TEST_M10C_PAGE.slots[3], TEST_M10C_PAGE.slots[3], PAGE));
    expect(byIndex(3).look!.clipPath).toMatch(/^polygon\(/);
    expect(byIndex(4).look).toMatchObject({ shape: "diamond", clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)" });
    expect(byIndex(4).look!.shadow!.color).toBe(STYLE_TOKENS.scrapbook.shadows!.soft.color);
    expect(byIndex(5).look!.clipPath).toMatch(/^polygon\(/);
  });

  it("print: a bleed polygon is clipped relative to the bleed box (page edges kept)", () => {
    const p = pageRenderModel(testM10cDoc(), 0, photos, "en", { bleed: true })!;
    const hex = p.slots.find((s) => s.index === 3)!;
    const rr = bleedRect(TEST_M10C_PAGE.slots[3], PAGE).pct;
    expect(hex.rect).toEqual(rr);
    expect(hex.look!.clipPath).toBe(clipPathFor({ kind: "hexagon" }, TEST_M10C_PAGE.slots[3], rr, PAGE));
    expect(hex.look!.clipPath).not.toBe(byIndex(3).look!.clipPath);
    // framed / rotated / round slots never bleed: same look in print
    expect(p.slots.find((s) => s.index === 0)!.look).toEqual(byIndex(0).look);
    expect(p.slots.find((s) => s.index === 1)!.look).toEqual(byIndex(1).look);
  });

  it("empty framed slot keeps its look", () => {
    const doc = testM10cDoc();
    doc.pages[0].slots[0] = { photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } };
    const s = pageRenderModel(doc, 0, photos)!.slots.find((x) => x.index === 0)!;
    expect(s.photo).toBeNull();
    expect(s.look!.frame!.kind).toBe("polaroid");
  });
});

describe("render model: decorations + plates (T8b)", () => {
  it("occasion accent resolves from doc.occasion", () => {
    const travel = pageRenderModel(testM10cDoc("travel"), 0, photos)!;
    const wedding = pageRenderModel(testM10cDoc("wedding"), 0, photos)!;
    expect(travel.decorations![0].art.stickerId).toBe("accent-plane");
    expect(wedding.decorations![0].art.stickerId).toBe("accent-rings");
    expect(coverRenderModel(testM10cDoc("baby"), photos).decorations![0].art.stickerId).toBe("accent-moon");
  });

  it("layers, rotation, tape keeps aspect, plates stretch", () => {
    const d = pageRenderModel(testM10cDoc(), 0, photos)!.decorations!;
    expect(d.map((x) => x.layer)).toEqual(["under", "over", "over", "over"]);
    expect(d[1]).toMatchObject({ kind: "tape", rotate: -8 });
    expect(d[1].art.preserveAspectRatio).toBe("xMidYMid meet");
    expect(d[0].art.preserveAspectRatio).toBe("xMidYMid meet");
    expect(stickerArt("plate-label").preserveAspectRatio).toBe("none");
  });

  it("photo corners use the layout's explicit rotate (no inferred turns)", () => {
    const d = pageRenderModel(testM10cDoc(), 0, photos)!.decorations!;
    expect(d[2].rotate).toBeUndefined(); // top-left corner, rotate 0
    expect(d[3].rotate).toBe(180); // bottom-right corner, rotate 180 in the layout
  });

  it("plated date label: plate art, text box from the catalogue, plate ink, rotate, Latin tracking", () => {
    const t = pageRenderModel(testM10cDoc(), 0, photos)!.texts!;
    const date = t.find((x) => x.bind === "dateLabel")!;
    expect(date.rotate).toBe(-3);
    expect(date.plate!.art.stickerId).toBe("plate-label");
    expect(date.plate!.textBox).toEqual(STICKERS["plate-label"].textBox);
    expect(date.plate!.ink).toBe(plateInk("plate-label"));
    expect(date.typography.letterSpacing).toBe("0.12em");
    const chapter = t.find((x) => x.bind === "chapterTitle")!;
    expect(chapter).toMatchObject({ rotate: 2 });
    expect(chapter.plate).toBeUndefined();
  });

  it("Arabic plated text: no letter-spacing, lang ar", () => {
    const doc = testM10cDoc("travel", "جولة في المدينة القديمة");
    const t = pageRenderModel(doc, 1, photos)!.texts ?? [];
    expect(t).toHaveLength(0); // left half: the plated chapter title sits on the right page
    const right = pageRenderModel(doc, 2, photos)!.texts![0];
    expect(right.lang).toBe("ar");
    expect(right.typography.letterSpacing).toBeUndefined();
    expect(right.plate!.art.stickerId).toBe("plate-tag");
  });

  it("spread halves: decorations and the framed slot appear on their own half only", () => {
    const left = pageRenderModel(testM10cDoc(), 1, photos)!;
    const right = pageRenderModel(testM10cDoc(), 2, photos)!;
    expect(left.decorations!.map((d) => d.art.stickerId)).toEqual(["star"]);
    expect(right.decorations!.map((d) => d.art.stickerId)).toEqual(["tape-kraft"]);
    expect(right.decorations![0].rect.x).toBe(40);
    expect(left.slots.map((s) => s.index)).toEqual([0]);
    expect(left.slots[0].look).toBeUndefined();
    expect(right.slots[0]).toMatchObject({ index: 1, look: { rotate: 3 } });
    expect(right.slots[0].rect.x).toBe(10);
  });

  it("cover: framed tilted slot, plated title, rotated subtitle, decorations", () => {
    const c = coverRenderModel(testM10cDoc(), photos);
    expect(c.slot!.look).toMatchObject({ rotate: -3, frame: { kind: "polaroid" } });
    expect(c.panels!.find((p) => p.bind === "coverTitle")!.plate!.art.stickerId).toBe("plate-label");
    expect(c.panels!.find((p) => p.bind === "coverSubtitle")!.rotate).toBe(-2);
    expect(c.decorations!.map((d) => d.layer)).toEqual(["under", "over"]);
    expect(TEST_M10C_COVER.slots).toHaveLength(1);
  });

  it("unknown sticker ids are skipped", () => {
    // The mock catalogue holds the fixture object itself: extend it for this test only.
    const decs = TEST_M10C_SPREAD.decorations as unknown as object[];
    decs.push({ kind: "sticker", id: "no-such", box: { x: 5, y: 5, w: 5, h: 5 }, layer: "over" });
    try {
      expect(pageRenderModel(testM10cDoc(), 1, photos)!.decorations!.map((d) => d.art.stickerId)).toEqual(["star"]);
    } finally {
      decs.pop();
    }
  });
});

describe("markup (editor, flipbook and print share it)", () => {
  for (const mode of MODES) {
    it(`${mode}: page features`, () => {
      const h = html(0, mode);
      expect(h).toContain('data-slot-frame="polaroid"');
      expect(h).toContain('data-slot-rotate="-4"');
      expect(h).toContain("transform:rotate(-4deg)");
      // Crisp drawn shadow: a sibling under the slot with the same tilt, no box-shadow / blur.
      expect(h).toContain('data-slot-shadow="0"');
      expect(h).toContain(`background:${STYLE_TOKENS.scrapbook.shadows!.lifted.color}`);
      expect(h).not.toContain("box-shadow");
      expect(h).toContain('data-slot-shape="circle"');
      expect(h).toContain("border-radius:50%");
      expect(h).toContain("clip-path:polygon(");
      expect(h).toContain('data-slot-photo="true"');
      expect(h).toContain('data-decoration="tape"');
      expect(h).toContain('data-sticker="accent-plane"');
      expect(h).toContain('data-text-plate="plate-label"');
      expect(h).toContain("<path ");
      // every caption/text node is dir=auto
      expect(h.match(/<p /g)!.length).toBe(h.match(/<p dir="auto"/g)!.length);
      expect(h).not.toMatch(/filter/i);
      expect(tailwindFilterClasses(h)).toEqual([]);
      expect(h).not.toMatch(/<(image|text|filter)\b/);
    });

    it(`${mode}: cover + spread halves`, () => {
      for (const p of ["cover", 1, 2] as const) {
        const h = html(p, mode);
        expect(h).not.toMatch(/filter/i);
        expect(tailwindFilterClasses(h)).toEqual([]);
        expect(h).toContain("data-decoration=");
      }
    });
  }

  it("paint order: under decorations → slots (z order) → over decorations → caption → texts", () => {
    const h = html(0, "view");
    const at = (needle: string) => h.indexOf(needle);
    expect(at('data-decoration-layer="under"')).toBeLessThan(at('data-slot-index="2"'));
    expect(at('data-slot-index="1"')).toBeLessThan(at('data-slot-index="0"'));
    expect(at('data-slot-index="0"')).toBeLessThan(at('data-decoration-layer="over"'));
    expect(h.lastIndexOf('data-decoration-layer="over"')).toBeLessThan(at("data-caption-area"));
    expect(at("data-caption-area")).toBeLessThan(at('data-text-panel="dateLabel"'));
  });

  it("decorations never take pointer events; edit overlay sits inside the shaped slot", () => {
    const h = html(0, "edit");
    for (const m of h.matchAll(/<div[^>]*data-decoration="[^"]*"[^>]*>/g)) expect(m[0]).toContain("pointer-events-none");
    expect(h).toMatch(/data-slot-index="0"[^>]*>(?:(?!data-slot-index).)*data-overlay="0"/);
  });

  it("plated text uses the plate's ink class; rotated text is still live text", () => {
    const h = html(0, "view");
    // year role → the subtitle ink family, in the plate's ink (dark plate → light text)
    expect(plateInk("plate-label")).toBe("light");
    const ink = "text-neutral-200";
    expect(h).toMatch(new RegExp(`data-text-plate="plate-label"[^]*?<p dir="auto"[^>]*class="[^"]*${ink}`));
    expect(h).toContain(">12 July</p>");
    expect(h).toContain("transform:rotate(2deg)");
    expect(h).toContain(">Old Town Walk</p>");
  });
});

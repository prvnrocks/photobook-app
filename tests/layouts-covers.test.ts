// M29 T1 (D-080) — cover-style groundwork. Structural rules for EVERY cover layout (pre-M29 and the
// M29 cover styles in src/lib/layouts/{theme}/{format}/covers-m29.ts), catalogue placement of the
// M29 arrays, coverStylesFor / autoCoversFor, and the frozen auto-pick table (bestCoverLayout /
// coverPhotoOrientation must return what main returned — M29 covers are never auto-picked).
// Theme builders: `npx vitest run tests/layouts-covers.test.ts` after adding a cover.

import { describe, expect, it } from "vitest";
import { SUPPORTED_DESIGN_STYLES } from "@/lib/book/book-design";
import { BOOK_FORMATS, layoutIssues } from "@/lib/book/schema";
import { autoCoversFor, coverStylesFor, layoutsFor } from "@/lib/book/spreads";
import type { BookFormat, DesignStyle, Layout } from "@/lib/book/types";
import { CLASSIC_PORTRAIT_LAYOUTS, LAYOUTS, M29_COVERS } from "@/lib/layouts";
import { CLASSIC_LANDSCAPE_LAYOUTS } from "@/lib/layouts/classic/landscape";
import { CLASSIC_LANDSCAPE_COVERS } from "@/lib/layouts/classic/landscape/covers-m29";
import { CLASSIC_PORTRAIT_COVERS } from "@/lib/layouts/classic/portrait/covers-m29";
import { bestCoverLayout, coverPhotoOrientation, type FitOrientation } from "@/lib/layouts/fit";
import { GEOMETRIC_LANDSCAPE_LAYOUTS } from "@/lib/layouts/geometric/landscape";
import { GEOMETRIC_LANDSCAPE_COVERS } from "@/lib/layouts/geometric/landscape/covers-m29";
import { GEOMETRIC_PORTRAIT_LAYOUTS } from "@/lib/layouts/geometric/portrait";
import { GEOMETRIC_PORTRAIT_COVERS } from "@/lib/layouts/geometric/portrait/covers-m29";
import { MODERN_LANDSCAPE_LAYOUTS } from "@/lib/layouts/modern/landscape";
import { MODERN_LANDSCAPE_COVERS } from "@/lib/layouts/modern/landscape/covers-m29";
import { MODERN_PORTRAIT_LAYOUTS } from "@/lib/layouts/modern/portrait";
import { MODERN_PORTRAIT_COVERS } from "@/lib/layouts/modern/portrait/covers-m29";
import { SCRAPBOOK_LANDSCAPE_LAYOUTS } from "@/lib/layouts/scrapbook/landscape";
import { SCRAPBOOK_LANDSCAPE_COVERS } from "@/lib/layouts/scrapbook/landscape/covers-m29";
import { SCRAPBOOK_PORTRAIT_LAYOUTS } from "@/lib/layouts/scrapbook/portrait";
import { SCRAPBOOK_PORTRAIT_COVERS } from "@/lib/layouts/scrapbook/portrait/covers-m29";
import { TEST_FORMATS, TEST_M29_COVERS, TEST_STYLES } from "./fixtures/test-m29-covers";
import { coverRuleIssues, LANDSCAPE_SPINE_MM } from "./helpers/cover-rules";

// M30 T1: styles with a layout catalogue (magazine / editorial are in DESIGN_STYLES before their layouts ship).
const DESIGNS = SUPPORTED_DESIGN_STYLES.flatMap((designStyle) => BOOK_FORMATS.map((format) => ({ format, designStyle })));
const key = (d: { format: BookFormat; designStyle: DesignStyle }) => `${d.designStyle}/${d.format}`;

/** The 8 M29 arrays with the design each must hold. */
const M29_ARRAYS: { name: string; style: DesignStyle; format: BookFormat; list: readonly Layout[] }[] = [
  { name: "CLASSIC_PORTRAIT_COVERS", style: "classic", format: "A5_PORTRAIT", list: CLASSIC_PORTRAIT_COVERS },
  { name: "CLASSIC_LANDSCAPE_COVERS", style: "classic", format: "A5_LANDSCAPE", list: CLASSIC_LANDSCAPE_COVERS },
  { name: "MODERN_PORTRAIT_COVERS", style: "modern", format: "A5_PORTRAIT", list: MODERN_PORTRAIT_COVERS },
  { name: "MODERN_LANDSCAPE_COVERS", style: "modern", format: "A5_LANDSCAPE", list: MODERN_LANDSCAPE_COVERS },
  { name: "GEOMETRIC_PORTRAIT_COVERS", style: "geometric", format: "A5_PORTRAIT", list: GEOMETRIC_PORTRAIT_COVERS },
  { name: "GEOMETRIC_LANDSCAPE_COVERS", style: "geometric", format: "A5_LANDSCAPE", list: GEOMETRIC_LANDSCAPE_COVERS },
  { name: "SCRAPBOOK_PORTRAIT_COVERS", style: "scrapbook", format: "A5_PORTRAIT", list: SCRAPBOOK_PORTRAIT_COVERS },
  { name: "SCRAPBOOK_LANDSCAPE_COVERS", style: "scrapbook", format: "A5_LANDSCAPE", list: SCRAPBOOK_LANDSCAPE_COVERS },
];

/** Every pre-M29 layout, in the pre-M29 LAYOUTS order (frozen arrays). */
const PRE_M29: readonly Layout[] = [
  ...CLASSIC_PORTRAIT_LAYOUTS,
  ...CLASSIC_LANDSCAPE_LAYOUTS,
  ...MODERN_PORTRAIT_LAYOUTS,
  ...MODERN_LANDSCAPE_LAYOUTS,
  ...GEOMETRIC_PORTRAIT_LAYOUTS,
  ...GEOMETRIC_LANDSCAPE_LAYOUTS,
  ...SCRAPBOOK_PORTRAIT_LAYOUTS,
  ...SCRAPBOOK_LANDSCAPE_LAYOUTS,
];

const M29_IDS = new Set(M29_COVERS.map((l) => l.id));
const ALL_COVERS = LAYOUTS.filter((l) => l.role === "cover");

/** What main (673fb76) returned — never regenerate: M29 covers must not change the auto pick. */
const MAIN_AUTO_PICK: Record<string, Record<"portrait" | "landscape" | "square" | "none", string> & { orient: string | null }> = {
  "classic/A5_PORTRAIT": { portrait: "cover", landscape: "cover", square: "cover", none: "cover", orient: null },
  "classic/A5_LANDSCAPE": { portrait: "c-l-cover", landscape: "c-l-cover", square: "c-l-cover", none: "c-l-cover", orient: null },
  "modern/A5_PORTRAIT": {
    portrait: "m-p-cover-strips",
    landscape: "m-p-cover-strips",
    square: "m-p-cover-strips",
    none: "m-p-cover-strips",
    orient: null,
  },
  "modern/A5_LANDSCAPE": {
    portrait: "m-l-cover-panel",
    landscape: "m-l-cover-strip",
    square: "m-l-cover-strip",
    none: "m-l-cover-strip",
    orient: null,
  },
  "geometric/A5_PORTRAIT": { portrait: "g-p-cover", landscape: "g-p-cover", square: "g-p-cover", none: "g-p-cover", orient: null },
  "geometric/A5_LANDSCAPE": { portrait: "g-l-cover", landscape: "g-l-cover", square: "g-l-cover", none: "g-l-cover", orient: "portrait" },
  "scrapbook/A5_PORTRAIT": {
    portrait: "s-p-cover-polaroid",
    landscape: "s-p-cover-polaroid",
    square: "s-p-cover-polaroid",
    none: "s-p-cover-polaroid",
    orient: null,
  },
  "scrapbook/A5_LANDSCAPE": {
    portrait: "s-l-cover-polaroid",
    landscape: "s-l-cover-polaroid",
    square: "s-l-cover-polaroid",
    none: "s-l-cover-polaroid",
    orient: null,
  },
};

describe("M29 cover rules — every cover layout", () => {
  it("there is at least one cover per design", () => {
    for (const d of DESIGNS) expect(coverStylesFor(d.format, d.designStyle).length, key(d)).toBeGreaterThan(0);
  });

  for (const l of ALL_COVERS) {
    it(`${l.id}: one photo, cover texts inside the safe zone, off the spine, not over the photo`, () => {
      expect(coverRuleIssues(l, { m29: M29_IDS.has(l.id) })).toEqual([]);
    });
  }

  it("the rule helper catches what it should (self-test on broken copies of a valid cover)", () => {
    const ok = TEST_M29_COVERS.find((l) => l.format === "A5_LANDSCAPE")!;
    expect(coverRuleIssues(ok, { m29: true })).toEqual([]);
    const issues = (patch: Partial<Layout>) => coverRuleIssues({ ...ok, ...patch } as Layout, { m29: true }).join("\n");
    expect(issues({ autoPick: undefined })).toMatch(/autoPick: false/);
    expect(issues({ id: "test-coverish" })).toMatch(/-cover-/);
    expect(issues({ name: "Cover test" })).toMatch(/Cover: /);
    expect(issues({ texts: undefined })).toMatch(/coverTitle \+ coverSubtitle/);
    expect(issues({ texts: [ok.texts![0]] })).toMatch(/exactly one coverSubtitle/);
    expect(issues({ photoCount: 2, prefers: ["any", "any"], slots: [ok.slots[0], { x: 0, y: 60, w: 10, h: 5 }] })).toMatch(
      /exactly one photo slot/,
    );
    // 1 % of 210 mm = 2.1 mm < 4 mm safe zone; 3 % = 6.3 mm < 10 mm from the spine.
    const near = (x: number) => [{ ...ok.texts![0], box: { ...ok.texts![0].box, x } }, ok.texts![1]];
    expect(issues({ texts: near(1) })).toMatch(/inside the trim/);
    expect(issues({ texts: near(3) })).toMatch(new RegExp(`${LANDSCAPE_SPINE_MM} mm from the spine`));
    expect(issues({ texts: near(5) })).not.toMatch(/inside the trim/);
    // Text over the photo: rejected unless on a plate.
    const over = [{ ...ok.texts![0], box: { x: 20, y: 40, w: 60, h: 10 } }, ok.texts![1]];
    expect(issues({ texts: over })).toMatch(/overlaps the photo/);
    expect(issues({ texts: [{ ...over[0], plate: { id: "plate-label" } }, over[1]] })).not.toMatch(/overlaps the photo/);
    // Diagonal slot: text in the cut-away corner is fine, text over the visible part is not.
    const diag: Partial<Layout> = {
      slots: [{ x: 0, y: 0, w: 100, h: 60, shape: { kind: "polygon", points: [[0, 0], [100, 0], [0, 100]] } }],
    };
    const corner = [{ ...ok.texts![0], box: { x: 70, y: 40, w: 20, h: 10 } }, ok.texts![1]];
    expect(issues({ ...diag, texts: corner })).not.toMatch(/overlaps the photo/);
    expect(issues({ ...diag, texts: [{ ...corner[0], box: { x: 20, y: 10, w: 20, h: 10 } }, corner[1]] })).toMatch(/overlaps the photo/);
  });
});

describe("M29 cover arrays — catalogue placement", () => {
  it("each M29 array holds only covers of its own format + style", () => {
    for (const a of M29_ARRAYS) {
      for (const l of a.list) {
        expect([l.role, l.style, l.format], `${a.name}: ${l.id}`).toEqual(["cover", a.style, a.format]);
      }
    }
  });

  it("M29_COVERS = the 8 arrays in order, appended after every pre-M29 layout (frozen prefix unchanged)", () => {
    expect(M29_COVERS).toEqual(M29_ARRAYS.flatMap((a) => a.list));
    expect(LAYOUTS.slice(0, PRE_M29.length)).toEqual(PRE_M29);
    expect(LAYOUTS.slice(PRE_M29.length)).toEqual(M29_COVERS);
    expect(LAYOUTS).toHaveLength(PRE_M29.length + M29_COVERS.length);
  });

  it("layout ids are unique across the whole catalogue", () => {
    const ids = LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("autoPick:false is set on every M29 cover and on nothing else", () => {
    for (const l of LAYOUTS) expect(l.autoPick === false, l.id).toBe(M29_IDS.has(l.id));
  });

  it("schema: autoPick is allowed only on covers", () => {
    const page = CLASSIC_PORTRAIT_LAYOUTS.find((l) => l.role === "page")!;
    expect(layoutIssues({ ...page, autoPick: false })).toContain("only covers may set autoPick");
    expect(layoutIssues({ ...CLASSIC_PORTRAIT_LAYOUTS[0], autoPick: false })).toEqual([]);
  });

  it("test fixture style/format lists match the schema", () => {
    expect([...TEST_STYLES]).toEqual([...SUPPORTED_DESIGN_STYLES]);
    expect([...TEST_FORMATS]).toEqual([...BOOK_FORMATS]);
  });
});

describe("coverStylesFor / autoCoversFor", () => {
  it("coverStylesFor = all covers of the design: pre-M29 first, then M29, stable order", () => {
    for (const d of DESIGNS) {
      const ids = coverStylesFor(d.format, d.designStyle).map((l) => l.id);
      const pre = PRE_M29.filter((l) => l.role === "cover" && l.format === d.format && l.style === d.designStyle).map((l) => l.id);
      const m29 = M29_ARRAYS.find((a) => a.style === d.designStyle && a.format === d.format)!.list.map((l) => l.id);
      expect(ids, key(d)).toEqual([...pre, ...m29]);
      expect(ids).toEqual(layoutsFor(d.format, d.designStyle, "cover").map((l) => l.id));
      expect(coverStylesFor(d.format, d.designStyle).map((l) => l.id)).toEqual(ids);
    }
  });

  it("autoCoversFor = exactly the pre-M29 covers (never an M29 style), at least one per design", () => {
    for (const d of DESIGNS) {
      const auto = autoCoversFor(d.format, d.designStyle);
      expect(auto.length, key(d)).toBeGreaterThan(0);
      expect(auto.map((l) => l.id)).toEqual(
        PRE_M29.filter((l) => l.role === "cover" && l.format === d.format && l.style === d.designStyle).map((l) => l.id),
      );
      expect(auto.some((l) => M29_IDS.has(l.id))).toBe(false);
    }
  });

  it("bestCoverLayout / coverPhotoOrientation return what main returned for all 8 designs", () => {
    const orients: (FitOrientation | null)[] = ["portrait", "landscape", "square", null];
    for (const d of DESIGNS) {
      const want = MAIN_AUTO_PICK[key(d)];
      for (const o of orients) expect(bestCoverLayout(d, o), `${key(d)} ${o}`).toBe(want[o ?? "none"]);
      expect(coverPhotoOrientation(d), key(d)).toBe(want.orient);
    }
    expect(bestCoverLayout()).toBe("cover");
  });
});

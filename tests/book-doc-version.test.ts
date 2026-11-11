// M10a A1 — book doc v2: parseBookDoc upgrades v1 on read, serializeDoc writes v1 whenever the doc
// uses no v2-only feature. The v1 inputs are the frozen M9 golden fixtures (tests/golden/fixtures/m9),
// so "every existing book" is covered by the same data the render goldens use.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeDoc, upgradeDocV1, usesV2Features } from "@/lib/book/doc-version";
import { MAX_SLOTS_V1, MAX_SLOTS_V2, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, BookDocV1, BookPageV1 } from "@/lib/book/types";
import { parsePublicDoc } from "@/lib/publish/public-doc";
import { baseDocV1, representativeDocV1 } from "./golden/m9-inputs";

const FIXTURES = join(__dirname, "golden", "fixtures", "m9");
const readFixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const PHOTO_A = "11111111-1111-4111-8111-111111111111";
const PHOTO_B = "22222222-2222-4222-8222-222222222222";

/** Every stored v1 doc the M9 goldens render: representative doc, each page case, each cover case. */
function goldenV1Docs(): { name: string; doc: BookDocV1 }[] {
  const inputs = readFixture("inputs.json") as {
    representativeDoc: BookDocV1;
    pageCases: Record<string, Record<string, string>>;
    coverCases: Record<string, string>;
  };
  const out: { name: string; doc: BookDocV1 }[] = [{ name: "representative", doc: inputs.representativeDoc }];
  for (const [layout, cases] of Object.entries(inputs.pageCases)) {
    for (const [name, json] of Object.entries(cases)) {
      const c = JSON.parse(json) as { page: BookPageV1; background?: string };
      out.push({ name: `page/${layout}/${name}`, doc: baseDocV1([c.page], { background: c.background }) });
    }
  }
  for (const [name, json] of Object.entries(inputs.coverCases)) {
    const c = JSON.parse(json) as { cover?: Partial<BookDocV1["cover"]>; font?: string; background?: string };
    out.push({ name: `cover/${name}`, doc: baseDocV1([], { cover: c.cover, font: c.font, background: c.background }) });
  }
  // The public-doc golden's render adapter output is a v1 BookDoc too.
  out.push({ name: "public-doc/renderDoc", doc: readFixture("public-doc.json").renderDoc as BookDocV1 });
  return out;
}

function parsedOrThrow(input: unknown): BookDoc {
  const r = parseBookDoc(input);
  if (!r.ok) throw new Error(`parse failed: ${r.issues.join("; ")}`);
  return r.doc;
}

/** A v2-only doc: landscape, texture default, page photo + colour backgrounds, modern style. */
function v2Doc(): BookDoc {
  const doc = upgradeDocV1(representativeDocV1());
  return {
    ...doc,
    format: "A5_LANDSCAPE",
    style: { background: { kind: "texture", textureId: "paper-cream", tint: "#F2D4CF" }, designStyle: "modern", font: "Playfair" },
    pages: doc.pages.map((p, i) =>
      i === 0
        ? { ...p, background: { kind: "photo", photoId: PHOTO_A, veil: 0.75, veilColor: "#FFFFFF", source: "user" } }
        : i === 1
          ? { ...p, background: { kind: "color", hex: "#1E2A47", source: "ai" } }
          : i === 2
            ? { ...p, background: { kind: "texture", textureId: "kraft", source: "ai" } }
            : p,
    ),
  };
}

describe("v1 → upgrade → serializeDoc round trip (golden fixtures)", () => {
  const docs = goldenV1Docs();

  it("covers the whole golden input set", () => {
    // representative + 6 layouts × page cases + cover cases + render adapter
    expect(docs.length).toBeGreaterThan(100);
  });

  it("every golden v1 doc parses to v2 and serializes back to the identical v1 JSON", () => {
    for (const { name, doc } of docs) {
      const original = clone(doc);
      const parsed = parsedOrThrow(clone(doc));
      expect(parsed.version, name).toBe(2);
      expect(parsed.style.background, name).toEqual({ kind: "color", hex: original.style.background });
      expect(parsed.style.designStyle, name).toBe("classic");
      expect(parsed.format, name).toBe("A5_PORTRAIT");
      expect(usesV2Features(parsed), name).toBe(false);

      const stored = serializeDoc(parsed);
      expect(stored, name).toEqual(original);
      // Byte-identical, key order included (jsonb normalises order anyway; this keeps diffs clean).
      expect(JSON.stringify(stored), name).toBe(JSON.stringify(original));
    }
  });

  it("upgradeDocV1 equals parseBookDoc's upgrade and does not alias the input", () => {
    const v1 = representativeDocV1();
    const up = upgradeDocV1(v1);
    expect(up).toEqual(parsedOrThrow(clone(v1)));
    up.pages[0].slots[0].crop.zoom = 3;
    up.cover.title = "changed";
    expect(v1).toEqual(representativeDocV1());
  });

  it("a doc without meta stays without meta", () => {
    const noMeta: BookDocV1 = representativeDocV1();
    delete noMeta.meta;
    const parsed = parsedOrThrow(noMeta);
    expect("meta" in parsed).toBe(false);
    expect(serializeDoc(parsed)).toEqual(noMeta);
    expect("meta" in serializeDoc(parsed)).toBe(false);
  });

  it("old export rows (doc snapshot, v1) and published snapshots (v1) still parse", () => {
    // Export rows store books.doc as it was (D-047) — a v1 doc.
    const exportRowDoc = clone(representativeDocV1());
    expect(parseBookDoc(exportRowDoc).ok).toBe(true);
    const pub = readFixture("public-doc.json").publicDoc as Record<string, unknown>;
    for (const key of ["en", "ar", "none", "null"]) expect(parsePublicDoc(clone(pub[key])).ok, key).toBe(true);
  });
});

describe("v2 docs", () => {
  it("landscape + texture + photo/colour/texture page backgrounds round-trip as v2", () => {
    const doc = v2Doc();
    expect(usesV2Features(doc)).toBe(true);
    const stored = clone(serializeDoc(doc));
    expect(stored.version).toBe(2);
    const back = parsedOrThrow(stored);
    expect(back).toEqual(doc);
    expect(serializeDoc(back)).toEqual(stored);
  });

  it("photo book background round-trips", () => {
    const doc: BookDoc = {
      ...upgradeDocV1(representativeDocV1()),
      style: { background: { kind: "photo", photoId: PHOTO_B, veil: 0.5, veilColor: "#000000" }, font: "Inter" },
    };
    const stored = clone(serializeDoc(doc));
    expect(stored.version).toBe(2);
    // designStyle is written explicitly (classic) in v2.
    expect(parsedOrThrow(stored)).toEqual({ ...doc, style: { ...doc.style, designStyle: "classic" } });
  });

  it("serializeDoc drops undefined keys and an explicit page.background null", () => {
    const base = upgradeDocV1(representativeDocV1());
    const doc: BookDoc = { ...base, pages: base.pages.map((p) => ({ ...p, background: null, side: undefined })) };
    expect(usesV2Features(doc)).toBe(false);
    expect(serializeDoc(doc)).toEqual(representativeDocV1());
    const v2: BookDoc = { ...doc, format: "A5_LANDSCAPE" };
    const stored = serializeDoc(v2) as BookDoc;
    for (const p of stored.pages) {
      expect("background" in p).toBe(false);
      expect("side" in p).toBe(false);
    }
  });

  it("serializeDoc never aliases the input", () => {
    const doc = v2Doc();
    const stored = serializeDoc(doc) as BookDoc;
    stored.pages[0].slots[0].crop.x = 0;
    (stored.style.background as { tint?: string }).tint = "#000000";
    expect(doc).toEqual(v2Doc());
  });

  it("usesV2Features: each v2-only feature alone forces v2", () => {
    const base = upgradeDocV1(representativeDocV1());
    const page0 = base.pages[0];
    const variants: [string, BookDoc][] = [
      ["landscape", { ...base, format: "A5_LANDSCAPE" }],
      ["texture default", { ...base, style: { ...base.style, background: { kind: "texture", textureId: "linen" } } }],
      [
        "photo default",
        { ...base, style: { ...base.style, background: { kind: "photo", photoId: PHOTO_A, veil: 0.9, veilColor: "#FFFFFF" } } },
      ],
      ["design style", { ...base, style: { ...base.style, designStyle: "scrapbook" } }],
      ["colour page background", { ...base, pages: [{ ...page0, background: { kind: "color", hex: "#FFFFFF", source: "user" } }] }],
      ["spread side", { ...base, pages: [{ ...page0, side: "left" }] }],
      [
        "more than 8 slots",
        { ...base, pages: [{ ...page0, slots: Array.from({ length: MAX_SLOTS_V1 + 1 }, () => ({ ...page0.slots[0], photoId: null })) }] },
      ],
    ];
    for (const [name, doc] of variants) {
      expect(usesV2Features(doc), name).toBe(true);
      const stored = clone(serializeDoc(doc));
      expect(stored.version, name).toBe(2);
      expect(parsedOrThrow(stored), name).toEqual(parsedOrThrow(clone(stored)));
    }
    expect(usesV2Features({ ...base, style: { ...base.style, designStyle: undefined } })).toBe(false);
  });
});

describe("schema strictness", () => {
  const v1 = () => clone(representativeDocV1()) as unknown as Record<string, unknown> & { pages: Record<string, unknown>[]; style: Record<string, unknown> };
  const v2 = () => clone(serializeDoc(v2Doc())) as unknown as Record<string, unknown> & { pages: Record<string, unknown>[]; style: Record<string, unknown> };

  it("rejects unknown versions and v1 docs with v2 values", () => {
    expect(parseBookDoc({ ...v1(), version: 3 }).ok).toBe(false);
    expect(parseBookDoc({ ...v1(), version: undefined }).ok).toBe(false);
    expect(parseBookDoc({ ...v1(), format: "A5_LANDSCAPE" }).ok).toBe(false);
    expect(parseBookDoc({ ...v1(), style: { background: { kind: "color", hex: "#FFFFFF" }, font: "Inter" } }).ok).toBe(false);
    expect(parseBookDoc({ ...v2(), format: "A4" }).ok).toBe(false);
    expect(parseBookDoc({ ...v2(), style: { background: "#FFFFFF", font: "Inter" } }).ok).toBe(false);
  });

  it("keeps strict meta in both versions", () => {
    const meta = { generator: "ai", generatorVersion: 1, runId: null, userEdited: false, extra: 1 };
    expect(parseBookDoc({ ...v1(), meta }).ok).toBe(false);
    expect(parseBookDoc({ ...v2(), meta }).ok).toBe(false);
  });

  it("rejects unknown keys inside backgrounds (book default and page)", () => {
    const d = v2();
    d.style.background = { kind: "color", hex: "#FFFFFF", textureId: "linen" };
    expect(parseBookDoc(d).ok).toBe(false);
    const p = v2();
    p.pages[1].background = { kind: "color", hex: "#FFFFFF", source: "ai", note: "x" };
    expect(parseBookDoc(p).ok).toBe(false);
  });

  it("requires page background source (ai | user)", () => {
    const d = v2();
    d.pages[1].background = { kind: "color", hex: "#FFFFFF" };
    expect(parseBookDoc(d).ok).toBe(false);
    d.pages[1].background = { kind: "color", hex: "#FFFFFF", source: "auto" };
    expect(parseBookDoc(d).ok).toBe(false);
    // The book default has no source.
    const s = v2();
    s.style.background = { kind: "color", hex: "#FFFFFF", source: "user" };
    expect(parseBookDoc(s).ok).toBe(false);
  });

  it("validates background values", () => {
    const bad: unknown[] = [
      { kind: "color", hex: "#FFF" },
      { kind: "color", hex: "white" },
      { kind: "texture", textureId: "marble" },
      { kind: "texture", textureId: "linen", tint: "red" },
      { kind: "photo", photoId: "p-portrait", veil: 0.7, veilColor: "#FFFFFF" },
      { kind: "photo", photoId: PHOTO_A, veil: 0.49, veilColor: "#FFFFFF" },
      { kind: "photo", photoId: PHOTO_A, veil: 0.91, veilColor: "#FFFFFF" },
      { kind: "photo", photoId: PHOTO_A, veil: 0.7 },
      { kind: "gradient", from: "#000000" },
    ];
    for (const background of bad) {
      const d = v2();
      d.style.background = background;
      expect(parseBookDoc(d).ok, JSON.stringify(background)).toBe(false);
    }
    const ok = v2();
    ok.style.background = { kind: "photo", photoId: PHOTO_A, veil: 0.9, veilColor: "#000000" };
    expect(parseBookDoc(ok).ok).toBe(true);
  });

  it("slot cap: 8 for v1, 12 for v2", () => {
    const slot = { photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } };
    const d1 = v1();
    d1.pages[0].slots = Array.from({ length: MAX_SLOTS_V1 + 1 }, () => slot);
    expect(parseBookDoc(d1).ok).toBe(false);
    const d2 = v2();
    d2.pages[0].slots = Array.from({ length: MAX_SLOTS_V2 }, () => slot);
    expect(parseBookDoc(d2).ok).toBe(true);
    d2.pages[0].slots = Array.from({ length: MAX_SLOTS_V2 + 1 }, () => slot);
    expect(parseBookDoc(d2).ok).toBe(false);
  });

  it("side accepts left/right only", () => {
    const d = v2();
    d.pages[0].side = "left";
    expect(parseBookDoc(d).ok).toBe(true);
    d.pages[0].side = "middle";
    expect(parseBookDoc(d).ok).toBe(false);
  });

  it("issues name paths and codes, never values", () => {
    const d = v2();
    d.style.background = { kind: "color", hex: "SECRET-VALUE" };
    const r = parseBookDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).not.toContain("SECRET-VALUE");
  });
});

describe("validateBookDoc on v2", () => {
  // One photo per slot, all known: a doc validateBookDoc accepts, with v2 backgrounds on top.
  function validV2(): { doc: BookDoc; photoIds: Set<string> } {
    // Portrait: the shipping catalogue has only A5 portrait layouts so far (M10b: a layout's
    // format must match doc.format) and only classic ones (M10b A6: a layout's style must match
    // doc.style.designStyle). The backgrounds still make it a v2 doc.
    const base = v2Doc();
    const doc: BookDoc = { ...base, format: "A5_PORTRAIT", style: { ...base.style, designStyle: "classic" } };
    const photoIds = new Set<string>([PHOTO_A]);
    let n = 0;
    const pages = doc.pages
      .filter((p) => ["full-page", "one-portrait", "two-vertical", "two-horizontal", "three-mixed", "four-grid"].includes(p.layout))
      .map((p) => ({
        ...p,
        slots: p.slots.map((s) => {
          const id = `ph-${n++}`;
          photoIds.add(id);
          return { ...s, photoId: id };
        }),
      }));
    photoIds.add("p-portrait"); // cover photo
    return { doc: { ...doc, pages }, photoIds };
  }

  it("a valid v2 doc with backgrounds has no issues", () => {
    const { doc, photoIds } = validV2();
    expect(validateBookDoc(doc, { photoIds, maxPages: 100 })).toEqual([]);
  });

  it("flags layouts whose format differs from the book's (M10b)", () => {
    const { doc, photoIds } = validV2();
    const issues = validateBookDoc({ ...doc, format: "A5_LANDSCAPE" }, { photoIds, maxPages: 100 });
    expect(issues[0]).toBe('cover: layout "cover" is for A5_PORTRAIT, book is A5_LANDSCAPE');
    expect(issues).toContain(`pages[0]: layout "${doc.pages[0].layout}" is for A5_PORTRAIT, book is A5_LANDSCAPE`);
    expect(issues).toHaveLength(1 + doc.pages.length);
  });

  it("flags layouts whose design style differs from the book's (M10b A6, strict)", () => {
    const { doc, photoIds } = validV2();
    const issues = validateBookDoc({ ...doc, style: { ...doc.style, designStyle: "modern" } }, { photoIds, maxPages: 100 });
    expect(issues[0]).toBe('cover: layout "cover" is classic, book is modern');
    expect(issues).toContain(`pages[0]: layout "${doc.pages[0].layout}" is classic, book is modern`);
    expect(issues).toHaveLength(1 + doc.pages.length);
    // An absent designStyle counts as classic.
    const noStyle = { ...doc.style };
    delete noStyle.designStyle;
    expect(validateBookDoc({ ...doc, style: noStyle }, { photoIds, maxPages: 100 })).toEqual([]);
  });

  it("flags unknown background photos (page override and book default)", () => {
    const { doc, photoIds } = validV2();
    const unknownPage: BookDoc = {
      ...doc,
      pages: doc.pages.map((p, i) => (i === 0 ? { ...p, background: { kind: "photo", photoId: PHOTO_B, veil: 0.6, veilColor: "#FFFFFF", source: "user" } } : p)),
    };
    expect(validateBookDoc(unknownPage, { photoIds, maxPages: 100 })).toEqual(["pages[0].background: unknown photo"]);
    const unknownDefault: BookDoc = {
      ...doc,
      style: { ...doc.style, background: { kind: "photo", photoId: PHOTO_B, veil: 0.6, veilColor: "#FFFFFF" } },
    };
    expect(validateBookDoc(unknownDefault, { photoIds, maxPages: 100 })).toEqual(["style.background: unknown photo"]);
  });

  it("a background photo may also be placed in a slot", () => {
    const { doc, photoIds } = validV2();
    const slotted: BookDoc = {
      ...doc,
      pages: doc.pages.map((p, i) => (i === 3 ? { ...p, slots: p.slots.map((s, j) => (j === 0 ? { ...s, photoId: PHOTO_A } : s)) } : p)),
    };
    expect(validateBookDoc(slotted, { photoIds, maxPages: 100 })).toEqual([]);
  });
});

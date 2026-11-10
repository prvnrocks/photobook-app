import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import type { RenderPhotos } from "@/lib/book/render";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import {
  parsePublicDoc,
  publicDocToRenderDoc,
  publicPhotoIds,
  toPublicDoc,
  type PublicBookDoc,
} from "@/lib/publish/public-doc";
import { representativeDoc } from "./golden/m9-inputs";

const crop = (x = 0.5, y = 0.5, zoom = 1) => ({ x, y, zoom });

/** A doc carrying every private field we know of, plus unknown extras a buggy writer might add. */
function fullDoc(): BookDoc {
  const doc = {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "wedding",
    cover: { layout: "cover", photoId: "p1", title: "Sara & Omar", subtitle: "Abu Dhabi · 2026" },
    chapters: [
      { id: "c1", title: "The henna night", dateLabel: "March 2026", place: "Al Ain, UAE" },
      { id: "c2", title: "ليلة العمر", dateLabel: "March 2026", place: null },
    ],
    pages: [
      {
        id: "pg1",
        chapterId: "c1",
        layout: "one-portrait",
        slots: [{ photoId: "p2", crop: crop(0.3, 0.7, 1.4) }],
        caption: { text: "Hands painted for the big day", font: "Playfair", align: "center", source: "ai" },
      },
      {
        id: "pg2",
        chapterId: "c2",
        layout: "two-vertical",
        slots: [
          { photoId: "p3", crop: crop() },
          { photoId: null, crop: crop() },
        ],
        caption: { text: "أجمل ليلة بدأت بضحكة", font: "Cairo", align: "right", source: "user" },
      },
      {
        id: "pg3",
        chapterId: null,
        layout: "four-grid",
        slots: [
          { photoId: "p4", crop: crop() },
          { photoId: "p1", crop: crop(0.1, 0.9, 2) },
          { photoId: "p5", crop: crop() },
          { photoId: "p6", crop: crop() },
        ],
        caption: null,
      },
      { id: "pg4", chapterId: "c2", layout: "full-page", slots: [{ photoId: "p2x", crop: crop() }], caption: null },
    ],
    style: { background: "#FAF7F2", font: "Playfair" },
    meta: { generator: "ai", generatorVersion: 1, runId: "6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b", userEdited: true },
  };
  const parsed = parseBookDoc(doc);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.doc;
}

const photos: RenderPhotos = Object.fromEntries(
  ["p1", "p2", "p3", "p4", "p5", "p6", "p2x"].map((id, i) => [
    id,
    { url: `https://x.test/${id}.jpg`, width: i % 2 ? 4000 : 3000, height: i % 2 ? 3000 : 4000 },
  ]),
);

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe("toPublicDoc", () => {
  it("drops meta, caption source, chapter place, occasion and unknown keys (no raw timestamps, GPS/place or ai)", () => {
    const doc = fullDoc() as BookDoc & Record<string, unknown>;
    // Simulate extras that slipped past a non-parsing writer.
    const dirty = {
      ...doc,
      takenAt: "2026-03-12T18:42:07Z",
      chapters: doc.chapters.map((c) => ({ ...c, takenAt: "2026-03-12T18:42:07Z", startAt: 1773340927000 })),
      pages: doc.pages.map((p) => ({
        ...p,
        storagePath: "u/1/p.jpg",
        slots: p.slots.map((s) => ({ ...s, gps: { lat: 24.4, lng: 54.4 }, ai: { description: "x" } })),
      })),
      cover: { ...doc.cover, ai: "secret" },
    } as unknown as BookDoc;
    const pub = toPublicDoc(dirty);
    const keys = keysDeep(pub);
    for (const k of ["meta", "source", "place", "startAt", "occasion", "takenAt", "storagePath", "gps", "ai", "runId", "userEdited", "generator", "lat", "lng", "path"]) {
      expect(keys.has(k), k).toBe(false);
    }
    const json = JSON.stringify(pub);
    for (const s of ["Al Ain", "2026-03-12T", "1773340927000", "6f1d2a3b", "u/1/p.jpg", "secret", "24.4"]) {
      expect(json).not.toContain(s);
    }
    // Coarse chapter date labels are part of the shared album (D-040 "title · date").
    expect(pub.chapters.map((c) => c.dateLabel)).toEqual(["March 2026", "March 2026"]);
    expect(parsePublicDoc(pub)).toEqual({ ok: true, doc: pub });
  });

  it("keeps everything the renderer needs", () => {
    const doc = fullDoc();
    const pub = toPublicDoc(doc);
    expect(pub.cover).toEqual(doc.cover);
    // No v2 feature → v1 snapshot: the colour background is stored as its hex.
    expect(pub.version).toBe(1);
    expect(pub.style).toEqual({ background: "#FAF7F2", font: doc.style.font });
    expect(pub.chapters).toEqual([
      { id: "c1", title: "The henna night", dateLabel: "March 2026" },
      { id: "c2", title: "ليلة العمر", dateLabel: "March 2026" },
    ]);
    expect(pub.pages.map((p) => [p.id, p.chapterId, p.layout])).toEqual(doc.pages.map((p) => [p.id, p.chapterId, p.layout]));
    expect(pub.pages.map((p) => p.slots)).toEqual(doc.pages.map((p) => p.slots));
    expect(pub.pages[1].caption).toEqual({ text: "أجمل ليلة بدأت بضحكة", font: "Cairo", align: "right" });
  });

  it("renders identical markup through <BookPage> (cover + every page)", () => {
    const doc = fullDoc();
    const render = publicDocToRenderDoc(toPublicDoc(doc));
    expect(parseBookDoc(render).ok).toBe(true);
    expect(render.chapters.map((c) => [c.id, c.title, c.dateLabel, c.place])).toEqual(
      doc.chapters.map((c) => [c.id, c.title, c.dateLabel, null]),
    );
    const targets: (number | "cover")[] = ["cover", ...doc.pages.map((_, i) => i)];
    for (const captionLang of ["en", "ar"]) {
      for (const page of targets) {
        const a = renderToStaticMarkup(<BookPage doc={doc} page={page} mode="view" photos={photos} captionLang={captionLang} />);
        const b = renderToStaticMarkup(<BookPage doc={render} page={page} mode="view" photos={photos} captionLang={captionLang} />);
        expect(b).toBe(a);
        expect(a.length).toBeGreaterThan(50);
      }
    }
    const pa = renderToStaticMarkup(<BookPage doc={doc} page={0} mode="print" photos={photos} />);
    const pb = renderToStaticMarkup(<BookPage doc={render} page={0} mode="print" photos={photos} />);
    expect(pb).toBe(pa);
  });

  it("is a deep copy (mutating the result does not touch the source)", () => {
    const doc = fullDoc();
    const pub = toPublicDoc(doc);
    pub.pages[0].slots[0].crop.x = 0.99;
    pub.cover.title = "changed";
    expect(doc.pages[0].slots[0].crop.x).toBe(0.3);
    expect(doc.cover.title).toBe("Sara & Omar");
  });
});

describe("parsePublicDoc", () => {
  it("rejects extra keys and full docs", () => {
    const pub = toPublicDoc(fullDoc());
    expect(parsePublicDoc(fullDoc()).ok).toBe(false);
    expect(parsePublicDoc({ ...pub, meta: {} }).ok).toBe(false);
    const withSource = structuredClone(pub) as PublicBookDoc;
    (withSource.pages[0].caption as Record<string, unknown>).source = "ai";
    expect(parsePublicDoc(withSource).ok).toBe(false);
    expect(parsePublicDoc(null).ok).toBe(false);
    expect(parsePublicDoc({}).ok).toBe(false);
  });
});

describe("publicPhotoIds", () => {
  it("distinct ids, cover first, page order, no nulls", () => {
    expect(publicPhotoIds(toPublicDoc(fullDoc()))).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p2x"]);
  });

  it("handles a cover without photo and empty slots", () => {
    const pub = toPublicDoc(fullDoc());
    pub.cover.photoId = null;
    pub.pages = [pub.pages[1]];
    expect(publicPhotoIds(pub)).toEqual(["p3"]);
  });
});

// ---------------------------------------------------------------- M10a A4: v1 | v2 snapshots

const PH_BG = "33333333-3333-4333-8333-333333333333";
const PH_PAGE_BG = "44444444-4444-4444-8444-444444444444";

/** Landscape doc with a texture book background and photo / texture / colour page backgrounds. */
function v2Doc(): BookDoc {
  const base = fullDoc();
  return {
    ...base,
    format: "A5_LANDSCAPE",
    style: { background: { kind: "texture", textureId: "linen", tint: "#F5EEDC" }, designStyle: "modern", font: "Playfair" },
    pages: base.pages.map((p, i) =>
      i === 0
        ? { ...p, background: { kind: "photo", photoId: PH_PAGE_BG, veil: 0.75, veilColor: "#FFFFFF", source: "user" } }
        : i === 1
          ? { ...p, background: { kind: "texture", textureId: "kraft", source: "ai" }, side: "left" }
          : i === 2
            ? { ...p, background: { kind: "color", hex: "#1E2A47", source: "ai" }, side: "right" }
            : p,
    ),
  };
}

/** Strip every page-background `source` (the only thing the public doc drops from a render doc). */
function withoutBgSource(doc: BookDoc): unknown {
  const c = JSON.parse(JSON.stringify(doc)) as { pages: { background?: Record<string, unknown> }[] };
  for (const p of c.pages) if (p.background) delete p.background.source;
  return c;
}

describe("v2 snapshot", () => {
  it("landscape + texture + photo backgrounds: toPublicDoc → JSON → parse → render doc equals the source", () => {
    const doc = v2Doc();
    expect(parseBookDoc(doc).ok).toBe(true);
    const pub = toPublicDoc(doc, { captionLang: "ar" });
    expect(pub.version).toBe(2);
    const parsed = parsePublicDoc(JSON.parse(JSON.stringify(pub)));
    expect(parsed).toEqual({ ok: true, doc: pub });
    if (!parsed.ok) return;
    const render = publicDocToRenderDoc(parsed.doc);
    expect(parseBookDoc(render).ok).toBe(true);
    const expected: BookDoc = {
      ...doc,
      occasion: "other",
      chapters: doc.chapters.map((c) => ({ ...c, place: null })),
      pages: doc.pages.map((p) => ({ ...p, caption: p.caption ? { ...p.caption, source: "user" } : null })),
    };
    delete expected.meta;
    expect("meta" in render).toBe(false);
    expect(withoutBgSource(render)).toEqual(withoutBgSource(expected));
    // Page-background source is filled with the neutral "user" (render-only).
    expect(render.pages.slice(0, 3).map((p) => p.background?.source)).toEqual(["user", "user", "user"]);
  });

  it("drops page-background source, meta, place, occasion; keeps format, style and side", () => {
    const pub = toPublicDoc(v2Doc());
    if (pub.version !== 2) throw new Error("expected v2");
    const keys = keysDeep(pub);
    for (const k of ["meta", "source", "place", "occasion", "runId"]) expect(keys.has(k), k).toBe(false);
    expect(pub.format).toBe("A5_LANDSCAPE");
    expect(pub.style).toEqual({ background: { kind: "texture", textureId: "linen", tint: "#F5EEDC" }, designStyle: "modern", font: "Playfair" });
    expect(pub.pages.map((p) => [p.background ?? null, p.side ?? null])).toEqual([
      [{ kind: "photo", photoId: PH_PAGE_BG, veil: 0.75, veilColor: "#FFFFFF" }, null],
      [{ kind: "texture", textureId: "kraft" }, "left"],
      [{ kind: "color", hex: "#1E2A47" }, "right"],
      [null, null],
    ]);
    expect("background" in pub.pages[3]).toBe(false);
    expect("side" in pub.pages[3]).toBe(false);
  });

  it("renders identical markup to the source doc", () => {
    const doc = v2Doc();
    const render = publicDocToRenderDoc(toPublicDoc(doc));
    const ph: RenderPhotos = { ...photos, [PH_BG]: photos.p1, [PH_PAGE_BG]: photos.p2 };
    for (const page of ["cover" as const, ...doc.pages.map((_, i) => i)]) {
      for (const mode of ["view", "print"] as const) {
        const a = renderToStaticMarkup(<BookPage doc={doc} page={page} mode={mode} photos={ph} />);
        expect(renderToStaticMarkup(<BookPage doc={render} page={page} mode={mode} photos={ph} />)).toBe(a);
      }
    }
  });

  it("a single v2 feature (page background only) switches the snapshot to v2", () => {
    const doc = fullDoc();
    doc.pages[2] = { ...doc.pages[2], background: { kind: "color", hex: "#000000", source: "user" } };
    expect(toPublicDoc(doc).version).toBe(2);
    // An explicit null page background is "none": stays v1.
    const plain = fullDoc();
    plain.pages[2] = { ...plain.pages[2], background: null };
    expect(toPublicDoc(plain)).toEqual(toPublicDoc(fullDoc()));
  });

  it("strict: rejects unknown keys anywhere, a page-background source and a v1 snapshot with v2 keys", () => {
    const pub = toPublicDoc(v2Doc());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form JSON mutation in a test
    const mutate = (f: (d: any) => void) => {
      const c = JSON.parse(JSON.stringify(pub));
      f(c);
      return parsePublicDoc(c).ok;
    };
    expect(mutate(() => {})).toBe(true);
    expect(mutate((d) => (d.meta = {}))).toBe(false);
    expect(mutate((d) => (d.occasion = "wedding"))).toBe(false);
    expect(mutate((d) => (d.pages[0].background.source = "user"))).toBe(false);
    expect(mutate((d) => (d.pages[0].background.extra = 1))).toBe(false);
    expect(mutate((d) => (d.pages[0].extra = 1))).toBe(false);
    expect(mutate((d) => (d.pages[0].background = null))).toBe(false);
    expect(mutate((d) => (d.style.extra = 1))).toBe(false);
    expect(mutate((d) => (d.style.background.extra = 1))).toBe(false);
    expect(mutate((d) => delete d.style.designStyle)).toBe(false);
    expect(mutate((d) => (d.style.background = { kind: "texture", textureId: "nope" }))).toBe(false);
    expect(mutate((d) => (d.style.background = { kind: "photo", photoId: "not-a-uuid", veil: 0.7, veilColor: "#FFFFFF" }))).toBe(false);
    expect(mutate((d) => (d.format = "A4"))).toBe(false);
    expect(mutate((d) => (d.version = 3))).toBe(false);
    // v1 snapshot shape must not carry v2 keys.
    const v1 = JSON.parse(JSON.stringify(toPublicDoc(fullDoc())));
    expect(parsePublicDoc(v1).ok).toBe(true);
    expect(parsePublicDoc({ ...v1, format: "A5_LANDSCAPE" }).ok).toBe(false);
    expect(parsePublicDoc({ ...v1, style: { ...v1.style, designStyle: "classic" } }).ok).toBe(false);
    expect(parsePublicDoc({ ...v1, pages: [{ ...v1.pages[0], side: "left" }] }).ok).toBe(false);
  });

  it("publicPhotoIds includes background photos (book default + page) after content photos", () => {
    const doc = v2Doc();
    doc.style.background = { kind: "photo", photoId: PH_BG, veil: 0.6, veilColor: "#F5EEDC" };
    // A background photo that is also on a page is listed once.
    doc.pages[3] = { ...doc.pages[3], background: { kind: "photo", photoId: PH_PAGE_BG, veil: 0.9, veilColor: "#000000", source: "ai" } };
    const ids = publicPhotoIds(toPublicDoc(doc));
    expect(ids).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p2x", PH_BG, PH_PAGE_BG]);
    expect(ids[0]).toBe("p1");
  });

  it("is a deep copy for v2 too", () => {
    const doc = v2Doc();
    const pub = toPublicDoc(doc);
    if (pub.version !== 2 || pub.style.background.kind !== "texture" || pub.pages[0].background?.kind !== "photo") {
      throw new Error("unexpected shape");
    }
    pub.style.background.tint = "#000000";
    pub.pages[0].background.veil = 0.5;
    expect(doc.style.background).toEqual({ kind: "texture", textureId: "linen", tint: "#F5EEDC" });
    expect(doc.pages[0].background).toMatchObject({ veil: 0.75 });
  });
});

describe("v1 path unchanged", () => {
  it("republishing a v1 book writes the byte-identical frozen M9 snapshot", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "golden", "fixtures", "m9", "public-doc.json"), "utf8"));
    const doc = representativeDoc();
    const cases = { en: { captionLang: "en" as const }, ar: { captionLang: "ar" as const }, none: {}, null: { captionLang: null } };
    for (const [key, opts] of Object.entries(cases)) {
      expect(JSON.stringify(toPublicDoc(doc, opts)), key).toBe(JSON.stringify(fixture.publicDoc[key]));
      const parsed = parsePublicDoc(JSON.parse(JSON.stringify(fixture.publicDoc[key])));
      expect(parsed.ok, key).toBe(true);
    }
  });
});

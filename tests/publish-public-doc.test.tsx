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
    // Snapshot stays v1 until M10a A4: the colour background is stored as its hex.
    expect(pub.style).toEqual({ background: doc.style.background.kind === "color" ? doc.style.background.hex : null, font: doc.style.font });
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

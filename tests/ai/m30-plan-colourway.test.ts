// M30 T9b — the AI path's doc writer (planToDoc) for magazine / editorial: only the stamping (the
// accent colourway from the photos' colours) and the design plumbing. Prompt / agent work is the
// next task; the plans here are hand-written.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { planToDoc } from "@/lib/ai/plan-to-doc";
import type { AlbumPlan } from "@/lib/ai/schemas";
import type { StoryPhoto } from "@/lib/ai/story";
import type { BookDesign } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { BOOK_FORMATS, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { fullPageLayout } from "@/lib/layouts/fit";
import { aliasMaps, RUN_ID, storyBook } from "../helpers/story-fixtures";

const BLUE = "#5B8DB8";

function photoSet(n: number, color: string | null): StoryPhoto[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    width: 3024,
    height: 4032,
    takenAt: new Date(Date.parse("2026-10-12T10:00:00+04:00") + i * 600_000).toISOString(),
    place: null,
    keep: true,
    analysis: { description: "a photo", scene: "group", mood: "joyful", quality: 7, coverWorthy: i === 0 },
    color,
  }));
}

function build(design: BookDesign, color: string | null, previousDoc?: unknown): BookDoc {
  const photos = photoSet(6, color);
  const { aliasToId } = aliasMaps(photos);
  const full = fullPageLayout(design);
  const plan: AlbumPlan = {
    title: "Our days",
    subtitle: "",
    coverPhotoId: "p1",
    moments: [{ id: "m1", title: "Part 1", dateLabel: "", place: null, pages: [2, 3, 4, 5, 6].map((n) => ({ layoutId: full, photoIds: [`p${n}`] })) }],
  };
  const r = planToDoc(plan, { aliasToId, photos, book: storyBook({ maxPages: 20 }), runId: RUN_ID, generatorVersion: 6, design, previousDoc });
  if (!("doc" in r)) throw new Error(r.issues.join("; "));
  expect(validateBookDoc(r.doc, { photoIds: new Set(photos.map((p) => p.id)), maxPages: 20 })).toEqual([]);
  const back = parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(r.doc))));
  expect(back.ok && back.doc).toEqual(r.doc);
  return r.doc;
}

describe("planToDoc stamps the accent colourway (magazine / editorial only)", () => {
  for (const format of BOOK_FORMATS) {
    it(`${format}: suggestion from the photo colours, source "ai"; no colours → the default`, () => {
      expect(build({ format, designStyle: "magazine" }, BLUE).style.colourway).toEqual({ id: "sky", source: "ai" });
      expect(build({ format, designStyle: "editorial" }, BLUE).style.colourway).toEqual({ id: "cobalt", source: "ai" });
      expect(build({ format, designStyle: "magazine" }, null).style.colourway).toEqual({ id: "lime", source: "ai" });
      expect(build({ format, designStyle: "editorial" }, null).style.colourway).toEqual({ id: "ink", source: "ai" });
    });

    it(`${format}: generator "ai", white pages, no background source`, () => {
      const doc = build({ format, designStyle: "magazine" }, BLUE);
      expect(doc.meta).toMatchObject({ generator: "ai", runId: RUN_ID, userEdited: false });
      expect(doc.style.background).toEqual({ kind: "color", hex: "#FFFFFF" });
      expect(doc.style.backgroundSource).toBeUndefined();
    });

    it(`${format}: the older styles get no colourway`, () => {
      for (const designStyle of ["classic", "modern", "geometric", "scrapbook"] as const) {
        expect(build({ format, designStyle }, BLUE, { style: { colourway: { id: "coral", source: "user" } } }).style.colourway).toBeUndefined();
      }
    });
  }

  it("rebuild: a user colourway of the doc being replaced is kept; an AI one is suggested again", () => {
    const design: BookDesign = { format: "A5_PORTRAIT", designStyle: "magazine" };
    expect(build(design, BLUE, { style: { colourway: { id: "coral", source: "user" } } }).style.colourway).toEqual({ id: "coral", source: "user" });
    expect(build(design, BLUE, { style: { colourway: { id: "coral", source: "ai" } } }).style.colourway).toEqual({ id: "sky", source: "ai" });
    expect(build(design, BLUE, {}).style.colourway).toEqual({ id: "sky", source: "ai" });
  });
});

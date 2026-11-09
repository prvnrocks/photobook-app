// relayoutDoc: a user caption is dropped when its re-fitted page lands on a layout without a
// caption area (D-031). relayoutDoc asks bestPageLayout to prefer captioned layouts for such
// pages, and every v1 photo count has one, so bestPageLayout is forced here to exercise the
// refit guard itself (e.g. a future catalogue where a count has only caption-less layouts).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/layouts/fit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/layouts/fit")>();
  return {
    ...actual,
    bestPageLayout: (orients: readonly string[]) =>
      orients.length === 1 ? "full-page" : actual.bestPageLayout(orients as Parameters<typeof actual.bestPageLayout>[0]),
  };
});

const { relayoutDoc } = await import("@/lib/book/relayout");
const { parseBookDoc, validateBookDoc } = await import("@/lib/book/schema");
import type { BookDoc } from "@/lib/book/types";

const ph = (id: string, takenAt: string, status: "kept" | "dropped" = "kept") => ({
  id,
  width: 3000,
  height: 4000,
  takenAt,
  status,
  place: null,
  dupGroup: null,
  blurScore: 50,
});

function doc(): BookDoc {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: "a1", title: "Trip", subtitle: "" },
    chapters: [{ id: "c1", title: "Beach mornings", dateLabel: "12 Oct 2026", place: null }],
    pages: [
      {
        id: "p1",
        chapterId: "c1",
        layout: "two-vertical",
        slots: [
          { photoId: "a1", crop: { x: 0.5, y: 0.5, zoom: 1 } },
          { photoId: "a2", crop: { x: 0.5, y: 0.5, zoom: 1 } },
        ],
        caption: { text: "My words", font: "Playfair", align: "center", source: "user" },
      },
    ],
    style: { background: "#FFFFFF", font: "Playfair" },
    meta: { generator: "ai", generatorVersion: 2, runId: null, userEdited: false },
  };
}

describe("relayoutDoc — user caption vs layout without a caption area", () => {
  it("re-fitted onto full-page → caption null, doc still valid, chapter title kept", () => {
    const photos = [ph("a1", "2026-10-12T10:00:00"), ph("a2", "2026-10-12T11:00:00", "dropped")];
    const r = relayoutDoc(doc(), photos, { isPaid: false, maxPages: 20, captionLang: "en" });
    expect(r.changed).toBe(true);
    expect(r.doc.pages[0].layout).toBe("full-page");
    expect(r.doc.pages[0].caption).toBeNull();
    expect(r.doc.chapters[0].title).toBe("Beach mornings");
    const parsed = parseBookDoc(r.doc);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateBookDoc(parsed.doc, { photoIds: new Set(["a1"]), maxPages: 20 })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { getLayout } from "@/lib/layouts";
import { captionsPreviewOf, captionsPreviewModel } from "@/lib/review/ui";

const has = (id: string, side?: "left" | "right") => {
  const l = getLayout(id);
  return !!l?.caption && (l.role !== "spread" || side === "left");
};

describe("captions preview with spreads (M10b)", () => {
  it("never counts a spread right half as captionable", () => {
    const doc = {
      chapters: [{ id: "c1", title: "T", dateLabel: "" }],
      pages: [
        { chapterId: "c1", layout: "m-p-spread-mosaic", side: "left", caption: { text: "Hi", source: "ai" } },
        { chapterId: "c1", layout: "m-p-spread-mosaic", side: "right", caption: null },
      ],
    };
    const prev = captionsPreviewOf(doc, has);
    expect(prev.pages.map((p) => p.captionable)).toEqual([true, false]);
    expect(captionsPreviewModel(prev)?.missing ?? 0).toBe(0);
  });
});

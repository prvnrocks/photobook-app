import { describe, expect, it } from "vitest";
import { getLayout } from "@/lib/layouts";
import { bestPageLayout } from "@/lib/layouts/fit";

describe("bestPageLayout", () => {
  it("1 photo: catalogue order on ties (full-page) unless preferCaption", () => {
    expect(bestPageLayout(["portrait"])).toBe("full-page");
    expect(bestPageLayout(["portrait"], { preferCaption: true })).toBe("one-portrait");
    expect(bestPageLayout(["landscape"], { preferCaption: true })).toBe("one-portrait");
  });

  it("preferCaption never changes the photo count and returns a layout with a caption area", () => {
    for (const orients of [["portrait", "portrait"], ["landscape", "landscape"], ["landscape", "portrait", "portrait"], ["square", "square", "square", "square"]] as const) {
      const id = bestPageLayout(orients, { preferCaption: true });
      expect(id).not.toBeNull();
      expect(getLayout(id!)?.photoCount).toBe(orients.length);
      expect(getLayout(id!)?.caption).not.toBeNull();
    }
  });

  it("no layout with that many slots → null either way", () => {
    expect(bestPageLayout([])).toBeNull();
    expect(bestPageLayout(Array(9).fill("portrait"), { preferCaption: true })).toBeNull();
  });
});

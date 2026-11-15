import { describe, expect, it } from "vitest";
import { VW_STAGE } from "@/components/viewer/viewer-classes";
import { fitBook, pageRatio } from "@/lib/viewer/fit";
import { POOL_CY, POOL_RX, POOL_RY, poolSide, stagePoolStyle, type StageMetrics } from "@/lib/viewer/stage-pool";

const PORTRAIT = pageRatio("A5_PORTRAIT");
const LANDSCAPE = pageRatio("A5_LANDSCAPE");

function stage(width: number, height: number, pad: number): StageMetrics {
  return { width, height, padTop: pad, padRight: pad, padBottom: pad, padLeft: pad };
}

/** Ellipse centre / radii in stage px from a pool style (layer 1). */
function ellipse(style: NonNullable<ReturnType<typeof stagePoolStyle>>) {
  const [w, h] = style.backgroundSize.split(",")[0].trim().split(" ").map(parseFloat);
  const [x, y] = style.backgroundPosition.split(",")[0].trim().split(" ").map(parseFloat);
  return { cx: x + w / 2, cy: y + h * POOL_CY, rx: w * POOL_RX, ry: h * POOL_RY };
}

describe("stage pool under the book", () => {
  it("stays coupled to VW_STAGE's first layer geometry", () => {
    expect(VW_STAGE).toContain("bg-[radial-gradient(ellipse_44%_7%_at_50%_93%,rgb(14_59_46");
    expect([POOL_RX, POOL_RY, POOL_CY]).toEqual([0.44, 0.07, 0.93]);
  });

  it("phone landscape: centre at the foot of the centred, width-limited book", () => {
    const s = stage(375, 524, 8);
    const style = stagePoolStyle(s, false, LANDSCAPE, "center")!;
    const box = fitBook({ width: 359, height: 508 }, false, LANDSCAPE)!;
    const bottom = 8 + (508 - box.height) / 2 + box.height;
    const e = ellipse(style);
    expect(e.cx).toBeCloseTo(8 + 359 / 2, 0);
    expect(e.cy).toBeLessThan(bottom);
    expect(e.cy).toBeGreaterThan(bottom - 10);
    expect(e.rx).toBeGreaterThan(box.width / 2);
    expect(style.backgroundRepeat).toBe("no-repeat, repeat");
    expect(style.backgroundSize.endsWith(", auto")).toBe(true);
  });

  it("phone portrait: height-limited book → pool at the stage foot", () => {
    const e = ellipse(stagePoolStyle(stage(375, 524, 8), false, PORTRAIT, "center")!);
    expect(e.cy).toBeGreaterThan(524 - 8 - 10);
    expect(e.cy).toBeLessThanOrEqual(524 - 8);
  });

  it("spread: cover alone → under the right page, end card alone → under the left page", () => {
    const s = stage(1280, 657, 16);
    const box = fitBook({ width: 1248, height: 625 }, true, PORTRAIT)!;
    const left = 16 + (1248 - box.width) / 2;
    const both = ellipse(stagePoolStyle(s, true, PORTRAIT, "center")!);
    const right = ellipse(stagePoolStyle(s, true, PORTRAIT, "right")!);
    const leftOnly = ellipse(stagePoolStyle(s, true, PORTRAIT, "left")!);
    expect(both.cx).toBeCloseTo(left + box.width / 2, 0);
    expect(right.cx).toBeCloseTo(left + box.pageWidth * 1.5, 0);
    expect(leftOnly.cx).toBeCloseTo(left + box.pageWidth / 2, 0);
    expect(right.rx).toBeLessThan(both.rx);
    expect(both.ry).toBeLessThanOrEqual(24.1);
  });

  it("poolSide: only a lone page of a spread picks a side", () => {
    expect(poolSide(false, [0])).toBe("center");
    expect(poolSide(true, [0])).toBe("right");
    expect(poolSide(true, [13])).toBe("left");
    expect(poolSide(true, [1, 2])).toBe("center");
  });

  it("no book (stage too small) → null, recipe default applies", () => {
    expect(stagePoolStyle(stage(40, 40, 8), false, PORTRAIT, "center")).toBeNull();
    expect(stagePoolStyle(stage(0, 0, 0), false, PORTRAIT, "center")).toBeNull();
  });
});

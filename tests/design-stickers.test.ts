// M10c T2: the sticker catalogue is print-safe pure path data (no filter/image/text/external refs),
// ids are unique, every occasion has an accent, tints resolve deterministically.
import { describe, expect, it } from "vitest";
import { OCCASIONS } from "@/lib/book/options";
import {
  ACCENT_STICKER_BY_OCCASION,
  accentStickerFor,
  DECORATION_STICKER_IDS,
  isStickerId,
  OCCASION_ACCENT,
  plateInk,
  resolvePaint,
  resolveStickerId,
  resolveStickerPaths,
  shadeHex,
  STICKER_IDS,
  STICKERS,
  stickerAspect,
  stickerSvg,
} from "@/lib/design/stickers";

const HEX = /^#[0-9A-F]{6}$/i;
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const FORBIDDEN = /<(filter|image|text|foreignObject|use|script|style|a|linearGradient|radialGradient|pattern|mask|clipPath)\b|url\(|href|xlink|https?:|data:/i;

describe("sticker catalogue (M10c T2)", () => {
  it("has unique ids, and STICKER_IDS matches STICKERS", () => {
    expect(new Set(STICKER_IDS).size).toBe(STICKER_IDS.length);
    expect(Object.keys(STICKERS).sort()).toEqual([...STICKER_IDS].sort());
    for (const id of STICKER_IDS) expect(STICKERS[id].id).toBe(id);
    expect(DECORATION_STICKER_IDS).toContain(OCCASION_ACCENT);
    expect(isStickerId(OCCASION_ACCENT)).toBe(false);
  });

  it("contains the D-068 set", () => {
    const by = (g: string) => STICKER_IDS.filter((id) => STICKERS[id].group === g);
    const neutral = by("neutral");
    expect(neutral.filter((id) => STICKERS[id].kind === "tape")).toHaveLength(3);
    expect(neutral.filter((id) => STICKERS[id].kind === "plate")).toHaveLength(2);
    expect(neutral.filter((id) => id.startsWith("heart"))).toHaveLength(2);
    for (const id of ["star", "sparkle", "leaf-sprig", "flower", "paperclip", "photo-corner"]) expect(neutral).toContain(id);
    expect(by("seasonal").sort()).toEqual(["crescent-star", "lantern"]);
    expect(by("accent")).toHaveLength(OCCASIONS.length);
  });

  it("maps every occasion to its own accent sticker", () => {
    for (const o of OCCASIONS) {
      const id = ACCENT_STICKER_BY_OCCASION[o];
      expect(STICKERS[id].group).toBe("accent");
      expect(STICKERS[id].occasion).toBe(o);
      expect(accentStickerFor(o)).toBe(id);
    }
    expect(accentStickerFor(null)).toBe(ACCENT_STICKER_BY_OCCASION.other);
    expect(accentStickerFor("nope")).toBe(ACCENT_STICKER_BY_OCCASION.other);
    expect(resolveStickerId(OCCASION_ACCENT, "travel")).toBe("accent-plane");
    expect(resolveStickerId("star", "travel")).toBe("star");
    expect(resolveStickerId("nope", "travel")).toBeUndefined();
  });

  it("is pure path data: valid d strings, hex paints, sane numbers", () => {
    for (const id of STICKER_IDS) {
      const def = STICKERS[id];
      const [x, y, w, h] = def.viewBox;
      expect([x, y]).toEqual([0, 0]);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(stickerAspect(id)).toBeCloseTo(w / h);
      expect(def.defaultTint).toMatch(HEX);
      expect(def.suggestedTints[0]).toBe(def.defaultTint);
      for (const t of def.suggestedTints) expect(t).toMatch(HEX);
      expect(def.paths.length).toBeGreaterThan(0);
      for (const p of def.paths) {
        expect(p.d, id).toMatch(PATH_D);
        expect(p.d).not.toMatch(/NaN|Infinity/);
        for (const paint of [p.fill, p.stroke]) {
          if (paint === undefined || paint === "none") continue;
          if (typeof paint === "string") expect(paint, id).toMatch(HEX);
          else expect(Math.abs(paint.tint)).toBeLessThanOrEqual(1);
        }
        if (p.alpha !== undefined) expect(p.alpha).toBeGreaterThan(0);
        expect(p.fill !== "none" || p.stroke !== undefined, `${id}: invisible path`).toBe(true);
      }
      if (def.kind === "plate") {
        expect(def.textBox).toBeDefined();
        const b = def.textBox!;
        expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= 100 && b.y + b.h <= 100).toBe(true);
      }
    }
  });

  it("renders SVG without filter, image, text or external references", () => {
    for (const id of STICKER_IDS) {
      for (const tint of [undefined, ...STICKERS[id].suggestedTints]) {
        const svg = stickerSvg(id, { tint, width: 100 });
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ')).toBe(true);
        expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), id).not.toMatch(FORBIDDEN);
        const tags = svg.match(/<(\w+)/g) ?? [];
        expect(new Set(tags)).toEqual(new Set(["<svg", "<path"]));
      }
    }
  });

  it("the guard itself catches the forbidden constructs", () => {
    for (const bad of ['<filter id="f"/>', '<image href="x.png"/>', "<text>hi</text>", 'fill="url(#g)"', '<use href="#a"/>', "https://x.y/z.svg"]) {
      expect(bad).toMatch(FORBIDDEN);
    }
  });

  it("tapes are translucent (rgba fill)", () => {
    for (const id of STICKER_IDS.filter((i) => STICKERS[i].kind === "tape")) {
      const body = resolveStickerPaths(id)[0];
      expect(body.fill, id).toMatch(/^rgba\(/);
    }
  });

  it("resolves tints deterministically; invalid / non-tintable tints use the default", () => {
    expect(shadeHex("#808080", 0)).toBe("#808080");
    expect(shadeHex("#808080", 1)).toBe("#FFFFFF");
    expect(shadeHex("#808080", -1)).toBe("#000000");
    expect(resolvePaint({ tint: 0 }, "#112233", 0.5)).toBe("rgba(17, 34, 51, 0.5)");
    expect(resolvePaint("#abcdef", "#000000")).toBe("#ABCDEF");
    expect(stickerSvg("star", { tint: "red" })).toBe(stickerSvg("star"));
    expect(stickerSvg("star", { tint: "#123456" })).not.toBe(stickerSvg("star"));
    expect(stickerSvg("heart-kraft", { tint: "#123456" })).toBe(stickerSvg("heart-kraft", { tint: "#123456" }));
  });

  it("plate ink contrasts with the plate tint", () => {
    expect(plateInk("plate-label")).toBe("light");
    expect(plateInk("plate-tag")).toBe("dark");
    expect(plateInk("plate-label", "#F7F3EA")).toBe("dark");
  });
});

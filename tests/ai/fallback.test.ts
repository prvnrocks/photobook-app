import { describe, expect, it } from "vitest";
import {
  EXTREME_BLUR_MAX,
  ensureAtLeastOneKept,
  looksLikeScreenshot,
  ruleAlbum,
  ruleCurate,
} from "@/lib/ai/fallback";
import type { AutoPhoto } from "@/lib/autolayout";
import { photo, screenshot } from "../helpers/curation";

describe("ruleCurate", () => {
  it("drops an obvious screenshot (png + no camera + phone aspect) as 'screenshot'", () => {
    const r = ruleCurate([photo("a"), screenshot("s")]);
    expect(r.get("s")).toEqual({ keep: false, dropReason: "screenshot", source: "rule" });
    expect(r.get("a")).toEqual({ keep: true, dropReason: null, source: "rule" });
  });

  it("landscape screenshots count too; png with camera, jpeg, or a normal aspect do not", () => {
    expect(looksLikeScreenshot(screenshot("w", { width: 2556, height: 1179 }))).toBe(true);
    expect(looksLikeScreenshot(screenshot("c", { camera: "Apple iPhone 15" }))).toBe(false);
    expect(looksLikeScreenshot(screenshot("j", { originalMime: "image/jpeg" }))).toBe(false);
    expect(looksLikeScreenshot(screenshot("n", { width: 3024, height: 4032 }))).toBe(false);
    expect(looksLikeScreenshot(screenshot("u", { width: null }))).toBe(false);
  });

  it("drops only extremely blurry photos; null blur is never dropped", () => {
    const r = ruleCurate([
      photo("x", { blurScore: EXTREME_BLUR_MAX - 1 }),
      photo("y", { blurScore: EXTREME_BLUR_MAX + 5 }),
      photo("z", { blurScore: null }),
    ]);
    expect(r.get("x")).toMatchObject({ keep: false, dropReason: "blurry" });
    expect(r.get("y")!.keep).toBe(true);
    expect(r.get("z")!.keep).toBe(true);
  });

  it("dup group of 3 keeps exactly the best (blur → area → id) and drops the rest as duplicate", () => {
    const r = ruleCurate([
      photo("g1", { dupGroup: 3, blurScore: 200 }),
      photo("g2", { dupGroup: 3, blurScore: 900 }),
      photo("g3", { dupGroup: 3, blurScore: 500 }),
      photo("solo"),
    ]);
    expect(r.get("g2")).toMatchObject({ keep: true, dropReason: null });
    expect(r.get("g1")).toMatchObject({ keep: false, dropReason: "duplicate" });
    expect(r.get("g3")).toMatchObject({ keep: false, dropReason: "duplicate" });
    expect(r.get("solo")!.keep).toBe(true);

    const tie = ruleCurate([
      photo("b", { dupGroup: 1, width: 100, height: 100 }),
      photo("a", { dupGroup: 1, width: 100, height: 100 }),
      photo("big", { dupGroup: 1, width: 200, height: 200 }),
    ]);
    expect([...tie].filter(([, d]) => d.keep).map(([id]) => id)).toEqual(["big"]);
  });

  it("a fully blurry dup group still keeps its best member", () => {
    const r = ruleCurate([photo("a", { dupGroup: 1, blurScore: 2 }), photo("b", { dupGroup: 1, blurScore: 5 }), photo("c")]);
    expect(r.get("b")!.keep).toBe(true);
    expect(r.get("a")).toMatchObject({ keep: false, dropReason: "blurry" });
  });

  it("never changes user_override photos", () => {
    const r = ruleCurate([
      screenshot("kept-shot", { userOverride: true, status: "kept" }),
      photo("dropped-sharp", { userOverride: true, status: "dropped", dropReason: "irrelevant" }),
      photo("g1", { dupGroup: 2, blurScore: 100, userOverride: true, status: "kept" }),
      photo("g2", { dupGroup: 2, blurScore: 900 }),
    ]);
    expect(r.get("kept-shot")).toEqual({ keep: true, dropReason: null, source: "rule" });
    expect(r.get("dropped-sharp")).toEqual({ keep: false, dropReason: "irrelevant", source: "rule" });
    expect(r.get("g1")!.keep).toBe(true);
    expect(r.get("g2")!.keep).toBe(true);
  });

  it("never leaves 0 kept photos (prefers non-screenshots)", () => {
    const r = ruleCurate([screenshot("s1"), photo("blurry", { blurScore: 1 }), screenshot("s2")]);
    expect([...r].filter(([, d]) => d.keep).map(([id]) => id)).toEqual(["blurry"]);
    const only = ruleCurate([screenshot("s1")]);
    expect(only.get("s1")!.keep).toBe(true);
    expect(ruleCurate([]).size).toBe(0);
  });

  it("ensureOneKept:false leaves batches as they are; ensureAtLeastOneKept fixes the book", () => {
    const ps = [screenshot("s1"), screenshot("s2")];
    const batch = ruleCurate(ps, { ensureOneKept: false });
    expect([...batch.values()].some((d) => d.keep)).toBe(false);
    const fixed = ensureAtLeastOneKept(ps, batch);
    expect([...fixed.values()].filter((d) => d.keep)).toHaveLength(1);
    expect([...batch.values()].some((d) => d.keep)).toBe(false); // not mutated
  });

  it("all user-dropped overrides stay dropped (user's choice)", () => {
    const r = ruleCurate([photo("a", { userOverride: true, status: "dropped", dropReason: "irrelevant" })]);
    expect(r.get("a")!.keep).toBe(false);
  });
});

describe("ruleAlbum", () => {
  it("wraps autolayout and stamps the run id", () => {
    const photos: AutoPhoto[] = [1, 2, 3].map((i) => ({
      id: `ph${i}`,
      width: 3000,
      height: 4000,
      takenAt: `2026-10-12T1${i}:00:00+04:00`,
      dateSource: "exif",
      place: null,
      status: "kept",
      dupGroup: null,
      blurScore: 100,
    }));
    const doc = ruleAlbum(photos, { occasion: "wedding", title: null, captionLang: "en", isPaid: false }, "0b6f3c2e-8d1a-4c5e-9f7a-2b3c4d5e6f70");
    expect(doc.meta).toMatchObject({ generator: "rule", runId: "0b6f3c2e-8d1a-4c5e-9f7a-2b3c4d5e6f70", userEdited: false });
    expect(doc.pages.length).toBeGreaterThan(0);
  });
});

// Storybook photo filters + scenes (quality v2, filter.ts, moments v2). Synthetic images made with
// sharp (no user photos): a Gaussian-blurred copy of a textured photo must be set aside as blurry,
// sharp ones never. Similar shots, user overrides, scene splits and scene-level labels.
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { decidePhotoFilters, filterCounts, groupSimilarShots, type FilterPhoto } from "@/lib/photos/filter";
import type { DuplicateGroup } from "@/lib/photos/duplicates";
import { clusterMoments, labelMoment, MOMENT_DEFAULTS, sceneRanges, type MomentPhoto, type MomentVision } from "@/lib/photos/moments";
import { BOOK_BLUR, QUALITY_VERSION, bookBlurryIds, lumaOf, scoreImage, sharpnessFromVariance, upgradeStoredScores } from "@/lib/photos/quality";
import { stageDetail } from "@/lib/storybook/run/progress";

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-11-19T10:00:00Z");
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** Deterministic textured scene (blocks + edges + fine noise), seeded. */
function texture(seed: number, w = 384, h = 288): Buffer {
  let s = seed * 2654435761 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const px = Buffer.alloc(w * h * 3);
  const blocks = Array.from({ length: 40 }, () => ({ x: rnd() * w, y: rnd() * h, r: 8 + rnd() * 40, c: [rnd() * 255, rnd() * 255, rnd() * 255] }));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = [110 + 40 * Math.sin(x / 9 + seed), 120, 130 + 30 * Math.cos(y / 7)];
      for (const b of blocks) if (Math.abs(x - b.x) < b.r && Math.abs(y - b.y) < b.r * 0.7) c = b.c;
      const n = (rnd() - 0.5) * 50;
      const i = (y * w + x) * 3;
      px[i] = Math.max(0, Math.min(255, c[0]! + n));
      px[i + 1] = Math.max(0, Math.min(255, c[1]! + n));
      px[i + 2] = Math.max(0, Math.min(255, c[2]! + n));
    }
  return px;
}

async function measure(seed: number, blurSigma = 0): Promise<{ variance: number; flat: boolean; sharpness: number }> {
  let img = sharp(texture(seed), { raw: { width: 384, height: 288, channels: 3 } });
  if (blurSigma > 0) img = img.blur(blurSigma);
  const jpeg = await img.jpeg({ quality: 85 }).toBuffer();
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const q = scoreImage(lumaOf(data, info.width, info.height, 3), info.width, info.height);
  return { variance: q.raw.laplacianVariance, flat: q.flags.includes("flat"), sharpness: q.sharpness };
}

describe("blur: book-relative, non-saturating (quality v2)", () => {
  let sharpOnes: { variance: number; flat: boolean; sharpness: number }[] = [];
  let blurred: { variance: number; flat: boolean; sharpness: number };
  beforeAll(async () => {
    sharpOnes = await Promise.all(Array.from({ length: 9 }, (_, i) => measure(i + 1)));
    blurred = await measure(3, 4); // a Gaussian-blurred copy of sharp photo 3
  });

  it("a Gaussian-blurred copy is set aside as blurry; the sharp photos never are", () => {
    const items = [...sharpOnes.map((m, i) => ({ id: `s${i}`, ...m })), { id: "blurred", ...blurred }];
    expect([...bookBlurryIds(items)]).toEqual(["blurred"]);
  });

  it("sharpness no longer saturates: different sharp photos get different scores below 100, the blurred copy far lower", () => {
    const scores = sharpOnes.map((m) => m.sharpness);
    expect(Math.max(...scores)).toBeLessThan(100);
    expect(new Set(scores).size).toBeGreaterThan(1);
    expect(blurred.sharpness).toBeLessThan(Math.min(...scores) - 15);
    expect(sharpnessFromVariance(1000)).toBeLessThan(sharpnessFromVariance(5000));
    expect(sharpnessFromVariance(5000)).toBeLessThan(100);
  });

  it("relative rule: needs a distribution, a 10x drop AND the absolute ceiling; flat photos are never flagged by it", () => {
    const book = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, variance: 1000 + i * 60, flat: false }));
    expect(bookBlurryIds([...book, { id: "soft", variance: 300, flat: false }]).has("soft")).toBe(false); // 3x lower: not blurry
    expect(bookBlurryIds([...book, { id: "x", variance: 60, flat: false }]).has("x")).toBe(true);
    expect(bookBlurryIds([...book, { id: "sky", variance: 60, flat: true }]).has("sky")).toBe(false);
    // a book of calm photos: a 10x outlier above the ceiling is not flagged
    const detailed = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, variance: 20000 + i, flat: false }));
    expect(bookBlurryIds([...detailed, { id: "calm", variance: BOOK_BLUR.ceilingVariance + 50, flat: false }]).has("calm")).toBe(false);
    // too few photos: only the absolute floor
    expect([...bookBlurryIds([{ id: "a", variance: 2000, flat: false }, { id: "b", variance: 50, flat: false }, { id: "c", variance: 5, flat: false }])]).toEqual(["c"]);
    // the vision note halves the relative drop
    expect(bookBlurryIds([...book, { id: "v", variance: 220, flat: false, visionBlurry: true }]).has("v")).toBe(true);
  });

  it("a v1 score is upgraded from its raw numbers (no image needed)", () => {
    const v1 = { version: 1, exposure: 80, composition: 60, flags: ["blurry" as const], raw: { laplacianVariance: 1500, meanLuma: 120, clipLow: 0, clipHigh: 0, tonalRange: 200, edgeShare: 0.2, weightX: 0.5, weightY: 0.5 } };
    const up = upgradeStoredScores(v1)!;
    expect(up.version).toBe(QUALITY_VERSION);
    expect(up.sharpness).toBe(sharpnessFromVariance(1500));
    expect(up.flags).toEqual([]);
    expect(up.overall).toBeCloseTo(0.5 * up.sharpness + 0.3 * 80 + 0.2 * 60, 0);
    expect(upgradeStoredScores({ ...v1, raw: {} as never })).toBeNull();
    expect(upgradeStoredScores({ ...v1, version: QUALITY_VERSION })).toBeNull();
  });
});

// ---------------------------------------------------------------------------- similar shots + decisions

const PORTRAIT: MomentVision = { scene: "portrait", objects: ["cup", "table", "chair"], activities: ["holding a cup"] };
const STREET: MomentVision = { scene: "landscape", objects: ["street", "car", "building"], activities: ["walking"] };

function fp(n: number, sec: number, over: Partial<FilterPhoto> = {}): FilterPhoto {
  return {
    id: pid(n),
    fingerprint: `f${n}`,
    imageSha256: null,
    phash: "ffff0000ffff0000",
    takenAt: iso(sec),
    dateSource: "exif",
    width: 4000,
    height: 3000,
    quality: 60,
    blurScore: null,
    status: "kept",
    userOverride: false,
    color: "#806040",
    vision: PORTRAIT,
    variance: 1500,
    flat: false,
    ...over,
  };
}

describe("similar shots", () => {
  it("a burst of the same pose is one run; the best ranked photo is kept, one per started 4", () => {
    const photos = [fp(1, 0, { quality: 50 }), fp(2, 3, { quality: 70 }), fp(3, 6, { quality: 55 }), fp(4, 9), fp(5, 12), fp(6, 15)];
    const g = groupSimilarShots(photos);
    expect(g).toHaveLength(1);
    expect(g[0]!.photoIds).toHaveLength(6);
    expect(g[0]!.keep).toEqual([pid(2), pid(4)]); // 6 photos keep 2: best quality, then quality ties by size → id
  });

  it("a long gap, a scene change or a different look starts a new run; a long session cannot chain into one group", () => {
    const photos = [
      fp(1, 0),
      fp(2, 5),
      fp(3, 50), // 45 s gap
      fp(4, 52),
      fp(5, 54, { vision: STREET, phash: "0000ffff0000ffff", color: "#203040" }), // new scene
      fp(6, 56, { vision: STREET, phash: "0000ffff0000ffff", color: "#203040" }),
    ];
    expect(groupSimilarShots(photos).map((g) => g.photoIds)).toEqual([[pid(1), pid(2)], [pid(3), pid(4)], [pid(5), pid(6)]]);
    // 10 photos 20 s apart: one anchored run may span at most 60 s
    const session = Array.from({ length: 10 }, (_, i) => fp(10 + i, i * 20));
    const runs = groupSimilarShots(session);
    for (const r of runs) expect(r.photoIds.length).toBeLessThanOrEqual(4);
    expect(runs.length).toBeGreaterThanOrEqual(3);
  });

  it("file-dated / undated photos are not judged as bursts (no capture time)", () => {
    expect(groupSimilarShots([fp(1, 0, { dateSource: "file" }), fp(2, 1, { dateSource: "file" })])).toEqual([]);
  });
});

describe("decidePhotoFilters", () => {
  const dup = (ids: number[], preferred: number, source: "auto" | "user" = "auto"): DuplicateGroup => ({ key: pid(Math.min(...ids)), kind: "near", photoIds: ids.map(pid), preferredPhotoId: pid(preferred), preferredSource: source });

  it("duplicates keep the preferred one; similar shots keep the best; clearly blurry photos go — each with its own reason", () => {
    const blurryPhotos = Array.from({ length: 8 }, (_, i) => fp(20 + i, 600 + i * 120, { vision: STREET, phash: `${i}`.repeat(16).slice(0, 16), color: `#${(i * 30).toString(16).padStart(2, "0")}2020` }));
    const photos = [fp(1, 0), fp(2, 2), fp(3, 4, { quality: 90 }), fp(4, 6), ...blurryPhotos, fp(30, 2000, { vision: STREET, variance: 40, phash: "abcdabcdabcdabcd", color: "#000000" })];
    const out = decidePhotoFilters(photos, [dup([1, 2], 1)]);
    const reasons = Object.fromEntries(out.map((d) => [d.photoId, d.reason]));
    expect(reasons[pid(2)]).toBe("duplicate");
    expect(reasons[pid(30)]).toBe("blurry");
    // the remaining burst (1, 3, 4) keeps photo 3 (best quality)
    expect(reasons[pid(3)]).toBeUndefined();
    expect([reasons[pid(1)], reasons[pid(4)]]).toEqual(["similar", "similar"]);
    expect(filterCounts(photos.map((p) => ({ status: reasons[p.id] ? "dropped" : "kept", drop_reason: reasons[p.id] ?? null, user_override: false })))).toEqual({ duplicate: 1, similar: 2, blurry: 1 });
  });

  it("the user always wins: overridden photos are never set aside, a user-preferred copy is kept, dropped photos are not re-decided", () => {
    const photos = [fp(1, 0, { userOverride: true, quality: 10 }), fp(2, 2, { quality: 90 }), fp(3, 4, { status: "dropped" }), fp(4, 6, { quality: 20 }), fp(5, 8, { quality: 20 })];
    const out = decidePhotoFilters(photos, [dup([4, 5], 5, "user")], { minKept: 1 });
    const ids = out.map((d) => d.photoId);
    expect(ids).not.toContain(pid(1));
    expect(ids).not.toContain(pid(3));
    expect(ids).not.toContain(pid(5));
    expect(ids).toContain(pid(4)); // duplicate of the user's pick
  });

  it("never empties a book: at least minKept photos stay", () => {
    const photos = Array.from({ length: 6 }, (_, i) => fp(i + 1, i * 2));
    const out = decidePhotoFilters(photos, []);
    expect(photos.length - out.length).toBeGreaterThanOrEqual(4);
  });

  it("a duplicate group whose preferred photo is gone keeps its best remaining member", () => {
    const photos = [fp(1, 0, { status: "dropped" }), fp(2, 100, { quality: 40, phash: "1111111111111111" }), fp(3, 200, { quality: 80, phash: "2222222222222222", color: "#ffffff" })];
    expect(decidePhotoFilters(photos, [dup([1, 2, 3], 1)], { minKept: 1 }).map((d) => d.photoId)).toEqual([pid(2)]);
  });
});

// ---------------------------------------------------------------------------- scenes + labels

function mp(n: number, sec: number, vision: MomentVision | null = PORTRAIT): MomentPhoto {
  return { id: pid(n), takenAt: iso(sec), dateSource: "exif", lat: 25.2, lng: 55.27, place: null, vision, quality: 60, qualityFlags: [], keep: true };
}

describe("scenes inside one long visit", () => {
  /** 60 photos over ~13 minutes: bursts a few seconds apart, six longer pauses (60–110 s). */
  function cafeVisit(): MomentPhoto[] {
    const pauses = new Map([[3, 99], [16, 82], [19, 62], [38, 108], [40, 75], [48, 83]]);
    const out: MomentPhoto[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += i === 0 ? 0 : (pauses.get(i) ?? 1 + (i % 3));
      const v = i % 15 === 0 ? { ...PORTRAIT, description: "two cups on a café table" } : PORTRAIT;
      out.push(mp(i + 1, t, v));
    }
    return out;
  }

  it("is split at the pauses that are long for this set; tiny segments join a neighbour", () => {
    const photos = cafeVisit();
    const ranges = sceneRanges(photos, MOMENT_DEFAULTS);
    expect(ranges.length).toBeGreaterThanOrEqual(3);
    expect(ranges.length).toBeLessThanOrEqual(Math.floor(60 / MOMENT_DEFAULTS.scenePhotosPer));
    for (const [a, b] of ranges) expect(b - a).toBeGreaterThanOrEqual(MOMENT_DEFAULTS.sceneMinSize);
    const { moments } = clusterMoments(photos);
    expect(moments.length).toBe(ranges.length);
    expect(moments.flatMap((m) => m.photoIds)).toEqual(photos.map((p) => p.id)); // every photo once, in order
  });

  it("labels describe the scene: a setting a few photos of the visit show labels every scene; never 'Holding a cup'", () => {
    const { moments } = clusterMoments(cafeVisit());
    for (const m of moments) {
      expect(m.label).not.toMatch(/holding|cup/i);
      expect(m.label).toBe("At the café");
    }
  });

  it("small books stay one moment; without a setting the label is the date, never a single object", () => {
    const small = Array.from({ length: 8 }, (_, i) => mp(i + 1, i * 30));
    const { moments } = clusterMoments(small);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.label).toBe("Portraits"); // the scene category — not "Holding a cup"
    const objectsOnly: MomentVision = { scene: "other", objects: ["cup"], activities: ["holding a cup"] };
    expect(labelMoment(small.map((p) => ({ ...p, vision: objectsOnly }))).label).toBe("19 Nov 2026");
  });
});

describe("step 6 shows the real filter counts", () => {
  it("'60 photos · 14 similar set aside · 2 blurry' only from the counts the run stored", () => {
    expect(stageDetail("discovering", { status: "done", done: 60, total: 60, similar: 14, blurry: 2 })).toBe("60 photos · 14 similar set aside · 2 blurry");
    expect(stageDetail("discovering", { status: "done", done: 60, total: 60, similar: 0, blurry: 0 })).toBe("60 photos");
    expect(stageDetail("discovering", { status: "done", done: 60, total: 60 })).toBe("60 photos");
    expect(stageDetail("discovering", { status: "skipped", similar: 3 })).toBe("Sorted without AI · 3 similar set aside");
  });
});

import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null) }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/photo-analyses", () => ({ loadOwnPhoto: vi.fn(async () => null) }));
vi.mock("@/lib/db/photos", () => ({ loadThumbBase64: vi.fn(async () => new Map()) }));
vi.mock("@/lib/db/photo-organize", () => ({
  listDuplicateGroups: vi.fn(),
  listImageHashes: vi.fn(),
  listMoments: vi.fn(),
  listPhotosForOrganize: vi.fn(),
  listQuality: vi.fn(),
  listVision: vi.fn(),
  replaceDuplicateGroups: vi.fn(),
  replaceMoments: vi.fn(),
  saveQuality: vi.fn(),
  setDuplicatePreference: vi.fn(),
}));

import type { OwnPhoto } from "@/lib/db/photo-analyses";
import type { OrganizePhotoRow, StoredMoment, StoredQuality } from "@/lib/db/photo-organize";
import { detectDuplicates, type DupPhoto, type DuplicateGroup } from "@/lib/photos/duplicates";
import { MOMENT_DEFAULTS, breakScore, clusterMoments, contentTokens, dateRangeLabel, jaccard, labelMoment, rankCandidates, type MomentPhoto, type MomentVision } from "@/lib/photos/moments";
import { OrganizeError, analyzePhotoQuality, clusterPhotosIntoMoments, detectDuplicateGroups, scoreAiCopy, type OrganizeDeps } from "@/lib/photos/organize";
import { OrganizeResultSchema } from "@/lib/photos/organize-schemas";
import { QUALITY_VERSION, lumaOf, scoreImage, sharpnessFromVariance, type QualityScores } from "@/lib/photos/quality";
import { PHOTO_PROMPT_VERSION } from "@/lib/ai/photo-intelligence/prompt";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (iso: string) => new Date(iso).toISOString();

// ---------------------------------------------------------------------------- image fixtures

const W = 256;
const H = 192;
/** A scene with detail: gradient sky, textured ground, a dark box at (cx, cy). */
function scene(cx = 0.5, cy = 0.5, gain = 1, offset = 0): Float32Array {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 90 + (y / H) * 60;
      const bx = Math.abs(x / W - cx) < 0.12;
      const by = Math.abs(y / H - cy) < 0.16;
      if (bx && by) v = ((x >> 2) + (y >> 2)) % 2 === 0 ? 30 : 220;
      g[y * W + x] = Math.min(255, Math.max(0, v * gain + offset));
    }
  }
  return g;
}
const flat = (v: number) => new Float32Array(W * H).fill(v);
async function jpegOf(gray: Float32Array, blur = 0): Promise<string> {
  let img = sharp(Buffer.from(Uint8Array.from(gray, (v) => Math.round(v))), { raw: { width: W, height: H, channels: 1 } });
  if (blur > 0) img = img.blur(blur);
  return (await img.jpeg({ quality: 85 }).toBuffer()).toString("base64");
}

let sharpB64: string;
let blurB64: string;
beforeAll(async () => {
  sharpB64 = await jpegOf(scene());
  blurB64 = await jpegOf(scene(), 8);
});

// ---------------------------------------------------------------------------- quality

describe("quality scoring", () => {
  it("scores are 0–100, deterministic, versioned, and carry the raw measurements", () => {
    const a = scoreImage(scene(), W, H);
    expect(scoreImage(scene(), W, H)).toEqual(a);
    expect(a.version).toBe(QUALITY_VERSION);
    for (const v of [a.sharpness, a.exposure, a.composition, a.overall]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(Object.keys(a.raw).sort()).toEqual(["clipHigh", "clipLow", "edgeShare", "laplacianVariance", "meanLuma", "tonalRange", "weightX", "weightY"]);
    expect(a.overall).toBeCloseTo(0.5 * a.sharpness + 0.3 * a.exposure + 0.2 * a.composition, 0);
  });

  it("sharpness: a blurred copy of the same picture scores lower and is flagged", async () => {
    const crisp = await scoreAiCopy(sharpB64);
    const soft = await scoreAiCopy(blurB64);
    expect(crisp.sharpness).toBeGreaterThan(soft.sharpness + 15);
    expect(crisp.flags).not.toContain("blurry");
    expect(soft.flags.some((f) => f === "blurry" || f === "soft")).toBe(true);
    expect(crisp.overall).toBeGreaterThan(soft.overall);
  });

  it("sharpnessFromVariance is monotonic and bounded", () => {
    const vs = [0, 1, 10, 40, 100, 1000, 1e6].map(sharpnessFromVariance);
    expect(vs[0]).toBe(0);
    for (let i = 1; i < vs.length; i++) expect(vs[i]!).toBeGreaterThanOrEqual(vs[i - 1]!);
    expect(vs.at(-1)).toBe(100);
    expect(sharpnessFromVariance(Number.NaN)).toBe(0);
    expect(sharpnessFromVariance(-5)).toBe(0);
  });

  it("exposure: dark, blown-out and washed-out pictures are flagged and score below a well-exposed one", () => {
    const good = scoreImage(scene(), W, H);
    const dark = scoreImage(scene(0.5, 0.5, 0.25), W, H);
    const bright = scoreImage(scene(0.5, 0.5, 1, 170), W, H);
    const grey = scoreImage(flat(128), W, H);
    expect(dark.flags).toContain("underexposed");
    expect(bright.flags).toContain("overexposed");
    expect(grey.flags).toEqual(expect.arrayContaining(["low_contrast", "flat", "blurry"]));
    expect(good.flags).not.toEqual(expect.arrayContaining(["underexposed"]));
    for (const bad of [dark, bright, grey]) expect(good.exposure).toBeGreaterThan(bad.exposure);
    expect(scoreImage(flat(0), W, H).flags).toContain("underexposed");
    expect(scoreImage(flat(255), W, H).flags).toContain("overexposed");
  });

  it("composition (heuristic): a subject at the centre or on a third beats one pushed into a corner", () => {
    const centre = scoreImage(scene(0.5, 0.5), W, H);
    const third = scoreImage(scene(1 / 3, 1 / 3), W, H);
    const corner = scoreImage(scene(0.06, 0.08), W, H);
    expect(centre.composition).toBeGreaterThan(corner.composition + 10);
    expect(third.composition).toBeGreaterThan(corner.composition + 10);
    expect(corner.raw.edgeShare).toBeGreaterThan(centre.raw.edgeShare);
    expect(scoreImage(flat(128), W, H).composition).toBe(50); // nothing to judge → neutral
  });

  it("refuses images too small to measure and handles RGB / RGBA input", () => {
    expect(() => scoreImage(new Float32Array(16), 4, 4)).toThrow(RangeError);
    expect(() => scoreImage(new Float32Array(10), 64, 64)).toThrow(RangeError);
    const rgb = new Uint8Array(4 * 4 * 3).fill(100);
    expect([...lumaOf(rgb, 4, 4, 3)].every((v) => Math.abs(v - 100) < 0.01)).toBe(true);
    expect(lumaOf(new Uint8Array(4 * 4 * 4).fill(50), 4, 4, 4)).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------- duplicates

const dup = (n: number, o: Partial<DupPhoto> = {}): DupPhoto => ({
  id: pid(n),
  fingerprint: `s1:${String(n).padStart(64, "0")}`,
  imageSha256: null,
  phash: null,
  takenAt: null,
  dateSource: null,
  width: 4000,
  height: 3000,
  quality: null,
  blurScore: null,
  ...o,
});
const T0 = "2026-10-12T10:00:00Z";
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

describe("duplicate detection", () => {
  it("exact duplicates: the same file fingerprint, or the same analysis-copy hash", () => {
    const groups = detectDuplicates([
      dup(1, { fingerprint: "s1:same" }),
      dup(2, { fingerprint: "s1:same" }),
      dup(3, { imageSha256: "a".repeat(64) }),
      dup(4, { imageSha256: "a".repeat(64) }),
      dup(5),
    ]);
    expect(groups).toEqual([
      { key: pid(1), kind: "exact", photoIds: [pid(1), pid(2)], preferredPhotoId: pid(1), preferredSource: "auto" },
      { key: pid(3), kind: "exact", photoIds: [pid(3), pid(4)], preferredPhotoId: pid(3), preferredSource: "auto" },
    ]);
  });

  it("near duplicates: perceptual hashes within the Hamming threshold AND the time window", () => {
    const burst = [
      dup(1, { phash: "ffff0000ffff0000", takenAt: T0, dateSource: "exif" }),
      dup(2, { phash: "ffff0000ffff0001", takenAt: plus(T0, 0.2), dateSource: "exif" }), // 1 bit, 12 s later
      dup(3, { phash: "ffff0000ffff0003", takenAt: plus(T0, 10), dateSource: "exif" }), // similar, but 10 min later
      dup(4, { phash: "0123456789abcdef", takenAt: plus(T0, 0.3), dateSource: "exif" }), // different picture
    ];
    const groups = detectDuplicates(burst);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "near", photoIds: [pid(1), pid(2)] });
  });

  it("the similarity thresholds are configurable", () => {
    const pair = [
      dup(1, { phash: "ffff0000ffff0000", takenAt: T0, dateSource: "exif" }),
      dup(2, { phash: "ffff0000ffff00ff", takenAt: plus(T0, 1), dateSource: "exif" }), // 8 bits apart
      dup(3, { phash: "ffff0000ffff0001", takenAt: plus(T0, 10), dateSource: "exif" }), // 1 bit, 10 min
    ];
    expect(detectDuplicates(pair)).toEqual([]);
    expect(detectDuplicates(pair, { maxHamming: 8 })[0]!.photoIds).toEqual([pid(1), pid(2)]);
    expect(detectDuplicates(pair, { maxMinutes: 15 })[0]!.photoIds).toEqual([pid(1), pid(3)]);
    expect(detectDuplicates(pair, { maxHamming: 0, maxMinutes: 0 })).toEqual([]);
  });

  it("without EXIF times only near-identical hashes count (stricter)", () => {
    const forwarded = [dup(1, { phash: "ffff0000ffff0000" }), dup(2, { phash: "ffff0000ffff0003" }), dup(3, { phash: "ffff0000ffff003f" })];
    const groups = detectDuplicates(forwarded);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.photoIds).toEqual([pid(1), pid(2)]); // 2 bits ok, 6 bits not without a time
  });

  it("unrelated photos are never grouped, and missing hashes are tolerated", () => {
    expect(detectDuplicates([dup(1, { phash: "0000000000000000" }), dup(2, { phash: "ffffffffffffffff" }), dup(3), dup(4, { phash: "nothex", fingerprint: null })])).toEqual([]);
    expect(detectDuplicates([])).toEqual([]);
  });

  it("a group mixing exact and near members is 'near'", () => {
    const g = detectDuplicates([
      dup(1, { fingerprint: "s1:x", phash: "ffff0000ffff0000" }),
      dup(2, { fingerprint: "s1:x", phash: "ffff0000ffff0000" }),
      dup(3, { phash: "ffff0000ffff0001" }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: "near", photoIds: [pid(1), pid(2), pid(3)] });
  });

  it("preferred photo: best quality, then sharpness from the blur score, then more pixels, then id", () => {
    const base = { fingerprint: "s1:x" };
    expect(detectDuplicates([dup(1, { ...base, quality: 60 }), dup(2, { ...base, quality: 81 })])[0]!.preferredPhotoId).toBe(pid(2));
    expect(detectDuplicates([dup(1, { ...base, blurScore: 15 }), dup(2, { ...base, blurScore: 300 })])[0]!.preferredPhotoId).toBe(pid(2));
    expect(detectDuplicates([dup(1, { ...base, width: 1000, height: 800 }), dup(2, base)])[0]!.preferredPhotoId).toBe(pid(2));
    expect(detectDuplicates([dup(2, base), dup(1, base)])[0]!.preferredPhotoId).toBe(pid(1));
  });

  it("a user choice always wins over the automatic pick, and the latest choice wins", () => {
    const photos = [dup(1, { fingerprint: "s1:x", quality: 90 }), dup(2, { fingerprint: "s1:x", quality: 20 }), dup(3, { fingerprint: "s1:x", quality: 10 })];
    expect(detectDuplicates(photos, { userPreferred: [pid(3)] })[0]).toMatchObject({ preferredPhotoId: pid(3), preferredSource: "user" });
    expect(detectDuplicates(photos, { userPreferred: [pid(3), pid(2)] })[0]).toMatchObject({ preferredPhotoId: pid(2), preferredSource: "user" });
    expect(detectDuplicates(photos, { userPreferred: [pid(99)] })[0]).toMatchObject({ preferredPhotoId: pid(1), preferredSource: "auto" });
  });

  it("never removes anything: every input photo is still there, grouped or not", () => {
    const photos = [dup(1, { fingerprint: "s1:x", blurScore: 1 }), dup(2, { fingerprint: "s1:x", blurScore: 2 }), dup(3)];
    const before = JSON.stringify(photos);
    const groups = detectDuplicates(photos);
    expect(JSON.stringify(photos)).toBe(before);
    expect(groups.flatMap((g) => g.photoIds)).toEqual([pid(1), pid(2)]);
  });
});

// ---------------------------------------------------------------------------- moments

const BEACH: MomentVision = { scene: "landscape", objects: ["beach", "sea", "palm tree"], activities: ["walking on a beach"], storyRole: "establishing", peopleCount: 2 };
const DINNER: MomentVision = { scene: "food", objects: ["plate", "table", "candle"], activities: ["eating dinner"], storyRole: "detail", peopleCount: 0 };
const HIKE: MomentVision = { scene: "landscape", objects: ["mountain", "trail", "backpack"], activities: ["hiking on a trail"], storyRole: "action", peopleCount: 1 };

const mp = (n: number, o: Partial<MomentPhoto> = {}): MomentPhoto => ({
  id: pid(n),
  takenAt: null,
  dateSource: null,
  lat: null,
  lng: null,
  place: null,
  vision: null,
  quality: 70,
  qualityFlags: [],
  keep: true,
  ...o,
});
const exif = (n: number, iso: string, o: Partial<MomentPhoto> = {}) => mp(n, { takenAt: at(iso), dateSource: "exif", ...o });
const keysOf = (ms: { photoIds: string[] }[]) => ms.map((m) => m.photoIds.map((id) => Number(id.slice(-4))));

describe("moment clustering", () => {
  it("every photo ends up in exactly one moment, in story order, whatever the input order", () => {
    const photos = [exif(3, "2026-10-12T15:00:00Z"), mp(9), exif(1, "2026-10-12T09:00:00Z"), exif(2, "2026-10-12T09:05:00Z"), mp(8, { vision: BEACH })];
    const a = clusterMoments(photos);
    const b = clusterMoments([...photos].reverse());
    expect(b).toEqual(a);
    const all = a.moments.flatMap((m) => m.photoIds);
    expect(all.sort()).toEqual(photos.map((p) => p.id).sort());
    expect(new Set(all).size).toBe(photos.length);
    expect(a.moments.map((m) => m.position)).toEqual(a.moments.map((_, i) => i));
  });

  it("a date change alone is NOT a new moment: a party running past midnight stays together", () => {
    const party = [
      exif(1, "2026-10-12T19:30:00Z", { vision: DINNER }), // 23:30 in Dubai
      exif(2, "2026-10-12T19:50:00Z", { vision: DINNER }),
      exif(3, "2026-10-12T20:10:00Z", { vision: DINNER }), // 00:10 the next day in Dubai
      exif(4, "2026-10-12T20:25:00Z", { vision: DINNER }),
    ];
    const { moments, uncertain } = clusterMoments(party);
    expect(keysOf(moments)).toEqual([[1, 2, 3, 4]]);
    expect(moments[0]!.dateLabel).toBe("12–13 Oct 2026");
    expect(uncertain).toEqual([]);
  });

  it("mixed dates: moments follow the gaps, not the calendar", () => {
    const trip = [
      exif(1, "2026-10-10T06:00:00Z"),
      exif(2, "2026-10-10T06:10:00Z"),
      exif(3, "2026-10-10T13:00:00Z"), // same day, 7 h later → new moment
      exif(4, "2026-10-10T13:15:00Z"),
      exif(5, "2026-10-11T06:00:00Z"), // next morning
      exif(6, "2026-10-14T18:00:00Z"), // three days later
      exif(7, "2026-10-14T18:05:00Z"),
    ];
    expect(keysOf(clusterMoments(trip).moments)).toEqual([[1, 2], [3, 4], [5], [6, 7]]);
  });

  it("a long gap is always a break, even at the same place with the same content", () => {
    const home = { lat: 24.47, lng: 54.37, vision: DINNER };
    const { moments } = clusterMoments([exif(1, "2026-10-10T18:00:00Z", home), exif(2, "2026-10-11T18:00:00Z", home)]);
    expect(keysOf(moments)).toEqual([[1], [2]]);
    expect(moments[1]!.uncertain).toBe(false);
  });

  it("unrelated scenes split where related ones stay together (same 2.5 h gap)", () => {
    const related = clusterMoments([exif(1, "2026-10-12T09:00:00Z", { vision: BEACH }), exif(2, "2026-10-12T11:30:00Z", { vision: BEACH })]);
    const unrelated = clusterMoments([exif(1, "2026-10-12T09:00:00Z", { vision: BEACH }), exif(2, "2026-10-12T11:30:00Z", { vision: DINNER })]);
    expect(keysOf(related.moments)).toEqual([[1, 2]]);
    expect(keysOf(unrelated.moments)).toEqual([[1], [2]]);
    expect(unrelated.moments.map((m) => m.label)).toEqual(["Walking on a beach", "Eating dinner"]);
  });

  it("GPS: far apart splits a short gap, the same spot holds a longer gap together", () => {
    const muscat = { lat: 23.588, lng: 58.3829 };
    const nizwa = { lat: 22.9333, lng: 57.5333 }; // ≈ 110 km away
    const far = clusterMoments([exif(1, "2026-10-12T09:00:00Z", muscat), exif(2, "2026-10-12T09:40:00Z", nizwa)]);
    expect(keysOf(far.moments)).toEqual([[1], [2]]);
    const same = clusterMoments([exif(1, "2026-10-12T09:00:00Z", muscat), exif(2, "2026-10-12T11:50:00Z", muscat)]);
    expect(keysOf(same.moments)).toEqual([[1, 2]]);
    const noGps = clusterMoments([exif(1, "2026-10-12T09:00:00Z"), exif(2, "2026-10-12T09:40:00Z")]);
    expect(keysOf(noGps.moments)).toEqual([[1, 2]]); // unknown location is not evidence of a move
  });

  it("close calls are reported as uncertain instead of being decided silently", () => {
    // 2 h 45 min gap, no GPS, no vision: time score ≈ 0.91 → stays together, but only just
    const join = clusterMoments([exif(1, "2026-10-12T09:00:00Z"), exif(2, "2026-10-12T11:45:00Z")]);
    expect(keysOf(join.moments)).toEqual([[1, 2]]);
    expect(join.moments[0]).toMatchObject({ uncertain: true, uncertainReasons: ["weak_join"] });
    expect(join.uncertain).toEqual([{ kind: "membership", reason: "weak_join", momentKey: `m:${pid(1)}`, photoIds: [pid(1), pid(2)], score: expect.any(Number) }]);
    // 3 h 10 min: just over → split, flagged as a weak boundary between the two moments
    const split = clusterMoments([exif(1, "2026-10-12T09:00:00Z"), exif(2, "2026-10-12T12:10:00Z")]);
    expect(keysOf(split.moments)).toEqual([[1], [2]]);
    expect(split.uncertain[0]).toMatchObject({ kind: "boundary", reason: "weak_boundary", momentKey: `m:${pid(2)}`, otherMomentKey: `m:${pid(1)}` });
    expect(split.moments[1]!.confidence).toBeLessThan(split.moments[0]!.confidence);
  });

  it("the break score is configurable", () => {
    const pair = [exif(1, "2026-10-12T09:00:00Z"), exif(2, "2026-10-12T10:00:00Z")];
    expect(keysOf(clusterMoments(pair).moments)).toEqual([[1, 2]]);
    expect(keysOf(clusterMoments(pair, { fullGapMinutes: 45 }).moments)).toEqual([[1], [2]]);
    const s = breakScore({ last: pair[0]!, profile: new Set() }, pair[1]!, MOMENT_DEFAULTS);
    expect(s).toEqual({ score: 0.25, hard: false });
  });

  it("missing timestamps: an undated photo joins the moment it resembles and is flagged", () => {
    const photos = [
      exif(1, "2026-10-12T09:00:00Z", { vision: BEACH }),
      exif(2, "2026-10-12T09:10:00Z", { vision: BEACH }),
      exif(3, "2026-10-12T19:00:00Z", { vision: DINNER }),
      mp(4, { vision: { ...BEACH, objects: ["beach", "sea", "towel"] } }), // WhatsApp forward, no date
    ];
    const { moments, uncertain } = clusterMoments(photos);
    expect(keysOf(moments)).toEqual([[1, 2, 4], [3]]);
    expect(moments[0]!.uncertainReasons).toEqual(["joined_by_content"]);
    expect(uncertain).toContainEqual({ kind: "membership", reason: "joined_by_content", momentKey: `m:${pid(1)}`, photoIds: [pid(4)], score: expect.any(Number) });
    expect(moments[1]!.uncertain).toBe(false);
  });

  it("missing timestamps: GPS proximity is the second way in", () => {
    const beach = { lat: 23.588, lng: 58.3829 };
    const photos = [exif(1, "2026-10-12T09:00:00Z", beach), exif(2, "2026-10-12T09:10:00Z", beach), mp(3, { lat: 23.5882, lng: 58.383 }), mp(4, { lat: 25.2, lng: 55.27 })];
    const { moments } = clusterMoments(photos);
    expect(keysOf(moments)).toEqual([[1, 2, 3], [4]]);
    expect(moments[0]!.uncertainReasons).toEqual(["joined_by_place"]);
    expect(moments[1]).toMatchObject({ label: "Undated photos", uncertainReasons: ["no_timestamp"], startsAt: null, dateLabel: null });
  });

  it("no metadata at all: photos are kept together as one clearly uncertain group, never discarded", () => {
    const { moments, uncertain } = clusterMoments([mp(3), mp(1), mp(2)]);
    expect(keysOf(moments)).toEqual([[1, 2, 3]]);
    expect(moments[0]).toMatchObject({ label: "Undated photos", uncertain: true, uncertainReasons: ["no_evidence"], confidence: 0.1, heroPhotoId: null });
    expect(uncertain).toEqual([{ kind: "moment", reason: "no_evidence", momentKey: `m:${pid(1)}`, photoIds: [pid(1), pid(2), pid(3)] }]);
  });

  it("undated photos with different content form separate undated moments", () => {
    const { moments } = clusterMoments([mp(1, { vision: BEACH }), mp(2, { vision: DINNER }), mp(3, { vision: BEACH }), mp(4, { vision: HIKE })]);
    expect(keysOf(moments)).toEqual([[1, 3], [2], [4]]);
    expect(moments.every((m) => m.uncertainReasons.includes("no_timestamp"))).toBe(true);
    expect(moments.map((m) => m.label)).toEqual(["Walking on a beach", "Eating dinner", "Hiking on a trail"]);
  });

  it("file dates (not EXIF) are weak evidence: grouped, but flagged", () => {
    const file = (n: number, iso: string) => mp(n, { takenAt: at(iso), dateSource: "file" });
    const { moments, uncertain } = clusterMoments([file(1, "2026-10-12T09:00:00Z"), file(2, "2026-10-12T09:01:00Z"), exif(3, "2026-10-13T09:00:00Z")]);
    expect(keysOf(moments)).toEqual([[1, 2], [3]]);
    expect(moments[0]!.uncertainReasons).toEqual(["file_dates"]);
    expect(moments[0]!.confidence).toBeLessThan(moments[1]!.confidence);
    expect(uncertain).toContainEqual({ kind: "membership", reason: "file_dates", momentKey: `m:${pid(1)}`, photoIds: [pid(1), pid(2)] });
  });

  it("broken timestamps are treated as missing, not as 1970", () => {
    const { moments } = clusterMoments([mp(1, { takenAt: "garbage", dateSource: "exif" }), exif(2, "2026-10-12T09:00:00Z")]);
    expect(keysOf(moments)).toEqual([[2], [1]]);
    expect(moments[1]!.startsAt).toBeNull();
  });

  it("an empty book gives no moments", () => {
    expect(clusterMoments([])).toEqual({ moments: [], uncertain: [] });
  });
});

describe("moment labels are grounded in evidence", () => {
  it("place comes from metadata, the subject from what most photos show; both are listed as evidence", () => {
    const photos = [
      exif(1, "2026-10-12T09:00:00Z", { place: "Muscat", vision: BEACH }),
      exif(2, "2026-10-12T09:05:00Z", { place: "Muscat", vision: BEACH }),
      exif(3, "2026-10-12T09:10:00Z", { place: "Muscat", vision: { ...BEACH, activities: [] } }),
    ];
    const l = labelMoment(photos);
    expect(l.label).toBe("Walking on a beach · Muscat");
    expect(l.place).toBe("Muscat");
    expect(l.evidence).toEqual([
      { kind: "place", source: "metadata", value: "Muscat", support: 3, of: 3 },
      { kind: "activity", source: "vision", value: "walking on a beach", support: 2, of: 3 },
      { kind: "date", source: "timestamp", value: "12 Oct 2026", support: 3, of: 3 },
    ]);
  });

  it("weak evidence is not used: a place on a minority of photos, an activity seen once among many", () => {
    const photos = [
      exif(1, "2026-10-12T09:00:00Z", { place: "Muscat", vision: BEACH }),
      exif(2, "2026-10-12T09:05:00Z", { vision: DINNER }),
      exif(3, "2026-10-12T09:10:00Z", { vision: HIKE }),
      exif(4, "2026-10-12T09:15:00Z", { vision: { scene: "other", objects: ["car"], activities: [] } }),
    ];
    const l = labelMoment(photos);
    expect(l.place).toBeNull();
    expect(l.label).toBe("12 Oct 2026");
    expect(l.evidence.map((e) => e.kind)).toEqual(["date"]);
  });

  it("falls back from activity to scene to object, then to the date, then to 'Undated photos'", () => {
    const portrait: MomentVision = { scene: "portrait", objects: ["hat"], activities: [] };
    expect(labelMoment([mp(1, { vision: portrait }), mp(2, { vision: portrait })]).label).toBe("Portraits");
    const cars: MomentVision = { scene: "other", objects: ["vintage car"], activities: [] };
    expect(labelMoment([mp(1, { vision: cars }), mp(2, { vision: cars })]).label).toBe("Vintage car");
    expect(labelMoment([exif(1, "2026-10-12T09:00:00Z")]).label).toBe("12 Oct 2026");
    expect(labelMoment([mp(1)])).toEqual({ label: "Undated photos", dateLabel: null, place: null, evidence: [] });
  });

  it("a label only ever contains words from the inputs (place, vision terms) or the fixed scene names", () => {
    const photos = [exif(1, "2026-10-12T09:00:00Z", { place: "Wadi Shab", vision: HIKE }), exif(2, "2026-10-12T09:20:00Z", { place: "Wadi Shab", vision: HIKE })];
    const { moments } = clusterMoments(photos);
    expect(moments[0]!.label).toBe("Hiking on a trail · Wadi Shab");
    for (const e of moments[0]!.labelEvidence) expect(["metadata", "vision", "timestamp"]).toContain(e.source);
  });

  it("date ranges", () => {
    const d = (iso: string) => Date.parse(iso);
    expect(dateRangeLabel(d("2026-10-12T08:00:00Z"), d("2026-10-12T10:00:00Z"))).toBe("12 Oct 2026");
    expect(dateRangeLabel(d("2026-10-12T08:00:00Z"), d("2026-10-14T10:00:00Z"))).toBe("12–14 Oct 2026");
    expect(dateRangeLabel(d("2026-10-30T08:00:00Z"), d("2026-11-02T10:00:00Z"))).toBe("30 Oct – 2 Nov 2026");
    expect(dateRangeLabel(d("2026-12-30T08:00:00Z"), d("2027-01-02T10:00:00Z"))).toBe("30 Dec 2026 – 2 Jan 2027");
  });

  it("content similarity helpers", () => {
    expect(jaccard(contentTokens(BEACH), contentTokens(BEACH))).toBe(1);
    expect(jaccard(contentTokens(BEACH), contentTokens(DINNER))).toBe(0);
    expect(jaccard(contentTokens(BEACH), contentTokens(HIKE))).toBeGreaterThan(0); // both landscapes
    expect(jaccard(contentTokens(BEACH), contentTokens(HIKE))).toBeLessThan(0.34);
    expect(contentTokens(null).size).toBe(0);
    expect(jaccard(new Set(), contentTokens(BEACH))).toBe(0);
  });
});

describe("candidate ranking", () => {
  const photos = [
    exif(1, "2026-10-12T09:00:00Z", { quality: 60, vision: BEACH }),
    exif(2, "2026-10-12T09:01:00Z", { quality: 88, vision: BEACH }),
    exif(3, "2026-10-12T09:02:00Z", { quality: 95, qualityFlags: ["blurry"] }),
    exif(4, "2026-10-12T09:03:00Z", { quality: 92 }), // a duplicate of 2, not the preferred one
    exif(5, "2026-10-12T09:04:00Z", { quality: 99, keep: false }),
    exif(6, "2026-10-12T09:05:00Z", { quality: 55 }),
    exif(7, "2026-10-12T09:06:00Z", { quality: 50, qualityFlags: ["soft"] }),
  ];
  const groups: DuplicateGroup[] = [{ key: pid(2), kind: "near", photoIds: [pid(2), pid(4)], preferredPhotoId: pid(2), preferredSource: "auto" }];
  const clustered = clusterMoments(photos);
  const { moments, candidates } = rankCandidates(clustered.moments, photos, groups);
  const role = (n: number) => candidates.find((c) => c.photoId === pid(n))!;

  it("hero = the best usable photo; duplicates, blurry and dropped photos become alternates with a reason", () => {
    expect(moments[0]!.heroPhotoId).toBe(pid(2));
    expect(role(2).role).toBe("hero");
    expect(role(3)).toMatchObject({ role: "alternate", reason: "blurry" });
    expect(role(4)).toMatchObject({ role: "alternate", reason: "duplicate" });
    expect(role(5)).toMatchObject({ role: "alternate", reason: "dropped" });
    expect(role(1).role).toBe("collage");
    expect(role(6).role).toBe("collage");
    expect(role(7).role).toBe("supporting"); // soft → not collage material
  });

  it("nothing is removed: every photo is a candidate, exactly once", () => {
    expect(candidates.map((c) => c.photoId).sort()).toEqual(photos.map((p) => p.id).sort());
  });

  it("a user-preferred duplicate is usable even when it scores lower", () => {
    const userGroups: DuplicateGroup[] = [{ ...groups[0]!, preferredPhotoId: pid(4), preferredSource: "user" }];
    const r = rankCandidates(clustered.moments, photos, userGroups);
    expect(r.candidates.find((c) => c.photoId === pid(4))!.role).toBe("hero");
    expect(r.candidates.find((c) => c.photoId === pid(2))).toMatchObject({ role: "alternate", reason: "duplicate" });
  });

  it("at most 4 collage candidates per moment; a moment with nothing usable has no hero", () => {
    const many = Array.from({ length: 9 }, (_, i) => exif(i + 1, `2026-10-12T09:0${i}:00Z`, { quality: 90 - i }));
    const c = clusterMoments(many);
    const r = rankCandidates(c.moments, many);
    expect(r.candidates.filter((x) => x.role === "collage")).toHaveLength(4);
    expect(r.candidates.filter((x) => x.role === "hero")).toHaveLength(1);
    const bad = [exif(1, "2026-10-12T09:00:00Z", { qualityFlags: ["blurry"] })];
    const rb = rankCandidates(clusterMoments(bad).moments, bad);
    expect(rb.moments[0]!.heroPhotoId).toBeNull();
    expect(rb.candidates[0]).toMatchObject({ role: "alternate", reason: "blurry" });
  });
});

// ---------------------------------------------------------------------------- server functions

const row = (n: number, o: Partial<OrganizePhotoRow> = {}): OrganizePhotoRow => ({
  id: pid(n),
  fingerprint: `s1:${String(n).padStart(64, "0")}`,
  phash: null,
  thumb_path: `${USER}/${BOOK}/${pid(n)}-thumb.jpg`,
  width: 4000,
  height: 3000,
  taken_at: null,
  date_source: null,
  lat: null,
  lng: null,
  place: null,
  blur_score: 200,
  ai: null,
  status: "kept",
  ...o,
});
const visionRow = (v: MomentVision) => ({
  description: "A scene.",
  scene: v.scene,
  objects: [...v.objects],
  activities: [...v.activities],
  peopleCount: v.peopleCount ?? 0,
  orientation: "landscape",
  storyRole: v.storyRole ?? "detail",
  atmosphere: { label: "calm", interpretation: true },
  model: "claude-opus-5-5",
  promptVersion: PHOTO_PROMPT_VERSION,
});

function server(initial: { photos: OrganizePhotoRow[]; vision?: Map<string, unknown>; blurry?: Set<string>; owner?: string | null }) {
  const state = {
    photos: initial.photos,
    quality: [] as StoredQuality[],
    groups: [] as DuplicateGroup[],
    moments: [] as StoredMoment[],
    vision: initial.vision ?? new Map<string, unknown>(),
    loads: [] as string[],
    saves: [] as string[],
  };
  const deps: OrganizeDeps = {
    ownerOf: async () => (initial.owner === undefined ? USER : initial.owner),
    loadAiCopy: async (path) => {
      state.loads.push(path);
      const id = path.split("/")[2]!.slice(0, 36);
      return initial.blurry?.has(id) ? blurB64 : sharpB64;
    },
    listPhotos: async () => state.photos,
    listQuality: async () => state.quality,
    saveQuality: async (key, q: QualityScores) => {
      state.saves.push(key.photoId);
      state.quality = [...state.quality.filter((x) => x.photoId !== key.photoId), { ...q, photoId: key.photoId }];
    },
    listImageHashes: async () => new Map(),
    listVision: async () => state.vision,
    listDuplicateGroups: async () => state.groups,
    replaceDuplicateGroups: async (_b, _u, groups) => {
      state.groups = [...groups];
    },
    listMoments: async () => state.moments,
    replaceMoments: async (_b, _u, moments) => {
      state.moments = [...moments];
    },
  };
  return { state, deps };
}

describe("analyzePhotoQuality", () => {
  const own = (o: Partial<OwnPhoto> = {}) =>
    ({ id: pid(1), user_id: USER, book_id: BOOK, upload_state: "ready", thumb_path: `${USER}/${BOOK}/${pid(1)}-thumb.jpg`, ...o }) as OwnPhoto;

  it("scores the analysis copy, stores the result, and reuses it on the next call", async () => {
    const s = server({ photos: [] });
    const deps = { ...s.deps, loadPhoto: async () => own() };
    const q = await analyzePhotoQuality(pid(1), deps);
    expect(q).toMatchObject({ photoId: pid(1), version: QUALITY_VERSION, basis: "pixels" });
    expect(q.sharpness).toBeGreaterThan(40);
    expect(s.state.saves).toEqual([pid(1)]);
    const again = await analyzePhotoQuality(pid(1), deps);
    expect(again).toEqual(q);
    expect(s.state.loads).toHaveLength(1);
  });

  it("someone else's photo, a missing photo and an unfinished upload are refused without reading any image", async () => {
    const s = server({ photos: [] });
    await expect(analyzePhotoQuality(pid(1), { ...s.deps, loadPhoto: async () => null })).rejects.toMatchObject({ code: "not_found" });
    await expect(analyzePhotoQuality(pid(1), { ...s.deps, loadPhoto: async () => own({ upload_state: "pending" }) })).rejects.toMatchObject({ code: "not_ready" });
    await expect(analyzePhotoQuality(pid(1), { ...s.deps, loadPhoto: async () => own(), loadAiCopy: async () => null })).rejects.toMatchObject({ code: "no_ai_copy" });
    await expect(analyzePhotoQuality(pid(1), { ...s.deps, loadPhoto: async () => own(), loadAiCopy: async () => Buffer.from("not an image").toString("base64") })).rejects.toBeInstanceOf(OrganizeError);
    expect(s.state.saves).toEqual([]);
  });
});

describe("detectDuplicateGroups", () => {
  it("is refused for a book the caller does not own — nothing is read or written", async () => {
    const s = server({ photos: [row(1), row(2)], owner: null });
    const listPhotos = vi.fn(s.deps.listPhotos!);
    await expect(detectDuplicateGroups(BOOK, { ...s.deps, listPhotos })).rejects.toMatchObject({ code: "not_found" });
    expect(listPhotos).not.toHaveBeenCalled();
    expect(s.state.groups).toEqual([]);
  });

  it("stores the groups, and a user's preferred photo survives the next run", async () => {
    const s = server({ photos: [row(1, { phash: "ffff0000ffff0000", blur_score: 300 }), row(2, { phash: "ffff0000ffff0001", blur_score: 50 }), row(3, { phash: "0123456789abcdef" })] });
    const groups = await detectDuplicateGroups(BOOK, s.deps);
    expect(groups).toEqual([{ key: pid(1), kind: "near", photoIds: [pid(1), pid(2)], preferredPhotoId: pid(1), preferredSource: "auto" }]);
    expect(s.state.groups).toEqual(groups);
    s.state.groups = [{ ...groups[0]!, preferredPhotoId: pid(2), preferredSource: "user" }];
    s.state.photos = [...s.state.photos, row(4, { phash: "ffff0000ffff0000", blur_score: 900 })]; // a new, sharper copy arrives
    const again = await detectDuplicateGroups(BOOK, s.deps);
    expect(again[0]).toMatchObject({ photoIds: [pid(1), pid(2), pid(4)], preferredPhotoId: pid(2), preferredSource: "user" });
    expect(s.state.photos.every((p) => p.status === "kept")).toBe(true);
  });
});

describe("clusterPhotosIntoMoments", () => {
  const day1 = (n: number, minute: number, o: Partial<OrganizePhotoRow> = {}) => row(n, { taken_at: `2026-10-12T09:${String(minute).padStart(2, "0")}:00+00:00`, date_source: "exif", ...o });

  it("returns the full structured result: quality, duplicate groups, candidates, moments, uncertain groupings", async () => {
    const photos = [
      day1(1, 0, { phash: "ffff0000ffff0000", place: "Muscat" }),
      day1(2, 1, { phash: "ffff0000ffff0001", place: "Muscat" }), // burst duplicate of 1, blurred
      day1(3, 5, { place: "Muscat" }),
      row(4, { taken_at: "2026-10-12T19:00:00+00:00", date_source: "exif" }),
      row(5), // no date, no vision
    ];
    const vision = new Map<string, unknown>([
      [pid(1), visionRow(BEACH)],
      [pid(2), visionRow(BEACH)],
      [pid(3), visionRow(BEACH)],
      [pid(4), visionRow(DINNER)],
    ]);
    const s = server({ photos, vision, blurry: new Set([pid(2)]) });
    const r = await clusterPhotosIntoMoments(BOOK, s.deps);
    expect(OrganizeResultSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ bookId: BOOK, photos: 5, pending: { quality: 0, vision: 1 } });
    expect(r.quality).toHaveLength(5);
    expect(r.quality.every((q) => q.basis === "pixels")).toBe(true);
    expect(r.duplicateGroups).toEqual([{ key: pid(1), kind: "near", photoIds: [pid(1), pid(2)], preferredPhotoId: pid(1), preferredSource: "auto" }]);
    expect(keysOf(r.moments)).toEqual([[1, 2, 3], [4], [5]]);
    expect(r.moments.map((m) => m.label)).toEqual(["Walking on a beach · Muscat", "Eating dinner", "Undated photos"]);
    expect(r.moments[0]!.heroPhotoId).not.toBe(pid(2));
    expect(r.candidates.find((c) => c.photoId === pid(2))).toMatchObject({ role: "alternate", reason: "duplicate" });
    expect(r.uncertain).toEqual([{ kind: "moment", reason: "no_evidence", momentKey: `m:${pid(5)}`, photoIds: [pid(5)] }]);
    // stored
    expect(s.state.moments.map((m) => m.key)).toEqual(r.moments.map((m) => m.key));
    expect(s.state.groups).toEqual(r.duplicateGroups);
    // nothing dropped, nothing deleted
    expect(s.state.photos.map((p) => p.status)).toEqual(["kept", "kept", "kept", "kept", "kept"]);
    expect(r.candidates).toHaveLength(5);
  });

  it("incremental: a second call after more uploads scores only the new photos and extends the moments", async () => {
    const s = server({ photos: [day1(1, 0), day1(2, 2)] });
    const first = await clusterPhotosIntoMoments(BOOK, s.deps);
    expect([...s.state.saves].sort()).toEqual([pid(1), pid(2)]); // scored in parallel: order is not fixed
    expect(keysOf(first.moments)).toEqual([[1, 2]]);
    s.state.photos = [...s.state.photos, day1(3, 4), row(4, { taken_at: "2026-10-13T12:00:00+00:00", date_source: "exif" })];
    const second = await clusterPhotosIntoMoments(BOOK, s.deps);
    expect([...s.state.saves].sort()).toEqual([pid(1), pid(2), pid(3), pid(4)]); // 1 and 2 were not scored again
    expect(s.state.saves).toHaveLength(4);
    expect(keysOf(second.moments)).toEqual([[1, 2, 3], [4]]);
    expect(second.moments[0]!.key).toBe(first.moments[0]!.key); // the moment kept its identity
    const third = await clusterPhotosIntoMoments(BOOK, s.deps);
    expect(third).toEqual(second); // idempotent
    expect(s.state.saves).toHaveLength(4);
  });

  it("incremental: the user's label and hero choice are kept when the moment grows", async () => {
    const s = server({ photos: [day1(1, 0), day1(2, 2)] });
    const first = await clusterPhotosIntoMoments(BOOK, s.deps);
    s.state.moments = [{ ...s.state.moments[0]!, label: "Our first morning", labelSource: "user", heroPhotoId: pid(2), heroSource: "user" }];
    s.state.photos = [...s.state.photos, day1(3, 4), day1(0 + 9, 1)];
    const second = await clusterPhotosIntoMoments(BOOK, s.deps);
    expect(second.moments[0]).toMatchObject({ key: first.moments[0]!.key, label: "Our first morning", labelSource: "user", heroPhotoId: pid(2), heroSource: "user" });
    expect(second.candidates.filter((c) => c.role === "hero").map((c) => c.photoId)).toEqual([pid(2)]);
  });

  it("a user hero that was deleted falls back to the automatic pick; a user label still stays", async () => {
    const s = server({ photos: [day1(1, 0), day1(2, 2), day1(3, 4)] });
    await clusterPhotosIntoMoments(BOOK, s.deps);
    s.state.moments = [{ ...s.state.moments[0]!, label: "Mine", labelSource: "user", heroPhotoId: pid(3), heroSource: "user" }];
    s.state.photos = s.state.photos.filter((p) => p.id !== pid(3)); // the user deleted that photo
    const r = await clusterPhotosIntoMoments(BOOK, s.deps);
    expect(r.moments[0]).toMatchObject({ label: "Mine", labelSource: "user", heroSource: "auto" });
    expect(r.moments[0]!.photoIds).toEqual([pid(1), pid(2)]);
    expect(r.moments[0]!.heroPhotoId).not.toBe(pid(3));
  });

  it("is bounded: photos beyond the per-run limit use a provisional score and are reported as pending", async () => {
    const s = server({ photos: [day1(1, 0), day1(2, 1), day1(3, 2), day1(4, 3, { blur_score: null })] });
    const r = await clusterPhotosIntoMoments(BOOK, { ...s.deps, maxQualityPerRun: 2 });
    expect(s.state.saves).toHaveLength(2);
    expect(r.pending.quality).toBe(2);
    expect(r.quality.map((q) => q.basis)).toEqual(["pixels", "pixels", "blur_score"]); // photo 4 has nothing to go on yet
    expect(keysOf(r.moments)).toEqual([[1, 2, 3, 4]]); // still grouped
    const next = await clusterPhotosIntoMoments(BOOK, { ...s.deps, maxQualityPerRun: 2 });
    expect(next.pending.quality).toBe(0);
  });

  it("an unreadable analysis copy does not fail the run", async () => {
    const s = server({ photos: [day1(1, 0), day1(2, 1)] });
    const r = await clusterPhotosIntoMoments(BOOK, { ...s.deps, loadAiCopy: async (path) => (path.includes(pid(2)) ? null : sharpB64) });
    expect(r.pending.quality).toBe(1);
    expect(r.quality.find((q) => q.photoId === pid(2))!.basis).toBe("blur_score");
    expect(keysOf(r.moments)).toEqual([[1, 2]]);
  });

  it("is refused for a book the caller does not own, and works for an empty book", async () => {
    await expect(clusterPhotosIntoMoments(BOOK, server({ photos: [row(1)], owner: null }).deps)).rejects.toMatchObject({ code: "not_found" });
    const empty = await clusterPhotosIntoMoments(BOOK, server({ photos: [] }).deps);
    expect(empty).toEqual({ bookId: BOOK, photos: 0, quality: [], duplicateGroups: [], candidates: [], moments: [], uncertain: [], pending: { quality: 0, vision: 0 } });
  });

  it("dropped photos are still grouped and listed as alternates — never removed", async () => {
    const s = server({ photos: [day1(1, 0), day1(2, 1, { status: "dropped" })] });
    const r = await clusterPhotosIntoMoments(BOOK, s.deps);
    expect(keysOf(r.moments)).toEqual([[1, 2]]);
    expect(r.candidates.find((c) => c.photoId === pid(2))).toMatchObject({ role: "alternate", reason: "dropped" });
  });
});

// Perf fix (story-export-readiness): the quality scores of a call are stored in ONE write.
describe("clusterPhotosIntoMoments: one write for the batch's quality scores", () => {
  const setupBook = () => {
    const photos = [1, 2, 3, 4, 5, 6, 7].map((n) => row(n, { taken_at: `2026-10-12T1${n}:00:00+00:00`, date_source: "exif" }));
    return server({ photos, blurry: new Set([pid(2), pid(5)]) });
  };
  /** The same server with saveQualities: one write of many rows, recorded. */
  const bulkOf = (s: ReturnType<typeof server>, fail = false) => {
    const writes: string[][] = [];
    const saveQualities: NonNullable<OrganizeDeps["saveQualities"]> = async (rows) => {
      writes.push(rows.map((r) => r.key.photoId));
      if (fail) throw new Error("down");
      for (const { key, q } of rows) s.state.quality = [...s.state.quality.filter((x) => x.photoId !== key.photoId), { ...q, photoId: key.photoId }];
    };
    return { writes, deps: { ...s.deps, saveQualities } };
  };

  it("same result and the same stored scores as one write per photo", async () => {
    const before = setupBook();
    const expected = await clusterPhotosIntoMoments(BOOK, before.deps);
    const now = setupBook();
    const bulk = bulkOf(now);
    const got = await clusterPhotosIntoMoments(BOOK, bulk.deps);
    expect(got).toEqual(expected);
    expect(bulk.writes).toHaveLength(1);
    expect([...bulk.writes[0]!].sort()).toEqual([1, 2, 3, 4, 5, 6, 7].map(pid));
    expect(now.state.saves).toEqual([]); // no per-photo write
    const byId = (q: StoredQuality[]) => [...q].sort((a, b) => a.photoId.localeCompare(b.photoId));
    expect(byId(now.state.quality)).toEqual(byId(before.state.quality));
  });

  it("copies this tick already read (photo analysis) are scored without downloading them again — same scores", async () => {
    const before = setupBook();
    const expected = await clusterPhotosIntoMoments(BOOK, before.deps);
    const now = setupBook();
    const kept = new Map<string, string>();
    for (const n of [1, 2, 3]) kept.set(`${USER}/${BOOK}/${pid(n)}-thumb.jpg`, (await before.deps.loadAiCopy!(`${USER}/${BOOK}/${pid(n)}-thumb.jpg`))!);
    const got = await clusterPhotosIntoMoments(BOOK, { ...now.deps, aiCopyCache: { get: (p) => kept.get(p), set: () => {} } });
    expect(got).toEqual(expected);
    expect(now.state.loads.map((p) => p.split("/")[2]!.slice(0, 36)).sort()).toEqual([4, 5, 6, 7].map(pid));
  });

  it("if the one write fails, each photo is stored on its own (same result); a photo whose own write fails stays unscored", async () => {
    const before = setupBook();
    const expected = await clusterPhotosIntoMoments(BOOK, before.deps);
    const now = setupBook();
    const bulk = bulkOf(now, true);
    const got = await clusterPhotosIntoMoments(BOOK, bulk.deps);
    expect(got).toEqual(expected);
    expect([...now.state.saves].sort()).toEqual([1, 2, 3, 4, 5, 6, 7].map(pid));

    const again = setupBook();
    const flaky = bulkOf(again, true);
    const save = again.deps.saveQuality!;
    const partial = await clusterPhotosIntoMoments(BOOK, {
      ...flaky.deps,
      saveQuality: async (key, q) => {
        if (key.photoId === pid(3)) throw new Error("down");
        return save(key, q);
      },
    });
    expect(partial.pending.quality).toBe(1);
    expect(partial.quality.find((q) => q.photoId === pid(3))?.basis).not.toBe("pixels");
  });
});

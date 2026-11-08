import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  AlbumPlanAiSchema,
  AlbumPlanStrictSchema,
  CuratorBatchAiSchema,
  CuratorBatchStrictSchema,
  CritiqueAiSchema,
  CritiqueStrictSchema,
  MomentCaptionsAiSchema,
  MomentCaptionsStrictSchema,
  PhotoAnalysisStrictSchema,
  wordCount,
} from "@/lib/ai/schemas";
import { hasLoneSurrogate } from "@/lib/text/clip";

const photo = (o: Record<string, unknown> = {}) => ({
  photoId: "p1",
  description: "Two people laughing on a balcony at sunset",
  scene: "group",
  peopleCount: 2,
  mood: "joyful",
  quality: 8,
  coverWorthy: true,
  keep: true,
  dropReason: null,
  ...o,
});

const plan = (o: Record<string, unknown> = {}) => ({
  title: "Sara & Omar",
  subtitle: "October 2026",
  coverPhotoId: "p1",
  moments: [
    {
      id: "m1",
      title: "The Mehndi Night",
      dateLabel: "12 Oct 2026",
      place: null,
      pages: [
        { layoutId: "two-vertical", photoIds: ["p2", "p3"] },
        { layoutId: "full-page", photoIds: ["p4"] },
      ],
    },
  ],
  ...o,
});

describe("AI-facing schemas → output_config.format", () => {
  it.each([
    ["curator", CuratorBatchAiSchema],
    ["storyteller", AlbumPlanAiSchema],
    ["captions", MomentCaptionsAiSchema],
    ["critic", CritiqueAiSchema],
  ] as const)("%s converts to a strict JSON schema", (_n, schema) => {
    const f = zodOutputFormat(schema);
    expect(f.type).toBe("json_schema");
    expect(f.schema.additionalProperties).toBe(false);
    const json = JSON.stringify(f.schema);
    // Lean: no numeric/length constraints leak in as hard keywords.
    expect(json).not.toMatch(/"(minimum|maximum|minLength|maxLength|exclusiveMinimum)"/);
  });

  it("AI schema accepts what the strict one rejects (strict is the real gate)", () => {
    const out = { photos: [photo({ quality: 42 })] };
    expect(CuratorBatchAiSchema.safeParse(out).success).toBe(true);
    expect(CuratorBatchStrictSchema.safeParse(out).success).toBe(false);
  });
});

describe("PhotoAnalysis strict", () => {
  it("accepts a valid batch", () => {
    const r = CuratorBatchStrictSchema.safeParse({ photos: [photo(), photo({ photoId: "p2", keep: false, dropReason: "blurry" })] });
    expect(r.success).toBe(true);
  });

  it.each([
    ["quality 0", { quality: 0 }],
    ["quality 11", { quality: 11 }],
    ["quality 7.5", { quality: 7.5 }],
    ["negative people", { peopleCount: -1 }],
    ["unknown scene", { scene: "selfie" }],
    ["unknown mood", { mood: "angry" }],
    ["unknown dropReason", { keep: false, dropReason: "ugly" }],
    ["uuid instead of alias", { photoId: "8f8e0f5e-4b7a-4a51-9c9e-1f7f0c4c2a11" }],
    ["alias p0", { photoId: "p0" }],
    ["empty description", { description: "   " }],
    ["dropped without reason", { keep: false, dropReason: null }],
  ])("rejects %s", (_n, o) => {
    expect(PhotoAnalysisStrictSchema.safeParse(photo(o)).success).toBe(false);
  });

  it("clips long descriptions to 200 units without lone surrogates", () => {
    const long = "😀".repeat(150); // 300 UTF-16 units
    const r = PhotoAnalysisStrictSchema.parse(photo({ description: long }));
    expect(r.description.length).toBeLessThanOrEqual(200);
    expect(hasLoneSurrogate(r.description)).toBe(false);
  });

  it("clears dropReason on kept photos", () => {
    expect(PhotoAnalysisStrictSchema.parse(photo({ keep: true, dropReason: "duplicate" })).dropReason).toBeNull();
  });

  it("rejects duplicate ids, empty and >10-photo batches", () => {
    expect(CuratorBatchStrictSchema.safeParse({ photos: [photo(), photo()] }).success).toBe(false);
    expect(CuratorBatchStrictSchema.safeParse({ photos: [] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => photo({ photoId: `p${i + 1}` }));
    expect(CuratorBatchStrictSchema.safeParse({ photos: eleven }).success).toBe(false);
  });
});

describe("AlbumPlan strict", () => {
  it("accepts a valid plan and normalises empty place to null", () => {
    const p = plan();
    (p.moments[0] as { place: string | null }).place = "  ";
    const r = AlbumPlanStrictSchema.parse(p);
    expect(r.moments[0].place).toBeNull();
  });

  it.each([
    ["bad cover alias", { coverPhotoId: "cover" }],
    ["empty title", { title: "" }],
    ["no moments", { moments: [] }],
    [
      "bad moment id",
      { moments: [{ id: "intro", title: "x", dateLabel: "", place: null, pages: [{ layoutId: "full-page", photoIds: ["p2"] }] }] },
    ],
    [
      "moment without pages",
      { moments: [{ id: "m1", title: "x", dateLabel: "", place: null, pages: [] }] },
    ],
    [
      "bad layout id",
      { moments: [{ id: "m1", title: "x", dateLabel: "", place: null, pages: [{ layoutId: "Full Page!", photoIds: ["p2"] }] }] },
    ],
    [
      "photo on two pages",
      {
        moments: [
          { id: "m1", title: "a", dateLabel: "", place: null, pages: [{ layoutId: "full-page", photoIds: ["p2"] }] },
          { id: "m2", title: "b", dateLabel: "", place: null, pages: [{ layoutId: "full-page", photoIds: ["p2"] }] },
        ],
      },
    ],
    [
      "duplicate moment ids",
      {
        moments: [
          { id: "m1", title: "a", dateLabel: "", place: null, pages: [{ layoutId: "full-page", photoIds: ["p2"] }] },
          { id: "m1", title: "b", dateLabel: "", place: null, pages: [{ layoutId: "full-page", photoIds: ["p3"] }] },
        ],
      },
    ],
  ])("rejects %s", (_n, o) => {
    expect(AlbumPlanStrictSchema.safeParse(plan(o)).success).toBe(false);
  });

  it("clips the title by code points (120)", () => {
    const r = AlbumPlanStrictSchema.parse(plan({ title: "𝒜".repeat(200) }));
    expect(Array.from(r.title).length).toBeLessThanOrEqual(120);
  });
});

describe("MomentCaptions / Critique strict", () => {
  it("accepts Arabic captions and rejects duplicate pageIndex", () => {
    const ok = { momentId: "m1", heading: "ليلة الحناء", pageCaptions: [{ pageIndex: 0, text: "أجمل ليلة بدأت بضحكة" }] };
    expect(MomentCaptionsStrictSchema.safeParse(ok).success).toBe(true);
    const dup = { ...ok, pageCaptions: [ok.pageCaptions[0], ok.pageCaptions[0]] };
    expect(MomentCaptionsStrictSchema.safeParse(dup).success).toBe(false);
    expect(MomentCaptionsStrictSchema.safeParse({ ...ok, momentId: "x" }).success).toBe(false);
    expect(wordCount("أجمل ليلة بدأت بضحكة")).toBe(4);
  });

  it("critique score must be an integer 1-10", () => {
    const issue = { type: "weak_cover", pageIndex: null, detail: "Cover is dark", fix: "change_cover" };
    expect(CritiqueStrictSchema.safeParse({ score: 7, issues: [issue] }).success).toBe(true);
    expect(CritiqueStrictSchema.safeParse({ score: 0, issues: [] }).success).toBe(false);
    expect(CritiqueStrictSchema.safeParse({ score: 7, issues: [{ ...issue, fix: "delete_book" }] }).success).toBe(false);
  });
});

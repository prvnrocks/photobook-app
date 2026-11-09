import { describe, expect, it } from "vitest";

import { PLANTED_MISMATCH_KEY } from "@/lib/ai/agents/critic-replay";
import {
  CRITIC_REPAIR_BELOW,
  momentIdOfKey,
  pageCaptionKeys,
  pageIndexOfKey,
  pickCoverSwap,
  planRepair,
  repairTargetCount,
  type CoverCandidate,
} from "@/lib/ai/repair";
import type { Critique } from "@/lib/ai/schemas";
import { storyPhotos } from "../helpers/story-fixtures";
import { batchIndexOf, CLEAN_CAPTIONS, draftDoc, LONG_INVENTED, precheckOf } from "../helpers/critic-fixtures";

const photos = storyPhotos();
const opts = { photos, batchIndexOf };
const issue = (type: Critique["issues"][number]["type"], pageIndex: number | null, fix: Critique["issues"][number]["fix"] = "rewrite_caption") => ({
  type,
  pageIndex,
  detail: "SECRET-DETAIL text about the photos",
  fix,
});

describe("pageIndex ↔ captionKey", () => {
  it("maps doc page indexes to m{n}:{k} per chapter and back", () => {
    const doc = draftDoc();
    expect(pageCaptionKeys(doc)).toEqual(["m1:0", "m1:1", "m1:2", "m1:3", "m2:0", "m2:1", "m2:2"]);
    expect(pageIndexOfKey(doc, "m2:0")).toBe(4);
    expect(pageIndexOfKey(doc, "m2:heading")).toBeNull();
    expect(pageIndexOfKey(doc, "m9:0")).toBeNull();
    expect(momentIdOfKey("m2:heading")).toBe("m2");
    expect(momentIdOfKey("x:1")).toBeNull();
    expect(pageIndexOfKey(doc, PLANTED_MISMATCH_KEY)).toBe(1);
  });

  it("an unknown chapterId has no key", () => {
    const doc = draftDoc();
    doc.pages[2].chapterId = "c99";
    expect(pageCaptionKeys(doc)[2]).toBeNull();
    expect(pageCaptionKeys(doc)[3]).toBe("m1:2");
    doc.pages[3].chapterId = null;
    expect(pageCaptionKeys(doc)[3]).toBeNull();
  });
});

describe("planRepair", () => {
  it("planted scenario: one pre-check target + one critic target, grouped by batch", () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m2:0": LONG_INVENTED });
    const pre = precheckOf(doc);
    expect([...pre.keys()]).toEqual(["m2:0"]);
    const critique: Critique = { score: 5, issues: [issue("caption_mismatch", 1)] };
    const plan = planRepair(critique, pre, doc, opts);
    expect(repairTargetCount(plan)).toBe(2);
    expect([...plan.rewrite.keys()]).toEqual([0, 1]);
    expect(plan.rewrite.get(0)).toEqual([{ key: "m1:1", reason: "critic: caption_mismatch" }]);
    expect(plan.rewrite.get(1)?.[0].key).toBe("m2:0");
    expect(plan.rewrite.get(1)?.[0].reason).toMatch(/^pre-check: .*too_long/);
    expect(plan.rewrite.get(1)?.[0].reason).toContain("unknown_name");
    expect(plan.coverSwap).toBeNull();
    expect(plan.loggedOnly).toEqual([]);
  });

  it("score 8 + clean pre-check → nothing to repair; issues logged only", () => {
    const doc = draftDoc();
    const pre = precheckOf(doc);
    expect(pre.size).toBe(0);
    const clean = planRepair({ score: 8, issues: [] }, pre, doc, opts);
    expect(repairTargetCount(clean)).toBe(0);
    expect(clean.coverSwap).toBeNull();

    const withIssues = planRepair(
      { score: CRITIC_REPAIR_BELOW, issues: [issue("caption_mismatch", 1), issue("weak_cover", null, "change_cover")] },
      pre,
      doc,
      opts,
    );
    expect(repairTargetCount(withIssues)).toBe(0);
    expect(withIssues.coverSwap).toBeNull();
    expect(withIssues.loggedOnly).toEqual(["caption_mismatch@1:score_ok", "weak_cover@book:score_ok"]);
  });

  it("critic refusal (null critique) → pre-check targets only", () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m1:3": LONG_INVENTED });
    const plan = planRepair(null, precheckOf(doc), doc, opts);
    expect(repairTargetCount(plan)).toBe(1);
    expect(plan.rewrite.get(0)?.map((t) => t.key)).toEqual(["m1:3"]);
    expect(plan.loggedOnly).toEqual([]);
  });

  it("the same caption flagged by both → one target with both reasons", () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m1:1": LONG_INVENTED });
    const plan = planRepair({ score: 4, issues: [issue("caption_invented_fact", 1)] }, precheckOf(doc), doc, opts);
    expect(repairTargetCount(plan)).toBe(1);
    expect(plan.rewrite.get(0)?.[0].reason).toMatch(/^pre-check: .+; critic: caption_invented_fact$/);
  });

  it("too_repetitive targets the page; headings from the pre-check go first in their batch", () => {
    const doc = draftDoc();
    const pre = new Map([["m2:heading", [{ code: "too_long" as const, key: "m2:heading" }]]]);
    const plan = planRepair({ score: 6, issues: [issue("too_repetitive", 6)] }, pre, doc, opts);
    expect(plan.rewrite.get(1)).toEqual([
      { key: "m2:heading", reason: "pre-check: too_long" },
      { key: "m2:2", reason: "critic: too_repetitive" },
    ]);
  });

  it("user captions are never targeted (pre-check or critic)", () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m1:1": LONG_INVENTED }, ["m1:1"]);
    // A pre-check map that (wrongly) includes the user caption must still be ignored.
    const pre = new Map([["m1:1", [{ code: "too_long" as const, key: "m1:1" }]]]);
    const plan = planRepair({ score: 3, issues: [issue("caption_mismatch", 1), issue("caption_invented_fact", 1)] }, pre, doc, opts);
    expect(repairTargetCount(plan)).toBe(0);
    expect(plan.loggedOnly).toEqual([
      "precheck@m1:1:user_caption",
      "caption_mismatch@1:user_caption",
      "caption_invented_fact@1:user_caption",
    ]);
  });

  it("caption issues on pages without a caption / page, other types, and unbatched moments are logged only", () => {
    const doc = draftDoc();
    const plan = planRepair(
      {
        score: 4,
        issues: [
          issue("caption_mismatch", 5), // full-page: no caption area
          issue("too_repetitive", null),
          issue("chronology", 2, "reorder"),
          issue("duplicate_feel", 3, "swap_photo"),
          issue("unbalanced_chapter", 4, "change_layout"),
          issue("low_quality_photo", 6, "swap_photo"),
        ],
      },
      new Map(),
      doc,
      { photos, batchIndexOf: () => null },
    );
    expect(repairTargetCount(plan)).toBe(0);
    expect(plan.loggedOnly).toEqual([
      "caption_mismatch@5:no_caption",
      "too_repetitive@book:no_page",
      "chronology@2",
      "duplicate_feel@3",
      "unbalanced_chapter@4",
      "low_quality_photo@6",
    ]);
    const unbatched = planRepair({ score: 4, issues: [issue("caption_mismatch", 0)] }, new Map(), doc, { photos, batchIndexOf: () => null });
    expect(unbatched.loggedOnly).toEqual(["caption_mismatch@0:no_batch"]);
  });

  it("reasons and logged entries never contain caption text or critique detail", () => {
    const doc = draftDoc({ ...CLEAN_CAPTIONS, "m2:0": LONG_INVENTED });
    const plan = planRepair({ score: 2, issues: [issue("caption_mismatch", 1), issue("chronology", 0, "reorder")] }, precheckOf(doc), doc, opts);
    const json = JSON.stringify({ rewrite: [...plan.rewrite.entries()], loggedOnly: plan.loggedOnly });
    expect(json).not.toContain("SECRET-DETAIL");
    expect(json).not.toContain("Paris");
    expect(json).not.toContain("Every corner");
  });
});

describe("cover swap", () => {
  const cand = (id: string, over: Partial<CoverCandidate> & { scene?: string; quality?: number; coverWorthy?: boolean } = {}): CoverCandidate => ({
    id,
    keep: over.keep ?? true,
    takenAt: over.takenAt ?? "2026-10-12T16:00:00",
    analysis: {
      scene: (over.scene ?? "portrait") as "portrait",
      quality: over.quality ?? 7,
      coverWorthy: over.coverWorthy ?? true,
    },
  });

  it("weak_cover → best kept cover-worthy portrait/group photo, not the current cover", () => {
    const doc = draftDoc();
    const current = doc.cover.photoId as string;
    const pool: CoverCandidate[] = [
      cand(current, { quality: 10 }), // current cover
      cand("landscape-10", { scene: "landscape", quality: 10 }),
      cand("dropped-10", { keep: false, quality: 10 }),
      cand("not-worthy-10", { coverWorthy: false, quality: 10 }),
      cand("group-9-late", { scene: "group", quality: 9, takenAt: "2026-10-13T10:00:00" }),
      cand("portrait-9-early", { quality: 9, takenAt: "2026-10-12T09:00:00" }),
      cand("portrait-8", { quality: 8 }),
      { id: "unanalysed", keep: true, takenAt: null, analysis: null },
    ];
    const plan = planRepair({ score: 5, issues: [issue("weak_cover", null, "change_cover")] }, new Map(), doc, { photos: pool, batchIndexOf });
    expect(plan.coverSwap).toBe("portrait-9-early");
    expect(repairTargetCount(plan)).toBe(0);
    expect(pickCoverSwap(pool.filter((p) => p.id !== "portrait-9-early"), current)).toBe("group-9-late");
  });

  it("no candidate or a locked cover → logged only", () => {
    const doc = draftDoc();
    const weak: Critique = { score: 5, issues: [issue("weak_cover", null, "change_cover")] };
    const none = planRepair(weak, new Map(), doc, { photos: [cand("x", { scene: "food" })], batchIndexOf });
    expect(none.coverSwap).toBeNull();
    expect(none.loggedOnly).toEqual(["weak_cover@book:no_candidate"]);
    const locked = planRepair(weak, new Map(), doc, { photos: [cand("y")], batchIndexOf, keepCoverOverride: true });
    expect(locked.coverSwap).toBeNull();
    expect(locked.loggedOnly).toEqual(["weak_cover@book:cover_locked"]);
  });
});

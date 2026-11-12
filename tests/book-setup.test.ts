import { describe, expect, it } from "vitest";
import { buildRuleDraft, type DraftPhotoRow } from "@/lib/book/rule-draft";
import { designLockReason, detailsLockReason, isDesignUnlocked } from "@/lib/book/setup";
import { docOrigin } from "@/lib/book/replaceable";

// M13 T2 (D-070): setup guard + rule draft rebuild.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function photos(n: number, landscape = false): DraftPhotoRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: id(i + 1),
    width: landscape ? 1600 : 1200,
    height: landscape ? 1200 : 1600,
    taken_at: `2026-10-12T${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${String((i % 2) * 30).padStart(2, "0")}:00+04:00`,
    date_source: "exif",
    place: null,
    blur_score: 100,
    status: "kept",
    dup_group: null,
    color: "#a0b0c0",
  }));
}

const SETUP = { occasion: "other", title: null, captionLang: "en", isPaid: false } as const;

function draft(design = { format: "A5_PORTRAIT", designStyle: "modern" } as const) {
  const r = buildRuleDraft(photos(8), { ...SETUP, design });
  if (!r.ok) throw new Error("draft failed");
  return r.doc;
}

describe("designLockReason / detailsLockReason", () => {
  it("unlocked for an empty doc without runs", () => {
    expect(designLockReason({ hasRun: false, doc: {} })).toBeNull();
    expect(isDesignUnlocked({ hasRun: false, doc: {} })).toBe(true);
    expect(detailsLockReason({ hasRun: false })).toBeNull();
  });

  it("unlocked for an untouched rule draft", () => {
    expect(designLockReason({ hasRun: false, doc: draft() })).toBeNull();
  });

  it("locked once any run exists", () => {
    expect(designLockReason({ hasRun: true, doc: {} })).toBe("ai_started");
    expect(detailsLockReason({ hasRun: true })).toBe("ai_started");
  });

  it("design locked once the doc is user-edited (details stay open)", () => {
    const doc = draft();
    const edited = { ...doc, meta: { ...doc.meta!, userEdited: true } };
    expect(docOrigin(edited).userEdited).toBe(true);
    expect(designLockReason({ hasRun: false, doc: edited })).toBe("user_edited");
    expect(detailsLockReason({ hasRun: false })).toBeNull();
  });

  it("an unparsable doc counts as user-edited (safe side)", () => {
    expect(designLockReason({ hasRun: false, doc: { pages: "nope" } })).toBe("user_edited");
  });

  it("an AI album without a run row is past the first build", () => {
    const doc = draft();
    const ai = { ...doc, meta: { ...doc.meta!, generator: "ai" as const } };
    expect(designLockReason({ hasRun: false, doc: ai })).toBe("ai_started");
  });
});

describe("buildRuleDraft", () => {
  it.each([
    ["A5_PORTRAIT", "modern"],
    ["A5_LANDSCAPE", "modern"],
    ["A5_PORTRAIT", "classic"],
    ["A5_LANDSCAPE", "geometric"],
    ["A5_PORTRAIT", "scrapbook"],
  ] as const)("lays out a valid %s / %s draft stamped with the design", (format, designStyle) => {
    const r = buildRuleDraft(photos(8, format === "A5_LANDSCAPE"), { ...SETUP, design: { format, designStyle } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.format).toBe(format);
    expect(r.doc.style.designStyle).toBe(designStyle);
    expect(r.pageCount).toBe(r.doc.pages.length);
    expect(docOrigin(r.doc)).toEqual({ generator: "rule", userEdited: false });
  });

  it("is deterministic (same input → same doc)", () => {
    expect(draft()).toEqual(draft());
  });

  it("uses the title on the cover", () => {
    const r = buildRuleDraft(photos(6), { ...SETUP, title: "Eid 2026", design: { format: "A5_PORTRAIT", designStyle: "modern" } });
    expect(r.ok && r.doc.cover.title).toBe("Eid 2026");
  });

  it("refuses an unsupported style without throwing", () => {
    const r = buildRuleDraft(photos(6), {
      ...SETUP,
      design: { format: "A5_PORTRAIT", designStyle: "baroque" as never },
    });
    expect(r).toEqual({ ok: false, reason: "unsupported_design" });
  });
});

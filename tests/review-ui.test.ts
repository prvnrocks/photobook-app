import { describe, expect, it, vi } from "vitest";
import { DROP_REASONS } from "@/lib/ai/schemas";
import { getLayout } from "@/lib/layouts";
import {
  aiPicked,
  applyUserChoice,
  BANNER_COPY,
  captionSourceLabel,
  captionTextAttrs,
  captionsPreviewModel,
  captionsPreviewOf,
  changedPhotosCopy,
  CONTINUE_UNSYNCED_NOTE,
  countKept,
  docOutOfSync,
  docPhotoIds,
  headerCopy,
  isMainlyArabic,
  missingCaptionsCopy,
  PARTIAL_CAPTIONS_NOTE,
  partialCaptionsNote,
  reasonLabel,
  REBUILD_LABELS,
  REBUILD_MESSAGES,
  rebuildOutcome,
  rebuildsLeft,
  rebuildsLeftCopy,
  rebuildsLeftLabel,
  rebuildTrigger,
  rebuildVariant,
  requestRebuild,
  reviewBanner,
  thumbSize,
  unsyncedPhotoIds,
  UPDATE_ALBUM_MESSAGES,
  updateAlbumOutcome,
  USER_REMOVED_REASON,
  visiblePhotos,
  type ReviewTilePhoto,
} from "@/lib/review/ui";

const BOOK = "11111111-1111-4111-8111-111111111111";

function photo(id: string, over: Partial<ReviewTilePhoto> = {}): ReviewTilePhoto {
  return {
    id,
    status: "kept",
    dropReason: null,
    userOverride: false,
    dupGroup: null,
    width: 4000,
    height: 3000,
    thumbUrl: `https://x.test/${id}`,
    ...over,
  };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("reasonLabel", () => {
  it("has a human label for every AI drop reason", () => {
    for (const r of DROP_REASONS) {
      expect(reasonLabel(r)).not.toBe("Not picked");
    }
  });

  it.each([
    ["screenshot", "Screenshot"],
    ["blurry", "Blurry"],
    ["duplicate", "Duplicate"],
    ["document", "Document"],
    ["poor_quality", "Poor quality"],
    ["irrelevant", "Not relevant"],
    ["user_removed", "Removed by you"],
  ])("%s → %s", (reason, label) => {
    expect(reasonLabel(reason)).toBe(label);
  });

  it("falls back for unknown / missing reasons", () => {
    expect(reasonLabel(null)).toBe("Not picked");
    expect(reasonLabel(undefined)).toBe("Not picked");
    expect(reasonLabel("")).toBe("Not picked");
    expect(reasonLabel("something_new")).toBe("Not picked");
    expect(reasonLabel("__proto__")).toBe("Not picked");
  });

  it("mirrors the db user_removed constant", () => {
    expect(USER_REMOVED_REASON).toBe("user_removed");
  });
});

describe("header copy", () => {
  it("says AI kept when the AI picked", () => {
    expect(headerCopy({ aiUsed: true, kept: 64, total: 200 })).toBe("AI kept 64 of 200");
  });
  it("says 'in your book' for rule albums (plain words, M13)", () => {
    expect(headerCopy({ aiUsed: false, kept: 3, total: 5 })).toBe("3 of 5 in your book");
  });
  it("aiPicked only for done / partial", () => {
    expect(aiPicked("done")).toBe(true);
    expect(aiPicked("partial")).toBe(true);
    for (const s of ["idle", "failed", "analyzing", null, undefined]) expect(aiPicked(s)).toBe(false);
  });
});

describe("reviewBanner", () => {
  it("active run wins", () => {
    expect(reviewBanner({ activeRun: true, aiAvailable: false, aiStatus: "partial" })).toBe("building");
  });
  it("AI off and not AI-picked → ai_off", () => {
    expect(reviewBanner({ activeRun: false, aiAvailable: false, aiStatus: "idle" })).toBe("ai_off");
    expect(reviewBanner({ activeRun: false, aiAvailable: false, aiStatus: "failed" })).toBe("ai_off");
  });
  it("AI off but an older AI album → no ai_off banner", () => {
    expect(reviewBanner({ activeRun: false, aiAvailable: false, aiStatus: "done" })).toBeNull();
  });
  it("partial / failed", () => {
    expect(reviewBanner({ activeRun: false, aiAvailable: true, aiStatus: "partial" })).toBe("partial");
    expect(reviewBanner({ activeRun: false, aiAvailable: true, aiStatus: "failed" })).toBe("failed");
  });
  it("AI done → none", () => {
    expect(reviewBanner({ activeRun: false, aiAvailable: true, aiStatus: "done" })).toBeNull();
    expect(reviewBanner({ activeRun: false, aiAvailable: true, aiStatus: "idle" })).toBeNull();
  });
  it("partial with the AI album: captions missing → captions_missing (no 'simple rules' claim)", () => {
    const base = { activeRun: false, aiAvailable: true, aiStatus: "partial" } as const;
    expect(reviewBanner({ ...base, generator: "ai", missingCaptions: 3 })).toBe("captions_missing");
    expect(BANNER_COPY.captions_missing).not.toMatch(/simple rules|Try AI again/);
    expect(BANNER_COPY.captions_missing).toMatch(/^Your album is ready\. Some pages don't have captions yet/);
  });
  it("partial with the AI album and every caption present (Critic-only failure) → no banner", () => {
    const base = { activeRun: false, aiAvailable: true, aiStatus: "partial" } as const;
    expect(reviewBanner({ ...base, generator: "ai", missingCaptions: 0 })).toBeNull();
    expect(reviewBanner({ ...base, generator: "ai" })).toBeNull();
  });
  it("partial with the rule fallback (or unknown album) keeps the 'simple rules' banner", () => {
    const base = { activeRun: false, aiAvailable: true, aiStatus: "partial" } as const;
    expect(reviewBanner({ ...base, generator: "rule", missingCaptions: 0 })).toBe("partial");
    expect(reviewBanner({ ...base, generator: "rule", missingCaptions: 4 })).toBe("partial");
    expect(reviewBanner({ ...base, generator: "none", missingCaptions: 0 })).toBe("partial");
    expect(reviewBanner({ ...base, generator: null })).toBe("partial");
  });
  it("failed / building / ai_off ignore the album origin", () => {
    expect(reviewBanner({ activeRun: false, aiAvailable: true, aiStatus: "failed", generator: "ai", missingCaptions: 0 })).toBe("failed");
    expect(reviewBanner({ activeRun: true, aiAvailable: true, aiStatus: "partial", generator: "ai", missingCaptions: 2 })).toBe("building");
    expect(reviewBanner({ activeRun: false, aiAvailable: false, aiStatus: "idle", generator: "rule" })).toBe("ai_off");
  });
  it("copy matches the plan", () => {
    expect(BANNER_COPY.ai_off).toBe("AI isn't switched on yet — we picked these with simple rules.");
    expect(BANNER_COPY.partial).toBe("Some of this was done with simple rules. Try AI again?");
    expect(BANNER_COPY.building).toMatch(/still being built/);
  });
});

describe("rebuilds", () => {
  it("rebuildsLeft never goes negative", () => {
    expect(rebuildsLeft(2, 0)).toBe(2);
    expect(rebuildsLeft(2, 1)).toBe(1);
    expect(rebuildsLeft(2, 2)).toBe(0);
    expect(rebuildsLeft(2, 5)).toBe(0);
    expect(rebuildsLeft(10, 3)).toBe(7);
    expect(rebuildsLeft(Number.NaN, 0)).toBe(0);
  });
  it("labels", () => {
    expect(rebuildsLeftLabel(2)).toBe("2 AI redos left");
    expect(rebuildsLeftLabel(1)).toBe("1 AI redo left");
    expect(rebuildsLeftLabel(0)).toBe("No AI redos left");
  });
  it("variant + trigger", () => {
    expect(rebuildVariant({ aiAvailable: false, aiStatus: "done" })).toBe("ai_off");
    expect(rebuildVariant({ aiAvailable: true, aiStatus: "done" })).toBe("rebuild");
    expect(rebuildVariant({ aiAvailable: true, aiStatus: "partial" })).toBe("retry_ai");
    expect(rebuildVariant({ aiAvailable: true, aiStatus: "failed" })).toBe("retry_ai");
    expect(rebuildVariant({ aiAvailable: true, aiStatus: "idle" })).toBe("first_ai");
    expect(rebuildTrigger("first_ai")).toBe("build");
    expect(rebuildTrigger("rebuild")).toBe("rebuild");
    expect(rebuildTrigger("retry_ai")).toBe("rebuild");
    expect(rebuildTrigger("ai_off")).toBe("rebuild");
  });
});

describe("rebuildOutcome (T11 shapes)", () => {
  it("201 live/replay → build page", () => {
    expect(rebuildOutcome(201, { runId: "r1", mode: "live", state: "queued" })).toEqual({ kind: "go_build", runId: "r1" });
    expect(rebuildOutcome(201, { runId: "r1", mode: "replay", state: "queued" })).toEqual({ kind: "go_build", runId: "r1" });
  });
  it("201 rule → refresh, or error when the rule run failed", () => {
    expect(rebuildOutcome(201, { runId: "r1", mode: "rule", state: "done" })).toEqual({ kind: "refreshed" });
    expect(rebuildOutcome(201, { runId: "r1", mode: "rule", state: "failed" })).toEqual({
      kind: "error",
      message: REBUILD_MESSAGES.ruleFailed,
    });
  });
  it("409s", () => {
    expect(rebuildOutcome(409, { error: "already_running", runId: "r2" })).toEqual({ kind: "go_build", runId: "r2" });
    expect(rebuildOutcome(409, { error: "already_running", runId: null })).toEqual({ kind: "go_build", runId: null });
    expect(rebuildOutcome(409, { error: "user_edited" })).toEqual({ kind: "error", message: REBUILD_MESSAGES.userEdited });
  });
  it("429 limits", () => {
    expect(rebuildOutcome(429, { error: "limit", limit: "rebuilds" })).toEqual({ kind: "error", message: REBUILD_MESSAGES.limitRebuilds });
    expect(rebuildOutcome(429, { error: "limit", limit: "daily_builds" })).toEqual({ kind: "error", message: REBUILD_MESSAGES.limitDaily });
    expect(rebuildOutcome(429, { error: "limit", limit: "analysed_photos" })).toEqual({ kind: "error", message: REBUILD_MESSAGES.limitPhotos });
    expect(rebuildOutcome(429, { error: "limit", limit: "rate" })).toEqual({ kind: "error", message: REBUILD_MESSAGES.limitRate });
    // D-059: global daily AI budget used up → "try again later" (the rule album stays).
    expect(rebuildOutcome(429, { error: "limit", limit: "budget_exhausted" })).toEqual({ kind: "error", message: REBUILD_MESSAGES.aiBreak });
    expect(REBUILD_MESSAGES.aiBreak).toBe("AI is taking a break — try again later.");
  });
  it("other statuses and junk bodies", () => {
    expect(rebuildOutcome(401, null)).toEqual({ kind: "error", message: REBUILD_MESSAGES.signedOut });
    expect(rebuildOutcome(404, {})).toEqual({ kind: "error", message: REBUILD_MESSAGES.notFound });
    expect(rebuildOutcome(500, "oops")).toEqual({ kind: "error", message: REBUILD_MESSAGES.generic });
    expect(rebuildOutcome(403, undefined)).toEqual({ kind: "error", message: REBUILD_MESSAGES.generic });
  });
});

describe("requestRebuild", () => {
  it("POSTs { bookId, trigger } to /api/ai/runs", async () => {
    const f = vi.fn(async () => json({ runId: "r1", mode: "live", state: "queued" }, 201));
    await expect(requestRebuild(BOOK, "rebuild", f)).resolves.toEqual({ kind: "go_build", runId: "r1" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ bookId: BOOK, trigger: "rebuild" });
  });
  it("network error → offline message, never throws", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(requestRebuild(BOOK, "build", f)).resolves.toEqual({ kind: "error", message: REBUILD_MESSAGES.offline });
  });
  it("non-JSON body still maps by status", async () => {
    const f = vi.fn(async () => new Response("<html>", { status: 502 }));
    await expect(requestRebuild(BOOK, "rebuild", f)).resolves.toEqual({ kind: "error", message: REBUILD_MESSAGES.generic });
  });
});

describe("grid helpers", () => {
  const photos = [photo("a"), photo("b", { status: "dropped", dropReason: "blurry" }), photo("c")];

  it("countKept", () => {
    expect(countKept(photos)).toBe(2);
    expect(countKept([])).toBe(0);
  });

  it("visiblePhotos filters by tab and keeps pinned tiles in place", () => {
    expect(visiblePhotos(photos, "kept", new Set()).map((p) => p.id)).toEqual(["a", "c"]);
    expect(visiblePhotos(photos, "dropped", new Set()).map((p) => p.id)).toEqual(["b"]);
    const toggled = photos.map((p) => (p.id === "a" ? applyUserChoice(p, false) : p));
    expect(visiblePhotos(toggled, "kept", new Set(["a"])).map((p) => p.id)).toEqual(["a", "c"]);
    expect(visiblePhotos(toggled, "kept", new Set()).map((p) => p.id)).toEqual(["c"]);
  });

  it("applyUserChoice mirrors setUserOverride", () => {
    expect(applyUserChoice(photo("a"), false)).toMatchObject({ status: "dropped", dropReason: "user_removed", userOverride: true });
    expect(applyUserChoice(photos[1], true)).toMatchObject({ status: "kept", dropReason: null, userOverride: true });
  });

  it("thumbSize scales to 512 on the long side", () => {
    expect(thumbSize({ width: 4000, height: 3000 })).toEqual({ width: 512, height: 384 });
    expect(thumbSize({ width: 1080, height: 1920 })).toEqual({ width: 288, height: 512 });
    expect(thumbSize({ width: null, height: null })).toEqual({ width: 512, height: 512 });
  });
});

describe("album sync (D-028)", () => {
  const A = "a1";
  const B = "b2";
  const C = "c3";
  const D = "d4";
  const doc = (pageIds: (string | null)[][], cover: string | null = null) => ({
    version: 1,
    cover: { layout: "cover-full", photoId: cover, title: "T" },
    pages: pageIds.map((ids, i) => ({
      id: `p${i}`,
      layout: "x",
      slots: ids.map((photoId) => ({ photoId, crop: { x: 0, y: 0, zoom: 1 } })),
    })),
  });

  it("docPhotoIds reads page slots + cover, skips nulls and garbage", () => {
    expect(docPhotoIds(doc([[A, null], [B]], C)).sort()).toEqual([A, B, C]);
    expect(docPhotoIds(doc([[A], [A]], A))).toEqual([A]);
    expect(docPhotoIds({})).toEqual([]);
    expect(docPhotoIds(null)).toEqual([]);
    expect(docPhotoIds([])).toEqual([]);
    expect(docPhotoIds({ pages: "x", cover: 3 })).toEqual([]);
    expect(docPhotoIds({ pages: [null, { slots: [null, { photoId: 7 }, { photoId: "" }, { photoId: D }] }] })).toEqual([D]);
  });

  const opts = { hasAlbum: true, userEdited: false, building: false };

  it("dropped photo still in the album is unsynced; dropped photo outside it is not", () => {
    const photos = [
      photo(A, { status: "dropped", dropReason: USER_REMOVED_REASON, userOverride: true }),
      photo(B, { status: "dropped", dropReason: "blurry" }),
    ];
    expect(unsyncedPhotoIds(photos, new Set([A]), opts)).toEqual([A]);
  });

  it("user-kept photo missing from the album is unsynced; AI-kept missing photo is not", () => {
    const photos = [photo(A, { userOverride: true }), photo(B), photo(C, { userOverride: true })];
    expect(unsyncedPhotoIds(photos, new Set([C]), opts)).toEqual([A]);
  });

  it("covers the cover photo too", () => {
    const photos = [photo(A, { status: "dropped", userOverride: true })];
    expect(docOutOfSync(doc([[B]], A), photos, { userEdited: false, building: false })).toBe(true);
  });

  it("nothing is out of sync with no album, a user-edited album, or while building", () => {
    const photos = [photo(A, { status: "dropped", userOverride: true })];
    const ids = new Set([A]);
    expect(unsyncedPhotoIds(photos, ids, { ...opts, hasAlbum: false })).toEqual([]);
    expect(unsyncedPhotoIds(photos, ids, { ...opts, userEdited: true })).toEqual([]);
    expect(unsyncedPhotoIds(photos, ids, { ...opts, building: true })).toEqual([]);
    expect(docOutOfSync({}, [photo(A, { userOverride: true })], { userEdited: false, building: false })).toBe(false);
    expect(docOutOfSync(doc([[A]]), photos, { userEdited: true, building: false })).toBe(false);
  });

  it("in sync album → false", () => {
    const photos = [photo(A, { userOverride: true }), photo(B), photo(C, { status: "dropped" })];
    expect(docOutOfSync(doc([[A, B]]), photos, { userEdited: false, building: false })).toBe(false);
  });

  it("toggling a photo flips it in and out of sync", () => {
    const inAlbum = photo(A);
    const ids = new Set([A]);
    const dropped = applyUserChoice(inAlbum, false);
    expect(unsyncedPhotoIds([dropped], ids, opts)).toEqual([A]);
    expect(unsyncedPhotoIds([applyUserChoice(dropped, true)], ids, opts)).toEqual([]);
  });

  it("changed copy", () => {
    expect(changedPhotosCopy(1)).toBe("You changed 1 photo.");
    expect(changedPhotosCopy(3)).toBe("You changed 3 photos.");
    expect(CONTINUE_UNSYNCED_NOTE).toBe("Your changes aren't in the book yet — tap Apply photo changes.");
  });
});

describe("updateAlbumOutcome", () => {
  it("success → toast", () => {
    expect(updateAlbumOutcome(BOOK, { ok: true, changed: true, pages: 12 })).toEqual({ kind: "updated", toast: "Album updated" });
    expect(updateAlbumOutcome(BOOK, { ok: true, changed: false, pages: 12 })).toEqual({
      kind: "updated",
      toast: "Already up to date",
    });
  });

  it("user_edited / busy / signed_out / not_found / failed", () => {
    expect(updateAlbumOutcome(BOOK, { ok: false, error: "user_edited" })).toEqual({
      kind: "error",
      error: "user_edited",
      message: "You've edited this album, so we won't change it.",
      link: null,
    });
    expect(updateAlbumOutcome(BOOK, { ok: false, error: "busy" })).toEqual({
      kind: "error",
      error: "busy",
      message: "Your album is still being built — try again in a moment.",
      link: { href: `/books/${BOOK}/build`, label: "See progress" },
    });
    const signedOut = updateAlbumOutcome(BOOK, { ok: false, error: "signed_out" });
    expect(signedOut).toMatchObject({ kind: "error", error: "signed_out", message: UPDATE_ALBUM_MESSAGES.signedOut });
    expect(signedOut.kind === "error" && signedOut.link?.href).toBe(
      `/login?next=${encodeURIComponent(`/books/${BOOK}/review`)}`,
    );
    expect(updateAlbumOutcome(BOOK, { ok: false, error: "not_found" })).toMatchObject({
      error: "not_found",
      message: UPDATE_ALBUM_MESSAGES.notFound,
      link: null,
    });
    expect(updateAlbumOutcome(BOOK, { ok: false, error: "failed" })).toMatchObject({
      error: "failed",
      message: UPDATE_ALBUM_MESSAGES.generic,
    });
  });

  it("thrown call / unknown error → generic", () => {
    expect(updateAlbumOutcome(BOOK, null)).toMatchObject({ kind: "error", error: "failed", message: UPDATE_ALBUM_MESSAGES.generic });
    expect(
      updateAlbumOutcome(BOOK, { ok: false, error: "weird" } as unknown as Parameters<typeof updateAlbumOutcome>[1]),
    ).toMatchObject({ error: "failed", message: UPDATE_ALBUM_MESSAGES.generic });
  });
});

describe("rebuild as secondary (D-028)", () => {
  it("labels + rebuilds-left copy", () => {
    expect(REBUILD_LABELS.rebuild).toBe("Redo with AI");
    expect(REBUILD_LABELS.ai_off).toBe("Rebuild album");
    expect(rebuildsLeftCopy(null)).toBeNull();
    expect(rebuildsLeftCopy(1)).toBe("1 AI redo left");
    expect(rebuildsLeftCopy(3)).toBe("3 AI redos left");
    expect(rebuildsLeftCopy(-1)).toBe("0 AI redos left");
  });
});

describe("captions preview (M4 T12)", () => {
  const hasArea = (id: string) => !!getLayout(id)?.caption;
  const cap = (text: string, source = "ai") => ({ text, font: "Cairo", align: "center", source });
  const doc = {
    version: 1,
    chapters: [
      { id: "c1", title: "Morning at the beach", dateLabel: "12 Mar 2026", place: "Saadiyat" },
      { id: "c2", title: "Dinner", dateLabel: "13 Mar 2026", place: null },
    ],
    cover: { layout: "cover", photoId: "p0", title: "Trip", subtitle: "" },
    pages: [
      { id: "a", chapterId: "c1", layout: "one-portrait", slots: [{ photoId: "p1" }], caption: cap("Waves at sunrise") },
      { id: "b", chapterId: "c1", layout: "full-page", slots: [{ photoId: "p2" }], caption: null },
      { id: "c", chapterId: "c1", layout: "two-vertical", slots: [{ photoId: "p3" }], caption: null },
      { id: "d", chapterId: "c2", layout: "four-grid", slots: [{ photoId: "p4" }], caption: cap("عشاء مع العائلة", "user") },
      { id: "e", chapterId: null, layout: "three-mixed", slots: [], caption: cap("Loose page") },
    ],
  };

  it("projects only titles, dates, caption text/source and captionable — no photo ids", () => {
    const pv = captionsPreviewOf(doc, hasArea);
    expect(pv).toEqual({
      chapters: [
        { title: "Morning at the beach", dateLabel: "12 Mar 2026" },
        { title: "Dinner", dateLabel: "13 Mar 2026" },
      ],
      pages: [
        { chapter: 0, caption: { text: "Waves at sunrise", source: "ai" }, captionable: true },
        { chapter: 0, caption: null, captionable: false },
        { chapter: 0, caption: null, captionable: true },
        { chapter: 1, caption: { text: "عشاء مع العائلة", source: "user" }, captionable: true },
        { chapter: null, caption: { text: "Loose page", source: "ai" }, captionable: true },
      ],
    });
    const json = JSON.stringify(pv);
    expect(json).not.toMatch(/p[0-4]"|photoId|Saadiyat|Cairo|font|align/);
  });

  it("garbage docs → empty projection, never throws", () => {
    for (const bad of [null, undefined, {}, [], "x", 3, { pages: "no", chapters: {} }, { pages: [null, 1, "x"] }]) {
      expect(captionsPreviewOf(bad, hasArea)).toEqual({ chapters: [], pages: [] });
    }
    const odd = captionsPreviewOf(
      {
        chapters: [{ id: "c1", title: 3, dateLabel: null }, { id: "c1", title: "dup" }, "x"],
        pages: [
          { chapterId: "c1", layout: "one-portrait", caption: { text: "   ", source: "ai" } },
          { chapterId: "zz", layout: "nope", caption: { text: "hi", source: "evil" } },
          { chapterId: "c1", layout: 5, caption: "text" },
        ],
      },
      hasArea,
    );
    expect(odd).toEqual({
      chapters: [{ title: "", dateLabel: "" }],
      pages: [
        { chapter: 0, caption: null, captionable: true },
        { chapter: null, caption: { text: "hi", source: "ai" }, captionable: false },
        { chapter: 0, caption: null, captionable: false },
      ],
    });
  });

  it("groups by consecutive chapter in page order and counts missing captions", () => {
    const m = captionsPreviewModel(captionsPreviewOf(doc, hasArea));
    expect(m).toEqual({
      count: 3,
      missing: 1,
      groups: [
        { title: "Morning at the beach", dateLabel: "12 Mar 2026", items: [{ text: "Waves at sunrise", source: "ai" }] },
        { title: "Dinner", dateLabel: "13 Mar 2026", items: [{ text: "عشاء مع العائلة", source: "user" }] },
        { title: null, dateLabel: null, items: [{ text: "Loose page", source: "ai" }] },
      ],
    });
  });

  it("a chapter split by another chapter's pages becomes two groups (page order wins)", () => {
    const m = captionsPreviewModel({
      chapters: [{ title: "A", dateLabel: "" }, { title: "B", dateLabel: "" }],
      pages: [
        { chapter: 0, caption: { text: "1", source: "ai" }, captionable: true },
        { chapter: 1, caption: { text: "2", source: "ai" }, captionable: true },
        { chapter: 0, caption: { text: "3", source: "ai" }, captionable: true },
      ],
    });
    expect(m?.groups.map((g) => [g.title, g.dateLabel, g.items.length])).toEqual([
      ["A", null, 1],
      ["B", null, 1],
      ["A", null, 1],
    ]);
  });

  it("nothing to show → null; only missing captions → shown with count 0", () => {
    expect(captionsPreviewModel(null)).toBeNull();
    expect(captionsPreviewModel({ chapters: [], pages: [] })).toBeNull();
    expect(
      captionsPreviewModel({ chapters: [], pages: [{ chapter: null, caption: null, captionable: false }] }),
    ).toBeNull();
    expect(
      captionsPreviewModel({ chapters: [], pages: [{ chapter: null, caption: null, captionable: true }] }),
    ).toEqual({ count: 0, missing: 1, groups: [] });
  });

  it("copy", () => {
    expect(captionSourceLabel("ai")).toBe("Written by AI");
    expect(captionSourceLabel("user")).toBe("Your caption");
    expect(captionSourceLabel("auto")).toBe("Added automatically");
    expect(missingCaptionsCopy(1)).toBe("1 page has no caption yet");
    expect(missingCaptionsCopy(4)).toBe("4 pages have no caption yet");
  });

  it("partial banner note only when partial and captions are missing", () => {
    expect(partialCaptionsNote("partial", 2)).toBe(PARTIAL_CAPTIONS_NOTE);
    expect(PARTIAL_CAPTIONS_NOTE).toBe("Some pages may not have captions yet.");
    expect(partialCaptionsNote("partial", 0)).toBeNull();
    expect(partialCaptionsNote("failed", 2)).toBeNull();
    expect(partialCaptionsNote("building", 2)).toBeNull();
    expect(partialCaptionsNote(null, 2)).toBeNull();
    expect(partialCaptionsNote("captions_missing", 2)).toBeNull();
  });
});

describe("caption script detection", () => {
  it("isMainlyArabic", () => {
    expect(isMainlyArabic("يوم جميل على الشاطئ")).toBe(true);
    expect(isMainlyArabic("عيد مبارك 2026!")).toBe(true);
    expect(isMainlyArabic("A day at the beach")).toBe(false);
    expect(isMainlyArabic("Café crème")).toBe(false);
    expect(isMainlyArabic("Beach day with جدة")).toBe(false);
    expect(isMainlyArabic("يوم في Dubai Mall مع العائلة")).toBe(true);
    expect(isMainlyArabic("١٢٣ ، ؟")).toBe(false);
    expect(isMainlyArabic("2026 🎉")).toBe(false);
    expect(isMainlyArabic("")).toBe(false);
  });
  it("captionTextAttrs: lang per caption, Cairo for ar books or Arabic text", () => {
    expect(captionTextAttrs("يوم جميل", "ar")).toEqual({ lang: "ar", arabicFont: true });
    expect(captionTextAttrs("Sunset walk", "ar")).toEqual({ lang: undefined, arabicFont: true });
    expect(captionTextAttrs("Sunset walk", "en")).toEqual({ lang: undefined, arabicFont: false });
    expect(captionTextAttrs("يوم جميل", "en")).toEqual({ lang: "ar", arabicFont: true });
  });
  it("CaptionsPreview keeps dir=auto and sets lang per caption", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/review/CaptionsPreview.tsx", "utf8");
    expect(src).toContain("captionTextAttrs(");
    expect(src).not.toMatch(/lang=\{ar \?/);
    expect((src.match(/dir="auto"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

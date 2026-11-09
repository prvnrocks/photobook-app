import { describe, expect, it, vi } from "vitest";
import { DROP_REASONS } from "@/lib/ai/schemas";
import {
  aiPicked,
  applyUserChoice,
  BANNER_COPY,
  changedPhotosCopy,
  CONTINUE_UNSYNCED_NOTE,
  countKept,
  docOutOfSync,
  docPhotoIds,
  headerCopy,
  reasonLabel,
  REBUILD_LABELS,
  REBUILD_MESSAGES,
  rebuildHint,
  rebuildOutcome,
  rebuildsLeft,
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
  it("says Kept for rule albums", () => {
    expect(headerCopy({ aiUsed: false, kept: 3, total: 5 })).toBe("Kept 3 of 5");
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
    expect(rebuildsLeftLabel(2)).toBe("2 rebuilds left");
    expect(rebuildsLeftLabel(1)).toBe("1 rebuild left");
    expect(rebuildsLeftLabel(0)).toBe("No rebuilds left");
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
    expect(CONTINUE_UNSYNCED_NOTE).toBe("Your changes aren't in the album yet — tap Update album.");
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
  it("labels + hint", () => {
    expect(REBUILD_LABELS.rebuild).toBe("Rebuild with AI");
    expect(REBUILD_LABELS.ai_off).toBe("Rebuild album");
    expect(rebuildHint(2)).toBe("Re-plans the whole story with AI (2 left)");
    expect(rebuildHint(null)).toBe("Re-plans the whole story with AI.");
  });
});

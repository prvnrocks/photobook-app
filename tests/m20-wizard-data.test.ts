import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildRuleDraft, type DraftPhotoRow } from "@/lib/book/rule-draft";
import { resolveWizardStep, type WizardGateInput } from "@/lib/books/wizard-gate";

vi.mock("server-only", () => ({}));

// M20 T1 (D-072): resolveWizardStep (G2 + G3), loadWizardStep (steps 5–7) and
// GET /api/books/[id]/wizard.

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const mocks = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
  aiMode: "replay" as "off" | "replay" | "live",
  getMyBook: vi.fn(),
  getBookForRun: vi.fn(),
  getActiveRunForBook: vi.fn(),
  hasAnyRunForBook: vi.fn(),
  countLiveRebuilds: vi.fn(),
  listUploadState: vi.fn(),
  listReviewPhotos: vi.fn(),
  touchWarnedDraft: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/ai/client", () => ({ resolveAiMode: () => mocks.aiMode }));
vi.mock("@/lib/db/books", () => ({ getMyBook: mocks.getMyBook, getBookForRun: mocks.getBookForRun }));
vi.mock("@/lib/db/agent-runs", () => ({
  getActiveRunForBook: mocks.getActiveRunForBook,
  hasAnyRunForBook: mocks.hasAnyRunForBook,
  countLiveRebuilds: mocks.countLiveRebuilds,
}));
vi.mock("@/lib/db/photos", () => ({
  listUploadState: mocks.listUploadState,
  listReviewPhotos: mocks.listReviewPhotos,
}));
vi.mock("@/lib/db/draft-activity", () => ({ touchWarnedDraft: mocks.touchWarnedDraft }));

const { loadWizardStep, parseWizardDataStep } = await import("@/lib/books/wizard-data");
const route = await import("@/app/api/books/[id]/wizard/route");
const wizardRoutes = await import("@/lib/books/wizard-routes");

// --- fixtures ------------------------------------------------------------------------------------

const PHOTOS: DraftPhotoRow[] = Array.from({ length: 8 }, (_, i) => ({
  id: pid(i + 1),
  width: 1200,
  height: 1600,
  taken_at: `2026-10-12T${String(8 + i).padStart(2, "0")}:00:00+04:00`,
  date_source: "exif",
  place: null,
  blur_score: 100,
  status: "kept",
  dup_group: null,
  color: "#a0b0c0",
}));

function ruleDraft() {
  const r = buildRuleDraft(PHOTOS, { occasion: "other", title: "Eid", captionLang: "en", isPaid: false, design: { format: "A5_PORTRAIT", designStyle: "modern" } });
  if (!r.ok) throw new Error("fixture draft failed");
  return JSON.parse(JSON.stringify(r.doc)) as Record<string, unknown> & { meta: Record<string, unknown>; cover: Record<string, unknown> };
}

function book(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    title: "Eid 2026",
    occasion: "family",
    tone: "warm",
    caption_lang: "en",
    is_paid: false,
    max_pages: 20,
    page_count: 0,
    doc: {},
    updated_at: "2026-11-15T10:00:00.000Z",
    doc_rev: 0,
    format: "A5_PORTRAIT",
    design_style: "modern",
    ...overrides,
  };
}

/** listReviewPhotos rows as the DB helper returns them (incl. AI fields the tiles must drop). */
function reviewRow(n: number, status = "kept") {
  return {
    id: pid(n),
    status,
    dropReason: status === "dropped" ? "blurry" : null,
    userOverride: false,
    dupGroup: null,
    quality: 0.8,
    scene: "SECRET scene text",
    coverWorthy: true,
    width: 1200,
    height: 1600,
    takenAt: "2026-10-12T08:00:00+04:00",
    thumbUrl: `https://signed.test/${n}`,
  };
}

const run = (trigger: "build" | "rebuild" = "build") => ({
  id: RUN_ID,
  book_id: BOOK_ID,
  state: "queued",
  ai_status: null,
  progress: null,
  error_code: null,
  mode: "replay",
  trigger,
  started_at: "2026-11-15T10:00:00Z",
  finished_at: null,
});

const timeout = () => Object.assign(new Error("timeout"), { code: "SUPABASE_TIMEOUT" });

let errors: string[];
beforeEach(() => {
  mocks.user = { id: OWNER };
  mocks.aiMode = "replay";
  mocks.getMyBook.mockReset().mockResolvedValue(book());
  mocks.getBookForRun.mockReset().mockResolvedValue({ ai_status: "done" });
  mocks.getActiveRunForBook.mockReset().mockResolvedValue(null);
  mocks.hasAnyRunForBook.mockReset().mockResolvedValue(false);
  mocks.countLiveRebuilds.mockReset().mockResolvedValue(1);
  mocks.listUploadState.mockReset().mockResolvedValue([]);
  mocks.listReviewPhotos.mockReset().mockImplementation(async (_b: string, ids?: readonly string[]) => {
    const all = [reviewRow(1), reviewRow(2), reviewRow(3, "dropped")];
    return ids ? ids.map((id, i) => ({ ...reviewRow(i + 1), id })) : all;
  });
  mocks.touchWarnedDraft.mockReset().mockResolvedValue("noop");
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

// --- resolveWizardStep -------------------------------------------------------------------------

const FRESH: WizardGateInput = {
  requested: 5,
  hasRun: false,
  active: false,
  readError: false,
  detailsLock: null,
  docOrigin: { generator: "none", userEdited: false },
};
const g = (patch: Partial<WizardGateInput>) => resolveWizardStep({ ...FRESH, ...patch });

describe("resolveWizardStep (G2 + G3)", () => {
  it("is re-exported from wizard-routes (server callers)", () => {
    expect(wizardRoutes.resolveWizardStep).toBe(resolveWizardStep);
  });

  it("no run: requested 1..5 allowed (empty doc or untouched rule draft)", () => {
    for (const requested of [1, 2, 3, 4, 5]) {
      expect(g({ requested })).toBe(requested);
      expect(g({ requested, docOrigin: { generator: "rule", userEdited: false } })).toBe(requested);
    }
  });

  it("no run: requested 6 or 7 → 6 (may start the first build via the existing path)", () => {
    expect(g({ requested: 6 })).toBe(6);
    expect(g({ requested: 7 })).toBe(6);
    expect(g({ requested: 7, docOrigin: { generator: "rule", userEdited: false } })).toBe(6);
  });

  it("no run + AI off: requested ≥6 → classic build screen; ≤5 unchanged", () => {
    expect(g({ requested: 6, aiOn: false })).toBe("classic");
    expect(g({ requested: 7, aiOn: false })).toBe("classic");
    expect(g({ requested: 3, aiOn: false })).toBe(3);
  });

  it("active run → 6 for every requested step (resume; never a 2nd run)", () => {
    for (const requested of [1, 2, 3, 4, 5, 6, 7]) {
      expect(g({ requested, hasRun: true, active: true, detailsLock: "ai_started" })).toBe(6);
      expect(g({ requested, hasRun: true, active: true, activeTrigger: "build", detailsLock: "ai_started" })).toBe(6);
    }
  });

  it("active rebuild or AI off → classic build screen", () => {
    expect(g({ requested: 6, hasRun: true, active: true, activeTrigger: "rebuild", detailsLock: "ai_started" })).toBe("classic");
    expect(g({ requested: 6, hasRun: true, active: true, aiOn: false, detailsLock: "ai_started" })).toBe("classic");
  });

  it("finished run, not user-edited → 7 for every requested step", () => {
    for (const requested of [1, 2, 3, 4, 5, 6, 7]) {
      expect(g({ requested, hasRun: true, detailsLock: "ai_started", docOrigin: { generator: "ai", userEdited: false } })).toBe(7);
      // rule fallback album after a finished run
      expect(g({ requested, hasRun: true, detailsLock: "ai_started", docOrigin: { generator: "rule", userEdited: false } })).toBe(7);
    }
  });

  it("user-edited album → editor (even with a run active or finished, any step)", () => {
    for (const requested of [1, 5, 6, 7]) {
      expect(g({ requested, docOrigin: { generator: "rule", userEdited: true }, detailsLock: "user_edited" })).toBe("editor");
      expect(g({ requested, hasRun: true, docOrigin: { generator: "ai", userEdited: true }, detailsLock: "ai_started" })).toBe("editor");
      expect(g({ requested, hasRun: true, active: true, docOrigin: { generator: "ai", userEdited: true }, detailsLock: "ai_started" })).toBe("editor");
    }
    // detailsLock "user_edited" alone is enough
    expect(g({ requested: 3, detailsLock: "user_edited" })).toBe("editor");
  });

  it("details locked (AI album, run row gone) + requested ≤5 → 7", () => {
    for (const requested of [1, 2, 3, 4, 5, 6, 7]) {
      expect(g({ requested, detailsLock: "ai_started", docOrigin: { generator: "ai", userEdited: false } })).toBe(7);
    }
  });

  it("read error: ≤5 with details unlocked → requested (upload page: unknown = no run); otherwise 6", () => {
    expect(g({ requested: 2, readError: true })).toBe(2);
    expect(g({ requested: 5, readError: true })).toBe(5);
    expect(g({ requested: 6, readError: true })).toBe(6);
    expect(g({ requested: 7, readError: true })).toBe(6);
    expect(g({ requested: 4, readError: true, detailsLock: "ai_started" })).toBe(6);
    expect(g({ requested: 7, readError: true, aiOn: false })).toBe("classic");
    // a known active run still wins over a partial read error
    expect(g({ requested: 2, readError: true, active: true, hasRun: true })).toBe(6);
  });

  it("clamps out-of-range / non-finite requests", () => {
    expect(g({ requested: 0 })).toBe(1);
    expect(g({ requested: -3 })).toBe(1);
    expect(g({ requested: Number.NaN })).toBe(1);
    expect(g({ requested: 4.7 })).toBe(4);
    expect(g({ requested: 99 })).toBe(6);
  });

  it("wizard-gate is dependency-free (safe for first-load client islands, G5)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/books/wizard-gate.ts", "utf8");
    expect(src).not.toMatch(/^import /m);
  });
});

// --- parseWizardDataStep -----------------------------------------------------------------------

describe("parseWizardDataStep", () => {
  it("accepts exactly 5 / 6 / 7", () => {
    expect(parseWizardDataStep("5")).toBe(5);
    expect(parseWizardDataStep("6")).toBe(6);
    expect(parseWizardDataStep("7")).toBe(7);
    for (const raw of [null, undefined, "", "4", "8", "05", "5.0", " 5", "abc", "1"]) {
      expect(parseWizardDataStep(raw)).toBeNull();
    }
  });
});

// --- loadWizardStep ----------------------------------------------------------------------------

const BASE_KEYS = ["bookId", "title", "rawTitle", "occasion", "format", "designStyle", "captionLang", "isPaid", "aiOn", "resolved", "step"];

describe("loadWizardStep — step 5 (upload page parity)", () => {
  it("fresh book: Uploader props + base fields, resolved 5", async () => {
    mocks.listUploadState.mockResolvedValue([
      { id: pid(1), fingerprint: "a", upload_state: "ready" },
      { id: pid(2), fingerprint: "b", upload_state: "pending" },
      { id: pid(3), fingerprint: "c", upload_state: "weird" },
    ]);
    const d = await loadWizardStep(BOOK_ID, 5);
    expect(d).toEqual({
      bookId: BOOK_ID,
      title: "Eid 2026",
      rawTitle: "Eid 2026",
      occasion: "family",
      format: "A5_PORTRAIT",
      designStyle: "modern",
      captionLang: "en",
      isPaid: false,
      aiOn: true,
      resolved: 5,
      step: 5,
      userId: OWNER,
      existing: [
        { id: pid(1), fingerprint: "a", upload_state: "ready" },
        { id: pid(2), fingerprint: "b", upload_state: "pending" },
        { id: pid(3), fingerprint: "c", upload_state: "pending" },
      ],
      maxUpload: 150,
      readyCount: 1,
      pendingCount: 2,
      hasDoc: false,
      firstRun: "none",
      dailyCap: expect.any(Number),
    });
    expect(mocks.touchWarnedDraft).not.toHaveBeenCalled();
  });

  it("firstRun active / done; resolved follows the gate", async () => {
    mocks.getActiveRunForBook.mockResolvedValue(run());
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    expect(await loadWizardStep(BOOK_ID, 5)).toMatchObject({ firstRun: "active", resolved: 6 });
    mocks.getActiveRunForBook.mockResolvedValue(null);
    expect(await loadWizardStep(BOOK_ID, 5)).toMatchObject({ firstRun: "done", resolved: 7 });
  });

  it("run read errors count as 'no run' for the Uploader (like the page), readError for the gate", async () => {
    mocks.hasAnyRunForBook.mockRejectedValue(new Error("x"));
    mocks.getActiveRunForBook.mockRejectedValue(new Error("x"));
    expect(await loadWizardStep(BOOK_ID, 5)).toMatchObject({ firstRun: "none", resolved: 5 });
  });

  it("paid book: paid limits; Arabic caption_lang passes through; AI off → aiOn false", async () => {
    mocks.aiMode = "off";
    mocks.getMyBook.mockResolvedValue(book({ is_paid: true, caption_lang: "ar", doc: ruleDraft() }));
    const d = await loadWizardStep(BOOK_ID, 5);
    expect(d).toMatchObject({ isPaid: true, maxUpload: 500, captionLang: "ar", aiOn: false, hasDoc: true });
  });

  it("user-edited album → resolved editor", async () => {
    const doc = ruleDraft();
    doc.meta.userEdited = true;
    mocks.getMyBook.mockResolvedValue(book({ doc }));
    expect(await loadWizardStep(BOOK_ID, 5)).toMatchObject({ resolved: "editor" });
  });

  it("signed out / not the owner / id mismatch → null", async () => {
    mocks.user = null;
    expect(await loadWizardStep(BOOK_ID, 5)).toBeNull();
    mocks.user = { id: OWNER };
    mocks.getMyBook.mockResolvedValue(null);
    expect(await loadWizardStep(BOOK_ID, 5)).toBeNull();
    expect(await loadWizardStep(pid(9), 5, { user: { id: OWNER }, book: book() as never })).toBeNull();
  });
});

describe("loadWizardStep — step 6 (build page parity)", () => {
  it("active run: activeRunId, no read error, resolved 6, fan from the draft", async () => {
    mocks.getActiveRunForBook.mockResolvedValue(run());
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft() }));
    const d = await loadWizardStep(BOOK_ID, 6, { auto: true });
    expect(Object.keys(d!).sort()).toEqual([...BASE_KEYS, "activeRunId", "readError", "trigger", "dailyCap", "auto", "fanUrls"].sort());
    expect(d).toMatchObject({ step: 6, activeRunId: RUN_ID, readError: false, trigger: "build", auto: true, resolved: 6 });
    expect((d as { fanUrls: string[] }).fanUrls).toHaveLength(6);
    // Only the draft's first photos are loaded + signed (FAN_PHOTOS = 6 at most).
    const ids = mocks.listReviewPhotos.mock.calls[0][1] as string[];
    expect(ids.length).toBeLessThanOrEqual(6);
  });

  it("read error kept distinct from 'no run'", async () => {
    mocks.getActiveRunForBook.mockRejectedValue(timeout());
    const d = await loadWizardStep(BOOK_ID, 6);
    expect(d).toMatchObject({ activeRunId: null, readError: true, resolved: 6, auto: false });
  });

  it("no run: activeRunId null, readError false, resolved 6; empty doc → no fan and no photo read", async () => {
    const d = await loadWizardStep(BOOK_ID, 6);
    expect(d).toMatchObject({ activeRunId: null, readError: false, resolved: 6, fanUrls: [] });
    expect(mocks.listReviewPhotos).not.toHaveBeenCalled();
  });

  it("finished run → resolved 7 (never start a 2nd run); a fan read error only drops the fan", async () => {
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    mocks.getMyBook.mockResolvedValue(book({ doc: ruleDraft() }));
    mocks.listReviewPhotos.mockRejectedValue(new Error("x"));
    expect(await loadWizardStep(BOOK_ID, 6)).toMatchObject({ resolved: 7, fanUrls: [] });
  });
});

describe("loadWizardStep — step 7 (review page parity)", () => {
  it("tiles without AI fields or paths; counts, cover, album ids, captions preview, rebuild", async () => {
    const doc = ruleDraft();
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    mocks.getMyBook.mockResolvedValue(book({ doc }));
    const d = await loadWizardStep(BOOK_ID, 7);
    expect(Object.keys(d!).sort()).toEqual(
      [...BASE_KEYS, "photos", "albumPhotoIds", "aiUsed", "userEdited", "building", "rebuild", "captionsPreview", "banner", "captionsNote", "coverPhotoId", "counts"].sort(),
    );
    const s = d as Extract<typeof d, { step: 7 }>;
    expect(s.resolved).toBe(7);
    expect(s.photos[0]).toEqual({
      id: pid(1), status: "kept", dropReason: null, userOverride: false, dupGroup: null, width: 1200, height: 1600, thumbUrl: "https://signed.test/1",
    });
    expect(JSON.stringify(s)).not.toContain("SECRET");
    expect(JSON.stringify(s)).not.toMatch(/coverWorthy|quality|thumb_path|description/);
    expect(s.counts).toEqual({ kept: 2, total: 3 });
    expect(s.coverPhotoId).toBe((doc.cover as { photoId?: string }).photoId ?? null);
    expect(s.albumPhotoIds.length).toBeGreaterThan(0);
    expect(s.aiUsed).toBe(true);
    expect(s.userEdited).toBe(false);
    expect(s.building).toBe(false);
    expect(s.rebuild).toEqual({ variant: "rebuild", rebuildsLeft: null });
    expect(s.captionsPreview).toMatchObject({ chapters: expect.any(Array), pages: expect.any(Array) });
    expect(s.banner).toBeNull();
  });

  it("touches the warned-draft clock exactly once per load, after the ownership check", async () => {
    await loadWizardStep(BOOK_ID, 7);
    expect(mocks.touchWarnedDraft).toHaveBeenCalledTimes(1);
    expect(mocks.touchWarnedDraft).toHaveBeenCalledWith(BOOK_ID, OWNER);
    expect(mocks.getMyBook.mock.invocationCallOrder[0]).toBeLessThan(mocks.touchWarnedDraft.mock.invocationCallOrder[0]);
    mocks.getMyBook.mockResolvedValue(null);
    mocks.touchWarnedDraft.mockClear();
    expect(await loadWizardStep(BOOK_ID, 7)).toBeNull();
    expect(mocks.touchWarnedDraft).not.toHaveBeenCalled();
  });

  it("building: rebuild null, banner building, resolved 6", async () => {
    mocks.getActiveRunForBook.mockResolvedValue(run());
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    const d = await loadWizardStep(BOOK_ID, 7);
    expect(d).toMatchObject({ building: true, rebuild: null, banner: "building", resolved: 6 });
  });

  it("live mode counts rebuilds left; AI off → ai_off banner", async () => {
    mocks.aiMode = "live";
    mocks.hasAnyRunForBook.mockResolvedValue(true);
    expect(await loadWizardStep(BOOK_ID, 7)).toMatchObject({ rebuild: { variant: "rebuild", rebuildsLeft: 1 } });
    mocks.aiMode = "off";
    mocks.getBookForRun.mockResolvedValue({ ai_status: "idle" });
    expect(await loadWizardStep(BOOK_ID, 7)).toMatchObject({ aiOn: false, banner: "ai_off", aiUsed: false });
  });

  it("a run-exists read error doesn't bounce a loaded review to step 6", async () => {
    mocks.hasAnyRunForBook.mockRejectedValue(new Error("x"));
    expect(await loadWizardStep(BOOK_ID, 7)).toMatchObject({ resolved: 7 });
  });

  it("user-edited album: userEdited true, resolved editor", async () => {
    const doc = ruleDraft();
    doc.meta.userEdited = true;
    mocks.getMyBook.mockResolvedValue(book({ doc }));
    expect(await loadWizardStep(BOOK_ID, 7)).toMatchObject({ userEdited: true, resolved: "editor" });
  });

  it("review read errors throw (route → 503 / 500), like the review page", async () => {
    mocks.getActiveRunForBook.mockRejectedValue(timeout());
    await expect(loadWizardStep(BOOK_ID, 7)).rejects.toMatchObject({ code: "SUPABASE_TIMEOUT" });
  });
});

// --- GET /api/books/[id]/wizard ----------------------------------------------------------------

function req(query: string, id = BOOK_ID) {
  return new NextRequest(`http://localhost:3000/api/books/${id}/wizard${query}`, { method: "GET" });
}
const ctx = (id = BOOK_ID) => ({ params: Promise.resolve({ id }) });

describe("GET /api/books/[id]/wizard", () => {
  it("exports GET only (+ route fields), nodejs runtime", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "runtime"]);
  });

  it("401 signed out (before step validation or any book read)", async () => {
    mocks.user = null;
    const res = await route.GET(req("?step=nope"), ctx());
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("400 for a missing / bad step", async () => {
    for (const q of ["", "?step=4", "?step=8", "?step=five", "?step=5.0"]) {
      const res = await route.GET(req(q), ctx());
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: "invalid_step" });
    }
    expect(mocks.getMyBook).not.toHaveBeenCalled();
  });

  it("404 for a malformed id, a missing book and someone else's book", async () => {
    let res = await route.GET(req("?step=5", "x"), ctx("x"));
    expect(res.status).toBe(404);
    expect(mocks.getMyBook).not.toHaveBeenCalled();
    mocks.getMyBook.mockResolvedValue(null); // RLS hides other users' books
    res = await route.GET(req("?step=7"), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Book not found." });
    expect(mocks.touchWarnedDraft).not.toHaveBeenCalled();
  });

  it("200 JSON per step, no-store; book read once; auto passes through", async () => {
    for (const step of [5, 6, 7] as const) {
      mocks.getMyBook.mockClear();
      const res = await route.GET(req(`?step=${step}&auto=1`), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body).toMatchObject({ step, bookId: BOOK_ID });
      if (step === 6) expect(body.auto).toBe(true);
      expect(mocks.getMyBook).toHaveBeenCalledTimes(1);
    }
  });

  it("503 unavailable + Retry-After on a Supabase timeout (auth, book read, loader reads)", async () => {
    const cases: (() => void)[] = [
      () => mocks.getMyBook.mockRejectedValue(timeout()),
      () => mocks.listUploadState.mockRejectedValue(timeout()),
    ];
    for (const arrange of cases) {
      arrange();
      const res = await route.GET(req("?step=5"), ctx());
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("3");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "unavailable" });
      mocks.getMyBook.mockReset().mockResolvedValue(book());
    }
    mocks.getActiveRunForBook.mockRejectedValue(timeout());
    expect((await route.GET(req("?step=7"), ctx())).status).toBe(503);
  });

  it("500 server_error for other failures; logs carry codes only (no ids, no photo data)", async () => {
    mocks.listReviewPhotos.mockRejectedValue(Object.assign(new Error(`boom ${BOOK_ID} SECRET`), { code: "42P01" }));
    const res = await route.GET(req("?step=7"), ctx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "server_error", message: "Something went wrong. Please try again." });
    expect(errors.join("\n")).toContain("[wizard] failed (42P01)");
    expect(errors.join("\n")).not.toContain(BOOK_ID);
    expect(errors.join("\n")).not.toContain("SECRET");
  });
});

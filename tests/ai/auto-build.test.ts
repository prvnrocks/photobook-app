// M13 T4 — automatic first build (src/lib/ai/auto-build.ts) against the REAL orchestrator
// startRun with an in-memory DB (unique active-run index, caps) and the ReplayTransport.
// No network, no Supabase.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("real client must not be used");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("admin client must not be used");
  },
}));

const { startAutoBuild, isAutoBuildReady, isAutoBuildRefusal, AUTO_BUILD_MIN_READY_PHOTOS } = await import(
  "@/lib/ai/auto-build"
);
const orch = await import("@/lib/ai/orchestrator");
const { ReplayTransport } = await import("@/lib/ai/transport-replay");

type OrchestratorDeps = import("@/lib/ai/orchestrator").OrchestratorDeps;
type AutoBuildDeps = import("@/lib/ai/auto-build").AutoBuildDeps;
type BookForRun = import("@/lib/db/books").BookForRun;
type CurationPhotoRow = import("@/lib/db/photos").CurationPhotoRow;
type AiMode = import("@/lib/ai/client").AiMode;

const BOOK = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-11-12T10:00:00Z");

type Run = {
  id: string;
  book_id: string;
  user_id: string;
  trigger: string;
  mode: string;
  state: string;
  attempts: number;
  ai_status: string | null;
  error_code: string | null;
  token: string | null;
  cost: number;
};

function photoRow(n: number): CurationPhotoRow {
  const landscape = n % 3 === 0;
  return {
    id: pid(n),
    thumb_path: `u/b/${pid(n)}/thumb.jpg`,
    width: landscape ? 4032 : 3024,
    height: landscape ? 3024 : 4032,
    taken_at: new Date(Date.parse("2026-10-10T08:00:00+04:00") + n * 600_000).toISOString(),
    date_source: "exif",
    place: null,
    dup_group: null,
    blur_score: 500,
    ai: null,
    status: "kept",
    drop_reason: null,
    user_override: false,
    original_mime: "image/jpeg",
    camera: "Apple iPhone 15",
    color: null,
  };
}

class Fake {
  now = T0;
  book: BookForRun;
  photos: CurationPhotoRow[];
  uploads: Array<{ upload_state: string }>;
  runs: Run[] = [];
  creates = 0;
  overBudget = false;
  deleteFails = false;
  /** Awaited inside createRunCapped before the insert (forces interleavings). */
  beforeInsert: (() => Promise<void>) | null = null;
  private seq = 0;
  private stampSeq = 0;

  constructor(photoCount = 12) {
    this.photos = Array.from({ length: photoCount }, (_, i) => photoRow(i + 1));
    this.uploads = this.photos.map(() => ({ upload_state: "ready" }));
    this.book = {
      id: BOOK,
      user_id: USER,
      title: null,
      occasion: "travel",
      tone: "fun",
      caption_lang: "en",
      is_paid: false,
      max_pages: 20,
      doc: {},
      updated_at: this.stamp(),
      ai_status: "idle",
      format: "A5_PORTRAIT",
      design_style: "classic",
    } as BookForRun;
  }

  stamp(): string {
    return new Date(T0 + ++this.stampSeq).toISOString();
  }

  seed(over: Partial<Run>): void {
    this.runs.push({
      id: `11111111-1111-4111-8111-9${String(++this.seq).padStart(11, "0")}`,
      book_id: BOOK,
      user_id: USER,
      trigger: "build",
      mode: "rule",
      state: "done",
      attempts: 1,
      ai_status: null,
      error_code: null,
      token: null,
      cost: 0,
      ...over,
    });
  }

  orchestratorDeps(mode: AiMode): OrchestratorDeps {
    const transport = mode === "off" ? null : new ReplayTransport();
    const find = (id: string) => this.runs.find((r) => r.id === id);
    const deps: Partial<OrchestratorDeps> = {
      getBookForRun: async (id) => (id === this.book.id ? structuredClone(this.book) : null),
      setBookAiStatus: async (_id, status) => {
        this.book.ai_status = status;
      },
      writeDocIfReplaceable: async (_id, doc, _pages, expected) => {
        if (expected.updatedAt !== this.book.updated_at) return { ok: false, reason: "conflict" };
        this.book.doc = structuredClone(doc);
        this.book.updated_at = this.stamp();
        return { ok: true };
      },
      listPhotosForCuration: async () => structuredClone(this.photos),
      writeCuration: async () => undefined,
      createRunCapped: async (input) => {
        this.creates++;
        if (this.beforeInsert) await this.beforeInsert();
        // agent_runs_one_active_per_book_idx
        if (this.runs.some((r) => r.book_id === input.bookId && r.trigger !== "rewrite" && r.state !== "done" && r.state !== "failed")) {
          return { error: "already_running" };
        }
        if (input.enforce) {
          const live = this.runs.filter((r) => r.user_id === input.userId && r.mode === "live");
          if (live.length >= input.dailyCap) return { error: "limit", limit: "daily_builds" };
        }
        const id = `11111111-1111-4111-8111-${String(++this.seq).padStart(12, "0")}`;
        this.runs.push({
          id,
          book_id: input.bookId,
          user_id: input.userId,
          trigger: input.trigger,
          mode: input.mode,
          state: "queued",
          attempts: 0,
          ai_status: null,
          error_code: null,
          token: null,
          cost: 0,
        });
        return { id };
      },
      claimRun: async (id) => {
        const r = find(id);
        if (!r || r.state === "done" || r.state === "failed" || r.token) return null;
        r.attempts++;
        r.token = `tok-${id}-${r.attempts}`;
        return r.token;
      },
      releaseRun: async (id, token) => {
        const r = find(id);
        if (r && r.token === token) r.token = null;
      },
      checkpointRun: async (id, token, patch) => {
        const r = find(id);
        if (!r || r.token !== token) return false;
        if (patch.state) r.state = patch.state;
        if (patch.ai_status !== undefined) r.ai_status = patch.ai_status;
        if (patch.error_code !== undefined) r.error_code = patch.error_code;
        return true;
      },
      hasFinishedLiveAiRun: async () =>
        this.runs.some((r) => r.mode === "live" && r.state === "done" && (r.ai_status === "ok" || r.ai_status === "partial")),
      isOverDailyAiBudget: async () => this.overBudget,
      resolveMode: () => mode,
      transportFor: () => transport,
      now: () => this.now,
      sleep: async () => undefined,
    };
    return deps as OrchestratorDeps;
  }

  autoDeps(mode: AiMode): AutoBuildDeps {
    return {
      hasAnyRunForBook: async (bookId, except) => this.runs.some((r) => r.book_id === bookId && r.id !== except),
      deleteUnclaimedRun: async (runId, bookId) => {
        if (this.deleteFails) throw new Error("db down");
        const i = this.runs.findIndex((r) => r.id === runId && r.book_id === bookId && r.state === "queued" && r.attempts === 0);
        if (i < 0) return false;
        this.runs.splice(i, 1);
        return true;
      },
      listUploadState: async () => structuredClone(this.uploads),
      startRun: orch.startRun,
      orchestratorDeps: () => this.orchestratorDeps(mode),
    };
  }

  auto(mode: AiMode) {
    return startAutoBuild({ book: { id: this.book.id, doc: this.book.doc }, userId: USER }, this.autoDeps(mode));
  }
}

let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});

describe("isAutoBuildReady", () => {
  const rows = (ready: number, pending = 0) => [
    ...Array.from({ length: ready }, () => ({ upload_state: "ready" })),
    ...Array.from({ length: pending }, () => ({ upload_state: "pending" })),
  ];
  it(`needs ≥ ${AUTO_BUILD_MIN_READY_PHOTOS} ready photos and nothing pending`, () => {
    expect(AUTO_BUILD_MIN_READY_PHOTOS).toBe(5);
    expect(isAutoBuildReady(rows(0))).toBe(false);
    expect(isAutoBuildReady(rows(4))).toBe(false);
    expect(isAutoBuildReady(rows(5))).toBe(true);
    expect(isAutoBuildReady(rows(40))).toBe(true);
    expect(isAutoBuildReady(rows(40, 1))).toBe(false);
    expect(isAutoBuildReady([{ upload_state: "weird" }, ...rows(9)])).toBe(false);
  });
});

describe("startAutoBuild", () => {
  it("replay: starts one build run (trigger 'build', state queued)", async () => {
    const db = new Fake();
    const r = await db.auto("replay");
    expect(r).toEqual({ ok: true, runId: db.runs[0].id, mode: "replay", state: "queued" });
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ trigger: "build", mode: "replay" });
  });

  it("AI_MODE=off: synchronous rule run, album written", async () => {
    const db = new Fake();
    const r = await db.auto("off");
    expect(r).toMatchObject({ ok: true, mode: "rule", state: "done" });
    expect(db.runs).toHaveLength(1);
    expect((db.book.doc as { pages?: unknown[] }).pages?.length).toBeGreaterThan(0);
  });

  it.each<AiMode>(["replay", "live", "off"])("double call at once (%s) → exactly one run", async (mode) => {
    const db = new Fake();
    const [a, b] = await Promise.all([db.auto(mode), db.auto(mode)]);
    expect(db.runs).toHaveLength(1);
    const oks = [a, b].filter((x) => x.ok);
    expect(oks).toHaveLength(1);
    const other = [a, b].find((x) => !x.ok);
    expect(other).toBeDefined();
    expect(["already_running", "not_first"]).toContain((other as { error: string }).error);
  });

  it("rule run finishing before the twin inserts → twin's run is deleted, answers not_first", async () => {
    const db = new Fake();
    // Both pass the "no run yet" pre-check; the second insert waits until the first run is done.
    let firstDone!: () => void;
    const done = new Promise<void>((r) => (firstDone = r));
    let calls = 0;
    db.beforeInsert = async () => {
      if (++calls === 2) await done;
    };
    const pa = db.auto("off").then((r) => {
      firstDone();
      return r;
    });
    const pb = db.auto("off");
    const [a, b] = await Promise.all([pa, pb]);
    expect(a).toMatchObject({ ok: true, mode: "rule", state: "done" });
    expect(b).toEqual({ ok: false, error: "not_first" });
    expect(db.creates).toBe(2);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].state).toBe("done");
  });

  it("duplicate that can't be deleted is failed instead (never resumed as active)", async () => {
    const db = new Fake();
    let firstDone!: () => void;
    const done = new Promise<void>((r) => (firstDone = r));
    let calls = 0;
    db.beforeInsert = async () => {
      if (++calls === 2) await done;
    };
    db.deleteFails = true;
    const pa = db.auto("off").then((r) => {
      firstDone();
      return r;
    });
    const [, b] = await Promise.all([pa, db.auto("off")]);
    expect(b).toEqual({ ok: false, error: "not_first" });
    expect(db.runs).toHaveLength(2);
    expect(db.runs[1]).toMatchObject({ state: "failed", error_code: "auto_duplicate", token: null });
    expect(errors.join("\n")).toContain("duplicate run not deleted");
    expect(errors.join("\n")).not.toContain(BOOK);
  });

  it.each([
    { state: "done", trigger: "build", mode: "rule" },
    { state: "failed", trigger: "build", mode: "live" },
    { state: "queued", trigger: "build", mode: "replay" },
    { state: "done", trigger: "rebuild", mode: "live" },
    { state: "done", trigger: "rewrite", mode: "live" },
  ])("after any run (%o) → not_first, no run created", async (seed) => {
    for (const mode of ["live", "replay", "off"] as AiMode[]) {
      const db = new Fake();
      db.seed(seed);
      expect(await db.auto(mode)).toEqual({ ok: false, error: "not_first" });
      expect(db.creates).toBe(0);
      expect(db.runs).toHaveLength(1);
    }
  });

  it("an AI-made doc → not_first even without a run row (never an automatic rebuild)", async () => {
    const db = new Fake();
    db.book.doc = { version: 1, meta: { generator: "ai" }, pages: [] };
    expect(await db.auto("live")).toEqual({ ok: false, error: "not_first" });
    expect(db.creates).toBe(0);
  });

  it("not_ready: < 5 ready photos, or an upload pending — no run", async () => {
    const few = new Fake(4);
    expect(await few.auto("replay")).toEqual({ ok: false, error: "not_ready" });
    const pending = new Fake(20);
    pending.uploads.push({ upload_state: "pending" });
    expect(await pending.auto("replay")).toEqual({ ok: false, error: "not_ready" });
    expect(few.creates + pending.creates).toBe(0);
  });

  it("caps apply: daily build cap (D-026) → limit daily_builds, no run", async () => {
    const db = new Fake();
    // Three live runs of the user on OTHER books today (free cap 3).
    for (let i = 0; i < 3; i++) db.seed({ book_id: pid(900 + i), mode: "live", state: "done" });
    expect(await db.auto("live")).toEqual({ ok: false, error: "limit", limit: "daily_builds" });
    expect(db.runs.filter((r) => r.book_id === BOOK)).toHaveLength(0);
  });

  it("daily budget (D-059) → limit budget_exhausted, no run", async () => {
    const db = new Fake();
    db.overBudget = true;
    expect(await db.auto("live")).toEqual({ ok: false, error: "limit", limit: "budget_exhausted" });
    expect(db.creates).toBe(0);
  });

  it("a user-edited album passes through as user_edited", async () => {
    const db = new Fake();
    db.book.doc = { version: 1, meta: { generator: "user" }, pages: [] };
    const r = await db.auto("replay");
    expect(r).toEqual({ ok: false, error: "user_edited" });
    expect(isAutoBuildRefusal(r)).toBe(false);
    expect(db.creates).toBe(0);
  });

  it("isAutoBuildRefusal", () => {
    expect(isAutoBuildRefusal({ ok: false, error: "not_first" })).toBe(true);
    expect(isAutoBuildRefusal({ ok: false, error: "not_ready" })).toBe(true);
    expect(isAutoBuildRefusal({ ok: false, error: "already_running" })).toBe(false);
    expect(isAutoBuildRefusal({ ok: true, runId: "x", mode: "replay", state: "queued" })).toBe(false);
  });
});

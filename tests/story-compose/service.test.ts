// Task 7: composeStorybookPages — owner check, AI page intent (one call, aliases only, approved ids
// only, limits before a live call, refusal / invalid → deterministic), merge with user edits, save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null), saveDocIfRev: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/photo-analyses", () => ({ getTodayPhotoAnalysisSpendUsd: vi.fn(async () => 0), dubaiDayStart: () => "" }));
vi.mock("@/lib/db/photo-organize", () => ({ listPhotosForOrganize: vi.fn(), listQuality: vi.fn() }));
vi.mock("@/lib/db/story-ai-calls", () => ({ countStoryRuns: vi.fn(), getTodayStorySpendUsd: vi.fn(async () => 0), recordStoryCall: vi.fn(), storyUsageAvailable: vi.fn(async () => false) }));
vi.mock("@/lib/db/storybooks", () => ({ getCurrentStorybook: vi.fn() }));
vi.mock("@/lib/ai/budget", () => ({ checkDailyAiBudget: vi.fn(async () => ({ allowed: true, reason: "no_budget" })) }));

import { ComposeError, composeStorybookPages, type ComposeBook, type ComposeDeps } from "@/lib/ai/story/compose";
import { STORY_COMPOSE_SYSTEM_PROMPT, storyComposeReplaySynth } from "@/lib/ai/story/compose-intent";
import type { AgentRequest, AgentResponse, AgentTransport } from "@/lib/ai/transport";
import { LIMITS } from "@/lib/ai/limits";
import { serializeDoc } from "@/lib/book/doc-version";
import { setPageText } from "@/lib/book/edit-ops";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import type { OrganizePhotoRow } from "@/lib/db/photo-organize";
import type { StoryCallRecord } from "@/lib/db/story-ai-calls";
import { FIXTURE_BOOK_ID, storyFixture } from "@/lib/storybook/compose/dev-fixture";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;
const fixture = storyFixture({ photos: 24, design: { format: "A5_PORTRAIT", designStyle: "magazine" } });
const rows: OrganizePhotoRow[] = fixture.photos.map((p) => ({ id: p.id, fingerprint: "f", phash: null, thumb_path: null, width: p.width, height: p.height, taken_at: null, date_source: null, lat: null, lng: null, place: null, blur_score: 100, ai: null, status: "kept" }));

const book = (over: Partial<ComposeBook> = {}): ComposeBook => ({ id: FIXTURE_BOOK_ID, title: null, occasion: "travel", caption_lang: "en", is_paid: false, max_pages: 20, doc: {}, doc_rev: 0, format: "A5_PORTRAIT", design_style: "magazine", ...over });

type Script = (req: AgentRequest<unknown>) => Partial<AgentResponse<unknown>> | Error;
function world(over: { theBook?: ComposeBook; script?: Script; counts?: number; usage?: boolean; budget?: boolean; mode?: ComposeDeps["mode"]; noStory?: boolean } = {}) {
  const requests: AgentRequest<unknown>[] = [];
  const records: StoryCallRecord[] = [];
  const saves: { doc: unknown; rev: number }[] = [];
  let rev = over.theBook?.doc_rev ?? 0;
  const transport: AgentTransport = {
    kind: "live",
    async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
      requests.push(req as AgentRequest<unknown>);
      const good = storyComposeReplaySynth(req.scenarioMeta ?? {}, { scenario: "ok", request: req as AgentRequest<unknown> });
      const s = over.script?.(req as AgentRequest<unknown>) ?? {};
      if (s instanceof Error) throw s;
      return { parsed: (s.parsed === undefined ? good : s.parsed) as T, stopReason: s.stopReason === undefined ? "end_turn" : s.stopReason, stopCategory: null, usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 }, model: "claude-opus-5-5", latencyMs: 1200 };
    },
  };
  const deps: ComposeDeps = {
    ownerOf: async (id) => (id === FIXTURE_BOOK_ID ? { userId: USER, book: over.theBook ?? book() } : null),
    getCurrent: vi.fn(async () => (over.noStory ? null : fixture.storybook)),
    listPhotos: vi.fn(async () => rows),
    listQuality: vi.fn(async () => []),
    save: vi.fn(async (_b: string, _u: string, doc: unknown, _n: number, base: number) => {
      if (base !== rev) return { ok: false as const, reason: "conflict" as const };
      saves.push({ doc, rev: ++rev });
      return { ok: true as const, rev, savedAt: "now" };
    }),
    usageAvailable: async () => over.usage ?? true,
    usageCounts: async () => ({ plans: 0, writes: 0, chapterRegens: 0, rewrites: 0, composes: over.counts ?? 0 }),
    record: async (r) => void records.push(r),
    budgetExhausted: async () => over.budget ?? false,
    mode: over.mode ?? "live",
    transport,
    config: { model: "claude-opus-5-5", modelFallback: false, timeoutMs: 90_000, retries: 0 },
    now: () => 0,
    sleep: async () => {},
    newRunId: () => "11111111-1111-4111-8111-111111111111",
  };
  return { deps, requests, records, saves };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof ComposeError ? e.code : `unexpected: ${String(e)}`;
  }
};

let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("composeStorybookPages: access and inputs", () => {
  it("someone else's book / a malformed id → not_found, nothing read", async () => {
    const w = world();
    expect(await code(composeStorybookPages("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {}, w.deps))).toBe("not_found");
    expect(w.deps.getCurrent).not.toHaveBeenCalled();
    expect(w.requests).toHaveLength(0);
  });
  it("no storybook → no_story; an edited non-story album → user_edited (nothing written)", async () => {
    expect(await code(composeStorybookPages(FIXTURE_BOOK_ID, {}, world({ noStory: true }).deps))).toBe("no_story");
    const album = { version: 1, format: "A5_PORTRAIT", occasion: "travel", cover: { layout: "cover", photoId: null, title: "T", subtitle: "" }, chapters: [], pages: [], style: { background: "#FFFFFF", font: "Playfair" }, meta: { generator: "rule", generatorVersion: 1, runId: null, userEdited: true } };
    const w = world({ theBook: book({ doc: album, design_style: "magazine" }) });
    expect(await code(composeStorybookPages(FIXTURE_BOOK_ID, {}, w.deps))).toBe("user_edited");
    expect(w.saves).toHaveLength(0);
  });
});

describe("composeStorybookPages: AI page intent", () => {
  it("ONE call with aliases only (no uuid), the approved catalogue, a static system prompt; recorded as compose", async () => {
    const w = world();
    const r = await composeStorybookPages(FIXTURE_BOOK_ID, {}, w.deps);
    expect(w.requests).toHaveLength(1);
    const req = w.requests[0]!;
    const text = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(text).not.toMatch(UUID);
    expect(text).toContain("APPROVED TEMPLATES");
    expect(text).toMatch(/pg1 kind=chapter_opener/);
    expect(req.system).toEqual([{ type: "text", text: STORY_COMPOSE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(req.messages.some((m) => typeof m.content !== "string")).toBe(false);
    expect(r.report.ai.status).toBe("used");
    expect(r.report.ai.used).toBeGreaterThan(0);
    expect(w.records).toHaveLength(1);
    expect(w.records[0]).toMatchObject({ kind: "compose", scope: "compose", mode: "live", status: "ok", chapterId: null, storybookVersion: 1 });
    expect(JSON.stringify(w.records[0])).not.toMatch(/lantern|doorway|garden/);
    expect(w.saves).toHaveLength(1);
    expect(w.saves[0]!.doc).toEqual(serializeDoc(r.doc));
    expect(r.rev).toBe(1);
    expect(r.doc.meta?.generator).toBe("ai");
  });

  it("template ids outside the approved list are ignored; the deterministic rules lay the pages out", async () => {
    const w = world({ script: (req) => ({ parsed: { pages: ((req.scenarioMeta?.pages ?? []) as { id: string; family: string }[]).map((p) => ({ pageId: p.id, family: p.family, emphasis: "balanced", templateId: "full-page" })) } }) });
    const r = await composeStorybookPages(FIXTURE_BOOK_ID, {}, w.deps);
    expect(r.report.ai.used).toBe(0);
    expect(r.report.ai.ignored).toBe(r.doc.pages.length > 0 ? fixture.storybook.pages.length : 0);
    expect(r.doc.pages.some((p) => p.layout === "full-page")).toBe(false);
  });

  it("refusal / invalid output / model error → deterministic composition (same doc as AI off)", async () => {
    const off = await composeStorybookPages(FIXTURE_BOOK_ID, { dryRun: true }, world({ mode: "off" }).deps);
    expect(off.report.ai.status).toBe("off");
    for (const [script, status] of [
      [() => ({ parsed: null, stopReason: "refusal" }), "refused"],
      [() => ({ parsed: { pages: "nope" } }), "invalid"],
      [() => new (class extends Error {})("boom"), "model_error"],
    ] as const) {
      const w = world({ script: script as Script });
      const r = await composeStorybookPages(FIXTURE_BOOK_ID, { dryRun: true }, w.deps);
      expect(r.report.ai.status).toBe(status);
      expect(JSON.stringify(serializeDoc(r.doc))).toBe(JSON.stringify(serializeDoc(off.doc)));
    }
  });

  it("limits, usage table and daily budget are checked BEFORE a live call", async () => {
    for (const [over, status] of [
      [{ counts: LIMITS.free.maxStoryComposes }, "limit_reached"],
      [{ usage: false }, "usage_unavailable"],
      [{ budget: true }, "budget_exhausted"],
    ] as const) {
      const w = world(over);
      const r = await composeStorybookPages(FIXTURE_BOOK_ID, { dryRun: true }, w.deps);
      expect(r.report.ai.status).toBe(status);
      expect(w.requests).toHaveLength(0);
    }
    const paid = world({ theBook: book({ is_paid: true, max_pages: 100 }), counts: LIMITS.free.maxStoryComposes });
    expect((await composeStorybookPages(FIXTURE_BOOK_ID, { dryRun: true }, paid.deps)).report.ai.status).toBe("used");
  });

  it("replay mode uses the replay synthesiser (no network) and is deterministic", async () => {
    const a = await composeStorybookPages(FIXTURE_BOOK_ID, { dryRun: true }, { ...world().deps, mode: "replay", transport: undefined, usageAvailable: async () => false });
    const b = await composeStorybookPages(FIXTURE_BOOK_ID, { dryRun: true }, { ...world().deps, mode: "replay", transport: undefined, usageAvailable: async () => false });
    expect(a.report.ai.status).toBe("used");
    expect(JSON.stringify(serializeDoc(a.doc))).toBe(JSON.stringify(serializeDoc(b.doc)));
  });
});

describe("composeStorybookPages: saving and recomposition", () => {
  it("a concurrent edit → conflict, nothing stored; no doc_rev → saving_unavailable", async () => {
    const w = world({ theBook: book({ doc_rev: 3 }) });
    w.deps.save = vi.fn(async () => ({ ok: false as const, reason: "conflict" as const }));
    expect(await code(composeStorybookPages(FIXTURE_BOOK_ID, {}, w.deps))).toBe("conflict");
    expect(await code(composeStorybookPages(FIXTURE_BOOK_ID, {}, world({ theBook: book({ doc_rev: null }) }).deps))).toBe("saving_unavailable");
  });

  it("recomposing a saved, user-edited book keeps the user's page byte-identical; unchanged → byte-identical doc", async () => {
    const first = await composeStorybookPages(FIXTURE_BOOK_ID, {}, world({ mode: "off" }).deps);
    const stored = JSON.parse(JSON.stringify(serializeDoc(first.doc)));
    const again = await composeStorybookPages(FIXTURE_BOOK_ID, { dryRun: true }, world({ mode: "off", theBook: book({ doc: stored, doc_rev: 1 }) }).deps);
    expect(JSON.stringify(serializeDoc(again.doc))).toBe(JSON.stringify(stored));

    const parsed = parseBookDoc(stored);
    if (!parsed.ok) throw new Error("parse");
    const idx = parsed.doc.pages.findIndex((p) => p.texts?.length);
    const edited: BookDoc = { ...setPageText(parsed.doc, idx, parsed.doc.pages[idx]!.texts![0]!.panel, "Our own words."), meta: { ...parsed.doc.meta!, userEdited: true } };
    const editedStored = JSON.parse(JSON.stringify(serializeDoc(edited)));
    const r = await composeStorybookPages(FIXTURE_BOOK_ID, {}, world({ mode: "off", theBook: book({ doc: editedStored, doc_rev: 2 }) }).deps);
    expect(JSON.stringify(r.doc.pages[idx])).toBe(JSON.stringify(edited.pages[idx]));
    expect(r.doc.pages[idx]!.texts![0]!.source).toBe("user");
  });
});

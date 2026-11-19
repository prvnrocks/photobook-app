// Task 9: cost accounting (configurable pricing, unpriced models, the per-attempt usage ledger with
// failed / retried rows and cost buckets, spending caps) and caching (analysis cache by hash + model
// + prompt version; rewrites never re-analyse photos). No DB, no network.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/books", () => ({ getMyBook: vi.fn(async () => null) }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/db/photo-analyses", () => ({
  getTodayPhotoAnalysisSpendUsd: vi.fn(async () => 0),
  dubaiDayStart: () => "",
  loadOwnPhoto: vi.fn(async () => null),
  getCachedAnalysis: vi.fn(async () => null),
  recordAnalysisCall: vi.fn(async () => {}),
  countAnalysedPhotos: vi.fn(async () => 0),
}));
vi.mock("@/lib/db/photo-ingest", () => ({ listRejectedPhotoIds: vi.fn(async () => new Set()) }));
vi.mock("@/lib/db/photos", () => ({ loadThumbBase64: vi.fn(async () => new Map()) }));
vi.mock("@/lib/db/photo-organize", () => ({ listPhotosForOrganize: vi.fn(), listVision: vi.fn(), listMoments: vi.fn(), listDuplicateGroups: vi.fn() }));
vi.mock("@/lib/db/story-ai-calls", () => ({ countStoryRuns: vi.fn(), getTodayStorySpendUsd: vi.fn(async () => 0), recordStoryCall: vi.fn(), storyUsageAvailable: vi.fn(async () => false) }));
vi.mock("@/lib/db/storybooks", () => ({ appendStorybookVersion: vi.fn(), getCurrentStorybook: vi.fn(), getMemoryContext: vi.fn() }));
vi.mock("@/lib/ai/budget", () => ({ checkDailyAiBudget: vi.fn(async () => ({ allowed: true, reason: "no_budget" })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
// Spy on photo analysis: a story rewrite must never reach it.
vi.mock("@/lib/ai/photo-intelligence/analyze", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/photo-intelligence/analyze")>();
  return { ...real, analyzePhoto: vi.fn(real.analyzePhoto), analyzePhotos: vi.fn(real.analyzePhotos) };
});

import { AI_MODEL } from "@/lib/ai/client";
import { costOf, costUsd, estimateCallCostUsd, isPriced } from "@/lib/ai/cost";
import { SPEND_CAPS } from "@/lib/ai/limits";
import * as analyzeModule from "@/lib/ai/photo-intelligence/analyze";
import { DEFAULT_PHOTO_MODEL, readPhotoAiConfig } from "@/lib/ai/photo-intelligence/config";
import { PHOTO_PROMPT_VERSION } from "@/lib/ai/photo-intelligence/prompt";
import { DEFAULT_PRICING, lookupPrice, maxKnownPrice, readPricing } from "@/lib/ai/pricing";
import { runAgentStep, type StepLogger } from "@/lib/ai/run-step";
import { checkSpendCaps, readSpendCaps, spendCapDecision } from "@/lib/ai/spend-caps";
import { DEFAULT_STORY_MODEL, readStoryAiConfig } from "@/lib/ai/story/config";
import { planStory, rewriteNarrativeBlock, writeStory } from "@/lib/ai/story/service";
import { TransportError, type AgentResponse, type AgentTransport } from "@/lib/ai/transport";
import { createUsageMeter } from "@/lib/ai/usage/meter";
import { costBucketFor, usageErrorCode, type UsageEvent } from "@/lib/ai/usage/types";
import { AiUsageError, usageInsertRow, type UsageRow } from "@/lib/db/ai-usage";
import type { CacheKey, CachedAnalysis, OwnPhoto } from "@/lib/db/photo-analyses";
import { z } from "zod";
import { BOOK, USER, world } from "./story-fixtures";

let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------- pricing

describe("pricing is configuration, not code (Task 9)", () => {
  it("defaults: the two models the project uses, per million tokens", () => {
    expect(readPricing({}).prices).toEqual(DEFAULT_PRICING);
    expect(DEFAULT_PRICING["claude-opus-5-5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(DEFAULT_PRICING["claude-sonnet-5-5"]).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  });

  it("AI_PRICING_JSON overrides a model and adds new ones (cache rates derived when omitted)", () => {
    const t = readPricing({ AI_PRICING_JSON: JSON.stringify({ "claude-opus-5-5": { input: 5, output: 25 }, "claude-next-1": { input: 1, output: 5, cacheRead: 0.08, cacheWrite: 1.3 } }) });
    expect(t.error).toBeNull();
    expect(t.prices["claude-opus-5-5"]).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(t.prices["claude-next-1"]).toEqual({ input: 1, output: 5, cacheRead: 0.08, cacheWrite: 1.3 });
    expect(t.prices["claude-sonnet-5-5"]).toEqual(DEFAULT_PRICING["claude-sonnet-5-5"]);
  });

  it("an invalid override is ignored as a whole (never zeroes prices) and reported", () => {
    expect(readPricing({ AI_PRICING_JSON: "{not json" })).toEqual({ prices: DEFAULT_PRICING, error: "invalid_json" });
    expect(readPricing({ AI_PRICING_JSON: JSON.stringify({ "claude-opus-5-5": { input: -1, output: 0 } }) })).toEqual({ prices: DEFAULT_PRICING, error: "invalid_shape" });
    expect(readPricing({ AI_PRICING_JSON: JSON.stringify({ "Bad Model!": { input: 1, output: 1 } }) }).error).toBe("invalid_shape");
    expect(readPricing({ AI_PRICING_JSON: JSON.stringify({ "claude-opus-5-5": { input: 1, output: 1, extra: 2 } }) }).error).toBe("invalid_shape");
  });

  it("the effective table follows the environment (no deploy needed for a price change)", () => {
    const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costUsd("claude-opus-5-5", u)).toBe(4);
    vi.stubEnv("AI_PRICING_JSON", JSON.stringify({ "claude-opus-5-5": { input: 6, output: 30 } }));
    try {
      expect(costUsd("claude-opus-5-5", u)).toBe(6);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(costUsd("claude-opus-5-5", u)).toBe(4);
  });

  it("an unknown model is UNPRICED: costed at the highest known rate and flagged, never silently $0", () => {
    const u = { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };
    expect(isPriced("claude-haiku-5-5")).toBe(false);
    const c = costOf("claude-haiku-5-5", u);
    expect(c.priced).toBe(false);
    expect(c.usd).toBeGreaterThan(0);
    expect(c.usd).toBe(costOf("claude-opus-5-5", u).usd);
    expect(lookupPrice("__proto__").priced).toBe(false);
    expect(maxKnownPrice(DEFAULT_PRICING)).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(costOf("claude-sonnet-5-5", u)).toEqual({ usd: 0.012, priced: true });
    expect(estimateCallCostUsd("claude-sonnet-5-5", { inputTokens: 1000, maxOutputTokens: 1000 })).toBeCloseTo(0.0125, 6);
  });
});

// ------------------------------------------------------------------------------------- models

describe("smaller model for photo descriptions, stronger model for narrative (Task 9)", () => {
  it("photo analysis defaults to claude-sonnet-5-5; narrative writing defaults to AI_MODEL (Opus); both configurable", () => {
    expect(DEFAULT_PHOTO_MODEL).toBe("claude-sonnet-5-5");
    expect(readPhotoAiConfig({}).model).toBe("claude-sonnet-5-5");
    expect(DEFAULT_STORY_MODEL).toBe(AI_MODEL);
    expect(readStoryAiConfig({}).model).toBe("claude-opus-5-5");
    expect(readPhotoAiConfig({ AI_PHOTO_MODEL: "claude-opus-5-5" }).model).toBe("claude-opus-5-5");
    expect(readStoryAiConfig({ AI_STORY_MODEL: "claude-sonnet-5-5" }).model).toBe("claude-sonnet-5-5");
    // the photo model is cheaper per token than the narrative model
    expect(DEFAULT_PRICING[DEFAULT_PHOTO_MODEL]!.input).toBeLessThan(DEFAULT_PRICING[DEFAULT_STORY_MODEL]!.input);
  });
});

// ------------------------------------------------------------------------------------- ledger events

const Out = z.object({ ok: z.boolean() });
const resp = (over: Partial<AgentResponse<unknown>> = {}): AgentResponse<unknown> => ({
  parsed: { ok: true },
  stopReason: "end_turn",
  usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 },
  model: "claude-sonnet-5-5",
  latencyMs: 1200,
  ...over,
});
function scripted(...steps: (AgentResponse<unknown> | Error)[]): AgentTransport {
  let i = 0;
  return {
    kind: "live",
    parse: async () => {
      const s = steps[Math.min(i++, steps.length - 1)]!;
      if (s instanceof Error) throw s;
      return s as never;
    },
  };
}
function step(transport: AgentTransport, meter: UsageEvent[], retries = 2) {
  const logger: StepLogger = { insertStep: async () => {}, addRunTotals: async () => {}, meter: { record: async (ev) => void meter.push(ev) } };
  return runAgentStep({
    runId: "00000000-0000-4000-8000-000000000001",
    agent: "curator",
    stepKey: "photo-insight",
    inputSummary: {},
    request: { agent: "curator", system: [], messages: [{ role: "user", content: "x" }], schema: Out, effort: "low", maxTokens: 100, model: "claude-sonnet-5-5" },
    strictSchema: Out,
    toLogOutput: () => ({}),
    transport,
    logger,
    retry: { retries, sleep: async () => {} },
  });
}

describe("usage ledger: every attempt is recorded with model, tokens, latency, cost and status (Task 9)", () => {
  it("ok on the first try → ONE ok row with tokens incl. cache, cost, priced, latency, attempt 1", async () => {
    const ev: UsageEvent[] = [];
    const r = await step(scripted(resp()), ev);
    expect(r.ok).toBe(true);
    expect(ev).toEqual([
      {
        agent: "curator",
        runId: "00000000-0000-4000-8000-000000000001",
        mode: "live",
        model: "claude-sonnet-5-5",
        status: "ok",
        attempt: 1,
        error: null,
        usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 },
        costUsd: costUsd("claude-sonnet-5-5", { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 }),
        priced: true,
        latencyMs: 1200,
      },
    ]);
  });

  it("429 then 5xx then ok → two RETRIED rows (attempts 1, 2, error codes, no cost) and the ok row (attempt 3)", async () => {
    const ev: UsageEvent[] = [];
    await step(scripted(new TransportError("rate_limited", "x", { status: 429 }), new TransportError("server_error", "x", { status: 529 }), resp()), ev);
    expect(ev.map((e) => [e.status, e.attempt, e.error, e.costUsd])).toEqual([
      ["retried", 1, "rate_limited", 0],
      ["retried", 2, "server_error", 0],
      ["ok", 3, null, ev[2]!.costUsd],
    ]);
    expect(ev[2]!.costUsd).toBeGreaterThan(0);
  });

  it("retries exhausted → retried rows, then ONE failed row with the code; a non-retryable error fails at once", async () => {
    const ev: UsageEvent[] = [];
    const r = await step(scripted(new TransportError("timeout", "x")), ev, 1);
    expect(r.ok).toBe(false);
    expect(ev.map((e) => [e.status, e.attempt, e.error])).toEqual([
      ["retried", 1, "timeout"],
      ["failed", 2, "timeout"],
    ]);
    const ev2: UsageEvent[] = [];
    await step(scripted(new TransportError("bad_request", "x", { status: 400 })), ev2);
    expect(ev2.map((e) => [e.status, e.attempt, e.error])).toEqual([["failed", 1, "bad_request"]]);
  });

  it("refusal → refused row; invalid output → failed row that still carries the billed tokens", async () => {
    const ev: UsageEvent[] = [];
    await step(scripted(resp({ stopReason: "refusal", parsed: null })), ev);
    await step(scripted(resp({ parsed: { nope: 1 } })), ev);
    expect(ev.map((e) => [e.status, e.error])).toEqual([
      ["refused", "refusal"],
      ["failed", "schema_invalid"],
    ]);
    expect(ev[1]!.usage.input).toBe(1000);
    expect(ev[1]!.costUsd).toBeGreaterThan(0);
  });

  it("a model without a price is recorded priced:false (and costed high)", async () => {
    const ev: UsageEvent[] = [];
    await step(scripted(resp({ model: "claude-fallback-x" })), ev);
    expect(ev[0]).toMatchObject({ model: "claude-fallback-x", priced: false });
    expect(ev[0]!.costUsd).toBe(costUsd("claude-opus-5-5", { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100 }));
  });

  it("a meter that throws never fails the call", async () => {
    const logger: StepLogger = { insertStep: async () => {}, addRunTotals: async () => {}, meter: { record: async () => Promise.reject(new Error("db down")) } };
    const r = await runAgentStep({ runId: "r", agent: "curator", stepKey: "k", inputSummary: {}, request: { agent: "curator", system: [], messages: [{ role: "user", content: "x" }], schema: Out, effort: "low", maxTokens: 10 }, strictSchema: Out, toLogOutput: () => ({}), transport: scripted(resp()), logger });
    expect(r.ok).toBe(true);
  });
});

describe("usage meter: cost buckets, live only, number-only rows (Task 9)", () => {
  const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({ agent: "storyteller", runId: null, model: "claude-opus-5-5", mode: "live", status: "ok", attempt: 1, error: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01, priced: true, latencyMs: 5, ...over });

  it("buckets: storybook without entitlement = preview, entitled = paid, classic free album = other", () => {
    expect(costBucketFor("storybook", "preview")).toBe("preview");
    expect(costBucketFor("storybook", "full")).toBe("paid");
    expect(costBucketFor("album", "full")).toBe("paid");
    expect(costBucketFor("album", "preview")).toBe("other");
  });

  it("writes one row per live event with the bucket from the entitlement (looked up once); replay is not recorded", async () => {
    const rows: UsageRow[] = [];
    const tierOf = vi.fn(async () => "preview" as const);
    const m = createUsageMeter({ userId: USER, bookId: BOOK, flow: "storybook", operation: "plan" }, { insert: async (r) => void rows.push(r), tierOf });
    await m.record(ev());
    await m.record(ev({ status: "retried", attempt: 1, error: "timeout", costUsd: 0 }));
    await m.record(ev({ mode: "replay" }));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.operation, r.status, r.bucket])).toEqual([
      ["plan", "ok", "preview"],
      ["plan", "retried", "preview"],
    ]);
    expect(tierOf).toHaveBeenCalledTimes(1);
    const paid = createUsageMeter({ userId: USER, bookId: BOOK, flow: "storybook" }, { insert: async (r) => void rows.push(r), tierOf: async () => "full" });
    await paid.record(ev({ agent: "caption_writer" }));
    expect(rows.at(-1)).toMatchObject({ operation: "caption_writer", bucket: "paid" });
  });

  it("a failed ledger write is swallowed and logged as a code only (never ids or content)", async () => {
    const m = createUsageMeter({ userId: USER, bookId: BOOK, flow: "album", tier: "preview" }, { insert: async () => Promise.reject(new AiUsageError("insert ai usage", "08006")) });
    await expect(m.record(ev())).resolves.toBeUndefined();
    const lines = logs.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.join(" ")));
    expect(lines).toEqual(["[ai-usage] record_failed (08006)"]);
    expect(lines.join(" ")).not.toContain(USER);
  });

  it("insert rows are clamped to the table checks (error codes, attempt, ids, buckets)", () => {
    const row = usageInsertRow({ userId: "not-a-uuid", bookId: BOOK, runId: null, operation: "write", model: "", mode: "live", status: "failed", attempt: 99, error: "Server Error: 529!", usage: { input: -3, output: 2.6, cacheRead: Number.NaN, cacheWrite: 1 }, costUsd: -1, priced: false, latencyMs: 12.4, bucket: "preview" });
    expect(row).toMatchObject({ user_id: null, book_id: BOOK, model: "unknown", attempt: 20, error: "server_error______", input_tokens: 0, output_tokens: 3, cache_read_tokens: 0, cost_usd: 0, priced: false, latency_ms: 12, cost_bucket: "preview" });
    expect(row.error).toMatch(/^[a-z_]{3,40}$/);
    expect(usageInsertRow({ ...{ userId: USER, bookId: null, runId: null, operation: "plan", model: "m", mode: "live", status: "ok", attempt: 1, error: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, priced: true, latencyMs: 0, bucket: "other" } }).error).toBeNull();
    expect(usageErrorCode("a")).toBe("a__");
  });
});

// ------------------------------------------------------------------------------------- spending caps

describe("spending caps per book and per user (Task 9)", () => {
  const zero = { bookUsd: 0, userDayUsd: 0, userMonthUsd: 0 };
  it("defaults and env overrides; invalid values keep the default; 0 blocks", () => {
    expect(readSpendCaps({})).toEqual(SPEND_CAPS);
    expect(readSpendCaps({ AI_CAP_BOOK_PREVIEW_USD: "0.5", AI_CAP_BOOK_FULL_USD: "30", AI_CAP_USER_DAY_USD: "abc", AI_CAP_USER_MONTH_USD: "-4" })).toEqual({ bookPreviewUsd: 0.5, bookFullUsd: 30, userDayUsd: SPEND_CAPS.userDayUsd, userMonthUsd: SPEND_CAPS.userMonthUsd });
    expect(spendCapDecision(zero, readSpendCaps({ AI_CAP_BOOK_PREVIEW_USD: "0" }), "preview")).toEqual({ allowed: false, reason: "book_cap" });
  });

  it("the book cap depends on the tier; user day / month caps apply to all books", () => {
    const caps = readSpendCaps({});
    expect(spendCapDecision({ ...zero, bookUsd: 2 }, caps, "preview")).toEqual({ allowed: false, reason: "book_cap" });
    expect(spendCapDecision({ ...zero, bookUsd: 2 }, caps, "full")).toEqual({ allowed: true, reason: "under_caps" });
    expect(spendCapDecision({ ...zero, bookUsd: 15 }, caps, "full")).toEqual({ allowed: false, reason: "book_cap" });
    expect(spendCapDecision({ ...zero, userDayUsd: 20 }, caps, "full")).toEqual({ allowed: false, reason: "user_day_cap" });
    expect(spendCapDecision({ ...zero, userMonthUsd: 100 }, caps, "full")).toEqual({ allowed: false, reason: "user_month_cap" });
  });

  it("totals that can't be read fail open (logged as a code); a missing migration is silent", async () => {
    expect(await checkSpendCaps({ userId: USER, bookId: BOOK, tier: "preview" }, { totals: async () => ({ ...zero, bookUsd: 9 }) })).toEqual({ allowed: false, reason: "book_cap" });
    expect(await checkSpendCaps({ userId: USER, bookId: BOOK, tier: "preview" }, { totals: async () => Promise.reject(new AiUsageError("x", "08006")) })).toEqual({ allowed: true, reason: "totals_unavailable" });
    expect(await checkSpendCaps({ userId: USER, bookId: BOOK, tier: "preview" }, { totals: async () => Promise.reject(new AiUsageError("x", "PGRST202")) })).toEqual({ allowed: true, reason: "totals_unavailable" });
    const lines = logs.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.join(" ")));
    expect(lines).toEqual(["[spend-caps] totals_unavailable (08006)"]);
  });

  it("a cap reached stops the story plan before any model call (plain rule-plan outcome)", async () => {
    const w = world({ overSpendCap: async () => true });
    const plan = await planStory(BOOK, w.deps);
    expect(w.requests).toHaveLength(0);
    expect(plan).toMatchObject({ source: "rule", fallbackReason: "budget_exhausted" });
  });

  it("a cap reached stops photo analysis before the call (budget_exhausted, no transport call)", async () => {
    const transport = { kind: "live" as const, parse: vi.fn() };
    const err = await analyzeModule
      .analyzePhoto(PHOTO_ID, { ...photoDeps(), transport, overSpendCap: async () => true })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "budget_exhausted" });
    expect(transport.parse).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------- caching

const PHOTO_ID = "00000000-0000-4000-8000-000000000101";
const B64 = Buffer.from("fake-jpeg-bytes-task9").toString("base64");
const SHA = createHash("sha256").update(Buffer.from(B64, "base64")).digest("hex");
const ownPhoto: OwnPhoto = {
  id: PHOTO_ID,
  user_id: USER,
  book_id: BOOK,
  upload_state: "ready",
  thumb_path: `${USER}/${BOOK}/${PHOTO_ID}-thumb.jpg`,
  width: 4000,
  height: 3000,
  taken_at: null,
  date_source: null,
  lat: null,
  lng: null,
  place: null,
  blur_score: null,
  dup_group: null,
  color: null,
  ai: null,
  status: "kept",
  drop_reason: null,
  user_override: false,
  bookIsPaid: false,
} as OwnPhoto;
const VISION = { description: "A beach at sunset.", scene: "landscape", objects: ["beach"], activities: [], peopleCount: 0, storyRole: "establishing", atmosphere: "calm" };

function photoDeps(cache = new Map<string, CachedAnalysis>()) {
  const keyOf = (k: CacheKey) => `${k.userId}|${k.imageSha256}|${k.model}|${k.promptVersion}`;
  const transport = { kind: "live" as const, parse: vi.fn(async () => resp({ parsed: VISION, model: "claude-sonnet-5-5" }) as never) };
  return {
    loadPhoto: async () => ownPhoto,
    isRejected: async () => false,
    loadAiCopy: async () => B64,
    getCached: vi.fn(async (k: CacheKey) => cache.get(keyOf(k)) ?? null),
    record: vi.fn(async (r: { status: string; analysis?: unknown } & CacheKey) => {
      if (r.status === "ok") cache.set(keyOf(r), { analysis: r.analysis } as CachedAnalysis);
    }),
    countAnalysed: async () => 0,
    budgetExhausted: async () => false,
    overSpendCap: async () => false,
    meter: { record: async () => undefined },
    mode: "live" as const,
    transport,
    config: { model: "claude-sonnet-5-5" as const, modelFallback: false, concurrency: 1, timeoutMs: 30_000, retries: 0 },
    sleep: async () => {},
  };
}

describe("analysis cache: image hash + model + prompt version (Task 9 verifies Task 3)", () => {
  it("the same pixels with the same model and prompt → ONE model call; the second analysis is a cache hit", async () => {
    const cache = new Map<string, CachedAnalysis>();
    const deps = photoDeps(cache);
    await analyzeModule.analyzePhoto(PHOTO_ID, deps);
    await analyzeModule.analyzePhoto(PHOTO_ID, deps);
    expect(deps.transport.parse).toHaveBeenCalledTimes(1);
    expect(deps.getCached).toHaveBeenLastCalledWith({ userId: USER, imageSha256: SHA, model: "claude-sonnet-5-5", promptVersion: PHOTO_PROMPT_VERSION });
  });

  it("a new prompt version or another model is a cache MISS (analysed again)", async () => {
    const cache = new Map<string, CachedAnalysis>();
    cache.set(`${USER}|${SHA}|claude-sonnet-5-5|photo-insight-0-old`, { analysis: VISION } as unknown as CachedAnalysis);
    cache.set(`${USER}|${SHA}|claude-opus-5-5|${PHOTO_PROMPT_VERSION}`, { analysis: VISION } as unknown as CachedAnalysis);
    const deps = photoDeps(cache);
    await analyzeModule.analyzePhoto(PHOTO_ID, deps);
    expect(deps.transport.parse).toHaveBeenCalledTimes(1);
  });
});

describe("rewriting text never repeats photo analysis (Task 9)", () => {
  it("rewriteNarrativeBlock reads the stored analyses (listVision) and makes ONE rewriter call — analyzePhoto is never called", async () => {
    const w = world();
    const plan = await planStory(BOOK, { ...w.deps, mode: "off" });
    const storybook = (await writeStory(BOOK, plan, {}, w.deps)).storybook;
    vi.mocked(analyzeModule.analyzePhoto).mockClear();
    vi.mocked(analyzeModule.analyzePhotos).mockClear();
    w.reads.vision.mockClear();
    const before = w.requests.length;
    // story v4: the chapter story page's paragraph (no mixed pages any more)
    const target = storybook.pages.find((p) => p.kind === "chapter_opener")!.blocks[0]!;
    await rewriteNarrativeBlock(`${BOOK}/${target.id}`, { kind: "shorter" }, {}, w.deps);
    expect(w.requests.slice(before).map((r) => r.agent)).toEqual(["rewriter"]);
    expect(w.reads.vision).toHaveBeenCalled();
    expect(analyzeModule.analyzePhoto).not.toHaveBeenCalled();
    expect(analyzeModule.analyzePhotos).not.toHaveBeenCalled();
    // and the rewrite is metered as its own operation
    expect(w.usage.at(-1)).toMatchObject({ kind: "rewrite", status: "ok" });
  });
});

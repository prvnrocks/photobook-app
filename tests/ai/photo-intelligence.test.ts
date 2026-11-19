import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The service is exercised through its injectable deps; the real DB modules are never loaded.
vi.mock("@/lib/db/photo-analyses", () => ({
  loadOwnPhoto: vi.fn(async () => null),
  getCachedAnalysis: vi.fn(async () => null),
  recordAnalysisCall: vi.fn(async () => {}),
  countAnalysedPhotos: vi.fn(async () => 0),
  getTodayPhotoAnalysisSpendUsd: vi.fn(async () => 0),
}));
vi.mock("@/lib/db/photo-ingest", () => ({ listRejectedPhotoIds: vi.fn(async () => new Set()) }));
vi.mock("@/lib/db/photos", () => ({ loadThumbBase64: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ai/budget", () => ({ checkDailyAiBudget: vi.fn(async () => ({ allowed: true, reason: "no_budget" })) }));

import { PRICING } from "@/lib/ai/client";
import { costUsd } from "@/lib/ai/cost";
import { analyzePhoto, analyzePhotos, PhotoIntelligenceError, toPhotoAnalysis, type PhotoIntelligenceDeps } from "@/lib/ai/photo-intelligence/analyze";
import { PHOTO_AI_DEFAULTS, PHOTO_MODELS, readPhotoAiConfig, type PhotoAiConfig } from "@/lib/ai/photo-intelligence/config";
import { PHOTO_PROMPT_VERSION, PHOTO_SYSTEM_PROMPT, PhotoInsightAiSchema, PhotoInsightStrictSchema, photoInsightLogOutput } from "@/lib/ai/photo-intelligence/prompt";
import { TransportError, type AgentRequest, type AgentResponse, type AgentTransport } from "@/lib/ai/transport";
import type { CacheKey, CallRecord, OwnPhoto } from "@/lib/db/photo-analyses";
import { PhotoAnalysisSchema, PhotoVisionSchema } from "@/lib/storybook/schemas";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const B64 = Buffer.from("fake-jpeg-bytes-1").toString("base64");
const SHA = createHash("sha256").update(Buffer.from(B64, "base64")).digest("hex");

const CONFIG: PhotoAiConfig = { model: "claude-opus-5-5", modelFallback: false, concurrency: 2, timeoutMs: 30_000, retries: 2 };

const GOOD = {
  description: "Two people walk along a beach at sunset.",
  scene: "group",
  objects: ["beach", "sea", "Sun hat", "beach"],
  activities: ["walking on a beach"],
  peopleCount: 2,
  storyRole: "establishing",
  atmosphere: "calm",
};

const photo = (over: Partial<OwnPhoto> = {}): OwnPhoto => ({
  id: pid(1),
  user_id: USER,
  book_id: BOOK,
  upload_state: "ready",
  thumb_path: `${USER}/${BOOK}/${pid(1)}-thumb.jpg`,
  width: 4000,
  height: 3000,
  taken_at: "2026-10-12T14:00:00+04:00",
  date_source: "exif",
  lat: 24.47,
  lng: 54.33,
  place: "Abu Dhabi",
  blur_score: 140,
  dup_group: null,
  color: "#a0b0c0",
  ai: null,
  status: "kept",
  drop_reason: null,
  user_override: false,
  bookIsPaid: false,
  ...over,
});

type Answer = Partial<AgentResponse<unknown>> | Error;

function world(over: Partial<PhotoIntelligenceDeps> & { answers?: Answer[]; photos?: Record<string, OwnPhoto | null>; cache?: Map<string, unknown> } = {}) {
  const requests: AgentRequest<unknown>[] = [];
  const records: CallRecord[] = [];
  const keys: CacheKey[] = [];
  const cache = over.cache ?? new Map<string, unknown>();
  const answers = [...(over.answers ?? [])];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport: AgentTransport = {
    kind: "live",
    async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
      requests.push(req as AgentRequest<unknown>);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const a = answers.length ? answers.shift()! : {};
      if (a instanceof Error) throw a;
      return {
        parsed: (a.parsed === undefined ? GOOD : a.parsed) as T | null,
        stopReason: a.stopReason === undefined ? "end_turn" : a.stopReason,
        stopCategory: a.stopCategory ?? null,
        usage: a.usage ?? { input: 900, output: 150, cacheRead: 600, cacheWrite: 0 },
        model: a.model ?? req.model ?? "claude-opus-5-5",
        latencyMs: a.latencyMs ?? 1234,
      };
    },
  };
  const photos = over.photos ?? { [pid(1)]: photo() };
  const k = (key: CacheKey) => `${key.userId}|${key.imageSha256}|${key.model}|${key.promptVersion}`;
  const deps: PhotoIntelligenceDeps = {
    loadPhoto: async (id) => photos[id] ?? null,
    isRejected: async () => false,
    loadAiCopy: vi.fn(async () => B64),
    getCached: async (key) => {
      keys.push(key);
      const hit = cache.get(k(key));
      return hit ? { analysis: hit, model: key.model, promptVersion: key.promptVersion } : null;
    },
    record: async (rec) => {
      records.push(rec);
      if (rec.status === "ok") cache.set(k({ userId: rec.userId, imageSha256: rec.imageSha256, model: rec.model, promptVersion: rec.promptVersion }), rec.analysis);
    },
    countAnalysed: async () => 0,
    budgetExhausted: async () => false,
    mode: "live",
    transport,
    config: CONFIG,
    sleep: async () => {},
    ...over,
  };
  return { deps, requests, records, keys, cache, stats: () => ({ maxInFlight }) };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof PhotoIntelligenceError ? e.code : `other:${String(e)}`;
  }
};

let logs: unknown[][];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a));
});
afterEach(() => vi.restoreAllMocks());

describe("photo intelligence: configuration", () => {
  it("defaults", () => {
    // Task 9: photo descriptions default to the smaller model
    expect(readPhotoAiConfig({})).toEqual({ model: "claude-sonnet-5-5", modelFallback: false, ...PHOTO_AI_DEFAULTS });
  });

  it("reads model, concurrency, timeout and retries from the environment, clamped to safe bounds", () => {
    expect(readPhotoAiConfig({ AI_PHOTO_MODEL: " claude-sonnet-5-5 ", AI_PHOTO_CONCURRENCY: "6", AI_PHOTO_TIMEOUT_MS: "45000", AI_PHOTO_MAX_RETRIES: "0" })).toEqual({
      model: "claude-sonnet-5-5",
      modelFallback: false,
      concurrency: 6,
      timeoutMs: 45_000,
      retries: 0,
    });
    expect(readPhotoAiConfig({ AI_PHOTO_CONCURRENCY: "500", AI_PHOTO_TIMEOUT_MS: "1", AI_PHOTO_MAX_RETRIES: "99" })).toMatchObject({ concurrency: 8, timeoutMs: 5_000, retries: 4 });
    expect(readPhotoAiConfig({ AI_PHOTO_CONCURRENCY: "0" }).concurrency).toBe(1);
    for (const bad of ["-3", "abc", "1e9", "", "4.5", " "]) expect(readPhotoAiConfig({ AI_PHOTO_CONCURRENCY: bad }).concurrency).toBe(PHOTO_AI_DEFAULTS.concurrency);
  });

  it("an unknown model falls back to the default and says so; every selectable model has a price", () => {
    expect(readPhotoAiConfig({ AI_PHOTO_MODEL: "gpt-4o" })).toMatchObject({ model: "claude-sonnet-5-5", modelFallback: true });
    expect(readPhotoAiConfig({ AI_PHOTO_MODEL: "claude-haiku-5-5" })).toMatchObject({ model: "claude-sonnet-5-5", modelFallback: true });
    expect(readPhotoAiConfig({ AI_PHOTO_MODEL: "claude-opus-5-5" })).toMatchObject({ model: "claude-opus-5-5", modelFallback: false });
    for (const m of PHOTO_MODELS) expect(PRICING[m], m).toBeDefined();
  });
});

describe("photo intelligence: prompt and schemas", () => {
  it("the prompt forbids names, relationships, places, dates, feelings and personal attributes", () => {
    for (const rule of ["names of people", "who they are to each other", "where the photo was taken", "when it was taken", "what people feel or think", "age, ethnicity"]) {
      expect(PHOTO_SYSTEM_PROMPT, rule).toContain(rule);
    }
    expect(PHOTO_SYSTEM_PROMPT).toContain("your interpretation");
    expect(PHOTO_PROMPT_VERSION).toMatch(/^photo-insight-\d+$/);
  });

  it("the prompt is static: no ids, dates or per-photo text (so it caches and never carries user data)", () => {
    expect(PHOTO_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(PHOTO_SYSTEM_PROMPT).not.toContain("${");
  });

  it("the model is given NO field for names, relationships, dates, locations or memories", () => {
    const fields = Object.keys(PhotoInsightAiSchema.shape).sort();
    expect(fields).toEqual(["activities", "atmosphere", "description", "objects", "peopleCount", "scene", "storyRole"]);
    expect(Object.keys(PhotoVisionSchema.shape)).not.toEqual(expect.arrayContaining(["place", "takenAt", "names", "people", "location", "date"]));
  });

  it("the strict schema trims, lowercases, de-duplicates and bounds what the model returned", () => {
    const r = PhotoInsightStrictSchema.parse({
      ...GOOD,
      description: `  ${"word ".repeat(100)} `,
      objects: Array.from({ length: 30 }, (_, i) => ` Thing ${i % 20} `),
      activities: ["Walking", "walking", "", "x".repeat(200), "a", "b", "c", "d", "e"],
    });
    expect(r.description.length).toBeLessThanOrEqual(200);
    expect(r.objects).toHaveLength(12);
    expect(r.objects[0]).toBe("thing 0");
    expect(r.activities).toHaveLength(6);
    expect(r.activities[0]).toBe("walking");
    expect(r.activities[1]!.length).toBeLessThanOrEqual(60);
  });

  it("rejects out-of-range and unknown values", () => {
    expect(PhotoInsightStrictSchema.safeParse({ ...GOOD, peopleCount: 2.5 }).success).toBe(false);
    expect(PhotoInsightStrictSchema.safeParse({ ...GOOD, peopleCount: -1 }).success).toBe(false);
    expect(PhotoInsightStrictSchema.safeParse({ ...GOOD, scene: "wedding" }).success).toBe(false);
    expect(PhotoInsightStrictSchema.safeParse({ ...GOOD, storyRole: "hero" }).success).toBe(false);
    expect(PhotoInsightStrictSchema.safeParse({ ...GOOD, atmosphere: "ecstatic" }).success).toBe(false);
    expect(PhotoInsightStrictSchema.safeParse({ ...GOOD, description: "   " }).success).toBe(false);
  });

  it("the log projection holds enums and counts only", () => {
    const out = JSON.stringify(photoInsightLogOutput(PhotoInsightStrictSchema.parse(GOOD)));
    expect(out).not.toContain("beach");
    expect(out).not.toContain("Two people");
    expect(JSON.parse(out)).toEqual({ scene: "group", storyRole: "establishing", atmosphere: "calm", peopleCount: 2, objects: 3, activities: 1 });
  });
});

describe("analyzePhoto", () => {
  it("returns a valid PhotoAnalysis: vision from the model, dates / GPS / place / size from the photo row", async () => {
    const w = world();
    const a = await analyzePhoto(pid(1), w.deps);
    expect(PhotoAnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.vision).toEqual({
      description: "Two people walk along a beach at sunset.",
      scene: "group",
      objects: ["beach", "sea", "sun hat"],
      activities: ["walking on a beach"],
      peopleCount: 2,
      orientation: "landscape",
      storyRole: "establishing",
      atmosphere: { label: "calm", interpretation: true },
      model: "claude-opus-5-5",
      promptVersion: PHOTO_PROMPT_VERSION,
    });
    expect(a).toMatchObject({ photoId: pid(1), takenAt: "2026-10-12T10:00:00.000Z", dateSource: "exif", place: "Abu Dhabi", hasGps: true, orientation: "landscape", keep: true });
    expect(JSON.stringify(a)).not.toContain("24.47"); // coordinates never leave the row
  });

  it("sends ONE image — the validated AI copy — with the configured model, timeout, low effort and a cached static prompt", async () => {
    const w = world({ config: { ...CONFIG, model: "claude-sonnet-5-5", timeoutMs: 12_345 } });
    await analyzePhoto(pid(1), w.deps);
    expect(w.requests).toHaveLength(1);
    const req = w.requests[0]!;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.timeoutMs).toBe(12_345);
    expect(req.effort).toBe("low");
    expect(req.system).toEqual([{ type: "text", text: PHOTO_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    const content = req.messages[0]!.content as { type: string; source?: { media_type: string; data: string }; text?: string }[];
    expect(content.filter((c) => c.type === "image")).toHaveLength(1);
    expect(content[0]!.source).toEqual({ type: "base64", media_type: "image/jpeg", data: B64 });
    expect(w.deps.loadAiCopy).toHaveBeenCalledWith(`${USER}/${BOOK}/${pid(1)}-thumb.jpg`);
    // the request carries no metadata about the photo: no date, place, coordinates, ids or file names
    const text = JSON.stringify({ system: req.system, text: content.filter((c) => c.type === "text") });
    for (const leak of ["Abu Dhabi", "2026-10", "24.47", "54.33", pid(1), USER, BOOK, "thumb"]) expect(text, leak).not.toContain(leak);
  });

  it("stores token usage, model, prompt version, latency and estimated cost of the call", async () => {
    const w = world();
    await analyzePhoto(pid(1), w.deps);
    expect(w.records).toHaveLength(1);
    const usage = { input: 900, output: 150, cacheRead: 600, cacheWrite: 0 };
    expect(w.records[0]).toMatchObject({
      status: "ok",
      userId: USER,
      bookId: BOOK,
      photoId: pid(1),
      imageSha256: SHA,
      model: "claude-opus-5-5",
      promptVersion: PHOTO_PROMPT_VERSION,
      mode: "live",
      usage,
      latencyMs: 1234,
      costUsd: costUsd("claude-opus-5-5", usage),
    });
    expect(w.records[0]!.costUsd).toBeGreaterThan(0);
  });

  it("cache: the second call for the same image, model and prompt makes no model call and stores nothing", async () => {
    const w = world();
    const first = await analyzePhoto(pid(1), w.deps);
    const second = await analyzePhoto(pid(1), w.deps);
    expect(w.requests).toHaveLength(1);
    expect(w.records).toHaveLength(1);
    expect(second).toEqual(first);
    expect(w.keys[0]).toEqual({ userId: USER, imageSha256: SHA, model: "claude-opus-5-5", promptVersion: PHOTO_PROMPT_VERSION });
  });

  it("cache: the same pixels in another photo of the same user reuse the analysis but keep that photo's own metadata", async () => {
    const other = photo({ id: pid(2), width: 3000, height: 4000, place: null, lat: null, lng: null, taken_at: null, date_source: null });
    const w = world({ photos: { [pid(1)]: photo(), [pid(2)]: other } });
    await analyzePhoto(pid(1), w.deps);
    const b = await analyzePhoto(pid(2), w.deps);
    expect(w.requests).toHaveLength(1);
    expect(b).toMatchObject({ photoId: pid(2), orientation: "portrait", place: null, hasGps: false, takenAt: null });
    expect(b.vision!.orientation).toBe("portrait");
  });

  it("cache: a different model, prompt version or user is a different key", async () => {
    const w = world();
    await analyzePhoto(pid(1), w.deps);
    await analyzePhoto(pid(1), { ...w.deps, config: { ...CONFIG, model: "claude-sonnet-5-5" } });
    expect(w.requests).toHaveLength(2);
    const stranger = photo({ user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    await analyzePhoto(pid(1), { ...w.deps, loadPhoto: async () => stranger });
    expect(w.requests).toHaveLength(3); // never served from another user's row
    expect(new Set(w.keys.map((k) => `${k.userId}|${k.model}`)).size).toBe(3);
  });

  it("cache: an unreadable cached row is ignored and the photo is analysed again", async () => {
    const cache = new Map<string, unknown>([[`${USER}|${SHA}|claude-opus-5-5|${PHOTO_PROMPT_VERSION}`, { scene: "group" }]]);
    const w = world({ cache });
    const a = await analyzePhoto(pid(1), w.deps);
    expect(w.requests).toHaveLength(1);
    expect(a.vision!.description).toContain("beach");
  });

  it("concurrent calls for the same key share one model call", async () => {
    const w = world();
    const [a, b, c] = await Promise.all([analyzePhoto(pid(1), w.deps), analyzePhoto(pid(1), w.deps), analyzePhoto(pid(1), w.deps)]);
    expect(w.requests).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("access: a missing photo, another user's photo and a malformed id are all 'not_found' — nothing is loaded or sent", async () => {
    const w = world({ photos: {} });
    for (const id of [pid(9), "not-a-uuid", "", "../../etc/passwd"]) expect(await codeOf(analyzePhoto(id, w.deps))).toBe("not_found");
    expect(w.deps.loadAiCopy).not.toHaveBeenCalled();
    expect(w.requests).toHaveLength(0);
  });

  it("refuses unfinished uploads, rejected photos, AI off and a missing / invalid AI copy — without a model call", async () => {
    const w1 = world({ photos: { [pid(1)]: photo({ upload_state: "pending" }) } });
    expect(await codeOf(analyzePhoto(pid(1), w1.deps))).toBe("not_ready");
    const w2 = world({ photos: { [pid(1)]: photo({ thumb_path: null }) } });
    expect(await codeOf(analyzePhoto(pid(1), w2.deps))).toBe("not_ready");
    const w3 = world({ isRejected: async () => true });
    expect(await codeOf(analyzePhoto(pid(1), w3.deps))).toBe("rejected");
    const w4 = world({ mode: "off" });
    expect(await codeOf(analyzePhoto(pid(1), w4.deps))).toBe("ai_off");
    const w5 = world({ loadAiCopy: vi.fn(async () => null) });
    expect(await codeOf(analyzePhoto(pid(1), w5.deps))).toBe("no_ai_copy");
    for (const w of [w1, w2, w3, w4, w5]) expect(w.requests).toHaveLength(0);
    expect(w3.deps.loadAiCopy).not.toHaveBeenCalled(); // a rejected photo's bytes are not even read
    expect(w4.deps.loadAiCopy).not.toHaveBeenCalled();
  });

  it("limits are enforced BEFORE the call: analysed-photos limit per book (free 150 / paid 500) and the daily budget", async () => {
    const free = world({ countAnalysed: async () => 150 });
    expect(await codeOf(analyzePhoto(pid(1), free.deps))).toBe("limit_reached");
    const paid = world({ countAnalysed: async () => 150, photos: { [pid(1)]: photo({ bookIsPaid: true }) } });
    expect(await codeOf(analyzePhoto(pid(1), paid.deps))).toBe("resolved");
    const paidFull = world({ countAnalysed: async () => 500, photos: { [pid(1)]: photo({ bookIsPaid: true }) } });
    expect(await codeOf(analyzePhoto(pid(1), paidFull.deps))).toBe("limit_reached");
    const broke = world({ budgetExhausted: async () => true });
    expect(await codeOf(analyzePhoto(pid(1), broke.deps))).toBe("budget_exhausted");
    for (const w of [free, paidFull, broke]) {
      expect(w.requests).toHaveLength(0);
      expect(w.records).toHaveLength(0);
    }
  });

  it("a cached analysis is still served when the limit or the budget is used up (it costs nothing)", async () => {
    const w = world();
    await analyzePhoto(pid(1), w.deps);
    const again = await analyzePhoto(pid(1), { ...w.deps, countAnalysed: async () => 9999, budgetExhausted: async () => true });
    expect(again.vision).toBeDefined();
    expect(w.requests).toHaveLength(1);
  });

  it("live calls are refused while the cache table is missing; replay still works and records nothing", async () => {
    const live = world({ getCached: async () => "unavailable" });
    expect(await codeOf(analyzePhoto(pid(1), live.deps))).toBe("cache_unavailable");
    expect(live.requests).toHaveLength(0);
    const replay = world({ getCached: async () => "unavailable", mode: "replay" });
    expect((await analyzePhoto(pid(1), replay.deps)).vision).toBeDefined();
    expect(replay.records).toHaveLength(0);
  });

  it("retries rate limits, 5xx and timeouts with backoff, up to the configured number", async () => {
    const sleeps: number[] = [];
    const w = world({
      answers: [new TransportError("rate_limited", "429", { status: 429 }), new TransportError("timeout", "timed out"), {}],
      sleep: async (ms) => void sleeps.push(ms),
    });
    const a = await analyzePhoto(pid(1), w.deps);
    expect(a.vision).toBeDefined();
    expect(w.requests).toHaveLength(3);
    expect(sleeps).toEqual([1000, 3000]);
    expect(w.records).toHaveLength(1);
  });

  it("gives up after the configured retries: retryable model_error, an error row, no analysis cached", async () => {
    const w = world({ answers: [new TransportError("server_error", "529", { status: 529 }), new TransportError("server_error", "529", { status: 529 })], config: { ...CONFIG, retries: 1 } });
    const err = await analyzePhoto(pid(1), w.deps).catch((e: unknown) => e as PhotoIntelligenceError);
    expect(err).toBeInstanceOf(PhotoIntelligenceError);
    expect(err).toMatchObject({ code: "model_error", detail: "server_error", retryable: true });
    expect(w.requests).toHaveLength(2);
    expect(w.records).toEqual([expect.objectContaining({ status: "error", error: "server_error", costUsd: 0 })]);
    expect(w.cache.size).toBe(0);
  });

  it("does not retry a bad request or an auth failure", async () => {
    for (const code of ["bad_request", "auth"] as const) {
      const w = world({ answers: [new TransportError(code, "nope", { status: 400 })] });
      const err = await analyzePhoto(pid(1), w.deps).catch((e: unknown) => e as PhotoIntelligenceError);
      expect(err).toMatchObject({ code: "model_error", detail: code, retryable: false });
      expect(w.requests).toHaveLength(1);
    }
  });

  it("a refusal is 'refused': its tokens are still recorded, nothing is cached, and it is not retried", async () => {
    const usage = { input: 880, output: 20, cacheRead: 0, cacheWrite: 0 };
    const w = world({ answers: [{ parsed: null, stopReason: "refusal", stopCategory: "general_harms", usage }] });
    expect(await codeOf(analyzePhoto(pid(1), w.deps))).toBe("refused");
    expect(w.requests).toHaveLength(1);
    expect(w.records).toEqual([expect.objectContaining({ status: "error", error: "refusal", usage, costUsd: costUsd("claude-opus-5-5", usage) })]);
    expect(w.cache.size).toBe(0);
  });

  it("truncated, unparsable and schema-invalid outputs are model errors, never a partial analysis", async () => {
    const cases: [Answer, string][] = [
      [{ parsed: null, stopReason: "max_tokens" }, "max_tokens"],
      [{ parsed: null }, "parse_failed"],
      [{ parsed: { ...GOOD, scene: "castle" } }, "schema_invalid"],
      [{ parsed: { ...GOOD, peopleCount: "two" } }, "schema_invalid"],
      [{ parsed: { names: ["Aisha"], location: "Dubai" } }, "schema_invalid"],
    ];
    for (const [answer, detail] of cases) {
      const w = world({ answers: [answer] });
      const err = await analyzePhoto(pid(1), w.deps).catch((e: unknown) => e as PhotoIntelligenceError);
      expect(err, detail).toMatchObject({ code: "model_error", detail });
      expect(w.cache.size).toBe(0);
      expect(w.records[0]).toMatchObject({ status: "error" });
    }
  });

  it("extra fields the model adds (a name, a place, a date) never reach the result", async () => {
    const w = world({ answers: [{ parsed: { ...GOOD, personName: "Aisha", location: "Dubai Marina", date: "2021-05-01", relationship: "sisters" } }] });
    const a = await analyzePhoto(pid(1), w.deps);
    const out = JSON.stringify(a);
    for (const leak of ["Aisha", "Dubai Marina", "2021-05-01", "sisters"]) expect(out).not.toContain(leak);
    expect(a.place).toBe("Abu Dhabi"); // from the row
  });

  it("a storage failure while recording does not lose the analysis and logs a code only", async () => {
    const w = world({ record: async () => Promise.reject(new Error(`db down for ${USER}/${BOOK}`)) });
    const a = await analyzePhoto(pid(1), w.deps);
    expect(a.vision).toBeDefined();
    expect(JSON.stringify(logs)).toContain("record_failed");
    expect(JSON.stringify(logs)).not.toContain(USER);
  });

  it("never logs images, paths, descriptions or metadata — on success or on failure", async () => {
    const ok = world();
    await analyzePhoto(pid(1), ok.deps);
    const bad = world({ answers: [{ parsed: null, stopReason: "refusal" }] });
    const err = await analyzePhoto(pid(1), bad.deps).catch((e: unknown) => e as Error);
    const all = JSON.stringify(logs) + String((err as Error).message) + String((err as Error).stack);
    for (const leak of [B64, "beach", "Abu Dhabi", "thumb.jpg", USER, "24.47", "2026-10-12"]) expect(all, leak).not.toContain(leak);
  });

  it("replay mode: deterministic, schema-valid, recorded with zero cost — no API key and no network needed", async () => {
    const w = world({ mode: "replay", transport: undefined });
    const a = await analyzePhoto(pid(1), w.deps);
    const b = await analyzePhoto(pid(1), { ...w.deps, getCached: async () => null });
    expect(PhotoAnalysisSchema.safeParse(a).success).toBe(true);
    expect(b.vision).toEqual(a.vision);
    expect(a.vision!.atmosphere.interpretation).toBe(true);
    expect(w.records[0]).toMatchObject({ status: "ok", mode: "replay", costUsd: 0 });
  });
});

describe("toPhotoAnalysis: metadata handling", () => {
  const vision = PhotoVisionSchema.parse({
    description: "A cake on a table.",
    scene: "food",
    objects: ["cake"],
    activities: [],
    peopleCount: 0,
    orientation: "square",
    storyRole: "detail",
    atmosphere: { label: "joyful", interpretation: true },
    model: "claude-opus-5-5",
    promptVersion: PHOTO_PROMPT_VERSION,
  });

  it("missing or broken metadata becomes null, never a guess", () => {
    const a = toPhotoAnalysis(photo({ taken_at: "not a date", date_source: "guess", place: "   ", lat: 24.4, lng: null, width: null, height: null, blur_score: -1, color: "red", dup_group: -4 }), vision);
    expect(a).toMatchObject({ takenAt: null, dateSource: null, place: null, hasGps: false, orientation: "square", aspect: 1, blurScore: null, color: null, dupGroup: null });
    expect(PhotoAnalysisSchema.safeParse(a).success).toBe(true);
  });

  it("long places are clipped; drop reasons map to the known set; the user's removal is kept", () => {
    const long = toPhotoAnalysis(photo({ place: "P".repeat(120) }), vision);
    expect(long.place!.length).toBeLessThanOrEqual(80);
    expect(toPhotoAnalysis(photo({ status: "dropped", drop_reason: "blurry" }), vision).dropReason).toBe("blurry");
    expect(toPhotoAnalysis(photo({ status: "dropped", drop_reason: "user_removed", user_override: true }), vision).dropReason).toBe("user_removed");
    const odd = toPhotoAnalysis(photo({ status: "dropped", drop_reason: "something new" }), vision);
    expect(odd).toMatchObject({ keep: false, dropReason: "other" });
    expect(toPhotoAnalysis(photo({ status: "kept", drop_reason: "blurry" }), vision).dropReason).toBeNull();
    for (const a of [long, odd]) expect(PhotoAnalysisSchema.safeParse(a).success).toBe(true);
  });

  it("Curator notes on the row are carried over when valid and dropped when not", () => {
    const notes = { v: 3, description: "A cake.", scene: "food", peopleCount: 0, mood: "joyful", quality: 7, coverWorthy: false };
    expect(toPhotoAnalysis(photo({ ai: notes }), vision).ai).toEqual({ description: "A cake.", scene: "food", peopleCount: 0, mood: "joyful", quality: 7, coverWorthy: false });
    expect(toPhotoAnalysis(photo({ ai: { scene: "castle" } }), vision).ai).toBeNull();
    expect(toPhotoAnalysis(photo({ ai: "x" }), vision).ai).toBeNull();
  });
});

describe("analyzePhotos", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [pid(i + 1), photo({ id: pid(i + 1), thumb_path: `${USER}/${BOOK}/${pid(i + 1)}-thumb.jpg` })]));
  const distinctCopies = () => vi.fn(async (path: string) => Buffer.from(`bytes:${path}`).toString("base64"));

  it("never runs more than the configured number of model calls at once and keeps input order", async () => {
    const w = world({ photos: many(9), loadAiCopy: distinctCopies(), config: { ...CONFIG, concurrency: 3 } });
    const ids = Array.from({ length: 9 }, (_, i) => pid(i + 1));
    const out = await analyzePhotos(ids, w.deps);
    expect(out.map((r) => r.photoId)).toEqual(ids);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(w.requests).toHaveLength(9);
    expect(w.stats().maxInFlight).toBeLessThanOrEqual(3);
    expect(w.stats().maxInFlight).toBeGreaterThan(1);
  });

  it("one failing photo does not fail the others", async () => {
    const photos = { ...many(3), [pid(2)]: null };
    const w = world({ photos, loadAiCopy: distinctCopies(), config: { ...CONFIG, concurrency: 1 } });
    const out = await analyzePhotos([pid(1), pid(2), pid(3)], w.deps);
    expect(out.map((r) => (r.ok ? "ok" : r.error))).toEqual(["ok", "not_found", "ok"]);
  });

  it("stops starting new calls once the daily budget is used up", async () => {
    let calls = 0;
    const w = world({ photos: many(5), loadAiCopy: distinctCopies(), config: { ...CONFIG, concurrency: 1 }, budgetExhausted: async () => ++calls > 2 });
    const out = await analyzePhotos([1, 2, 3, 4, 5].map(pid), w.deps);
    expect(out.map((r) => (r.ok ? "ok" : r.error))).toEqual(["ok", "ok", "budget_exhausted", "budget_exhausted", "budget_exhausted"]);
    expect(w.requests).toHaveLength(2);
  });

  it("an empty list is fine", async () => {
    expect(await analyzePhotos([], world().deps)).toEqual([]);
  });
});

// Perf fix (story-export-readiness): analyzePhotos makes the reads that are the same for every photo
// of a batch ONCE (photo rows, the book's rejected ids, AI copies, cache lookups). These tests prove
// it changes nothing: same results, same photo_analyses rows, same ledger events, same model calls.
describe("analyzePhotos: per-batch reads give the same results as photo-by-photo", () => {
  type Rec = { kind: string; arg?: unknown };
  const copyOf = (n: number) => Buffer.from(`bytes:${n}`).toString("base64");
  const pathOf = (n: number) => `${USER}/${BOOK}/${pid(n)}-thumb.jpg`;

  /** One shared fake database + the two ways of reading it (single-photo deps vs bulk deps). */
  function fakeDb(opts: { cachedPhotos?: number[]; overSpendCap?: (spent: number) => boolean; costPerCall?: number } = {}) {
    const rows: Record<string, OwnPhoto> = {};
    const add = (n: number, over: Partial<OwnPhoto> = {}) => (rows[pid(n)] = photo({ id: pid(n), thumb_path: pathOf(n), ...over }));
    add(1);
    add(2); // cached before the batch
    add(3, { upload_state: "pending" }); // not ready
    add(4); // rejected by ingestion
    // pid(5): missing / someone else's
    add(6, { thumb_path: pathOf(1) }); // the SAME image as photo 1 (one model call, then a cache hit)
    add(7); // no valid AI copy
    add(8);
    add(9);
    const rejected = new Set([pid(4)]);
    const copies = new Map<string, string>([1, 2, 3, 4, 8, 9].map((n) => [pathOf(n), copyOf(n)]));
    const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
    const cache = new Map<string, unknown>();
    const k = (key: { userId: string; imageSha256: string; model: string; promptVersion: string }) => `${key.userId}|${key.imageSha256}|${key.model}|${key.promptVersion}`;
    for (const n of opts.cachedPhotos ?? [2]) cache.set(k({ userId: USER, imageSha256: sha(copyOf(n)), model: CONFIG.model, promptVersion: PHOTO_PROMPT_VERSION }), { ...GOOD, scene: "landscape", orientation: "landscape", atmosphere: { label: "calm", interpretation: true }, model: CONFIG.model, promptVersion: PHOTO_PROMPT_VERSION });
    const log: Rec[] = [];
    const records: CallRecord[] = [];
    const ledger: unknown[] = [];
    let spent = 0;
    const requests: string[] = [];
    const transport: AgentTransport = {
      kind: "live",
      async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
        requests.push(String(req.scenarioMeta?.seed));
        log.push({ kind: "call" });
        await new Promise((r) => setTimeout(r, 1));
        return { parsed: GOOD as T, stopReason: "end_turn", stopCategory: null, usage: { input: 900, output: 150, cacheRead: 600, cacheWrite: 0 }, model: req.model ?? CONFIG.model, latencyMs: 1234 };
      },
    };
    const shared: PhotoIntelligenceDeps = {
      record: async (rec) => {
        records.push(rec);
        if (rec.status === "ok") cache.set(k(rec), rec.analysis);
      },
      meter: {
        record: async (ev) => {
          ledger.push(ev);
          spent += ev.costUsd;
        },
      },
      countAnalysed: async () => 0,
      budgetExhausted: async () => false,
      overSpendCap: async () => {
        const over = opts.overSpendCap ? opts.overSpendCap(spent) : false;
        log.push({ kind: over ? "cap:over" : "cap:ok" });
        return over;
      },
      mode: "live",
      transport,
      config: CONFIG,
      now: () => 0,
      sleep: async () => {},
    };
    const single: PhotoIntelligenceDeps = {
      ...shared,
      loadPhoto: async (id) => rows[id] ?? null,
      isRejected: async (p) => rejected.has(p.id),
      loadAiCopy: async (path) => copies.get(path) ?? null,
      getCached: async (key) => {
        const hit = cache.get(k(key));
        return hit ? { analysis: hit, model: key.model, promptVersion: key.promptVersion } : null;
      },
    };
    const calls = { loadPhotos: 0, listRejected: 0, loadAiCopies: 0, getCachedMany: 0 };
    const bulk: PhotoIntelligenceDeps = {
      ...shared,
      loadPhotos: async (ids) => {
        calls.loadPhotos++;
        return new Map(ids.filter((id) => rows[id]).map((id) => [id, rows[id]!]));
      },
      listRejected: async () => {
        calls.listRejected++;
        log.push({ kind: "rejected-read" });
        return new Set(rejected);
      },
      loadAiCopies: async (paths) => {
        calls.loadAiCopies++;
        return new Map(paths.filter((p) => copies.has(p)).map((p) => [p, copies.get(p)!]));
      },
      getCachedMany: async (key, shas) => {
        calls.getCachedMany++;
        const out = new Map<string, { analysis: unknown; model: string; promptVersion: string }>();
        for (const s of shas) {
          const hit = cache.get(k({ ...key, imageSha256: s }));
          if (hit) out.set(s, { analysis: hit, model: key.model, promptVersion: key.promptVersion });
        }
        return out;
      },
    };
    return { single, bulk, calls, records, ledger, requests, log, rejected, spent: () => spent };
  }

  /** The reference: every photo analysed on its own, one after another (the old per-photo reads). */
  async function photoByPhoto(ids: string[], deps: PhotoIntelligenceDeps) {
    const out: unknown[] = [];
    let stop: string | null = null;
    for (const photoId of ids) {
      if (stop) {
        out.push({ photoId, ok: false, error: stop, retryable: false });
        continue;
      }
      try {
        out.push({ photoId, ok: true, analysis: await analyzePhoto(photoId, deps) });
      } catch (e) {
        const err = e as PhotoIntelligenceError;
        if (err.code === "budget_exhausted" || err.code === "ai_off" || err.code === "cache_unavailable") stop = err.code;
        out.push({ photoId, ok: false, error: err.code, retryable: err.retryable });
      }
    }
    return out;
  }

  const IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(pid);

  it("(a) same results, photo_analyses rows, ledger events and model calls as photo-by-photo — with ONE read of each kind per batch", async () => {
    const ref = fakeDb();
    const expected = await photoByPhoto(IDS, ref.single);
    const now = fakeDb();
    const got = await analyzePhotos(IDS, { ...now.bulk, config: { ...CONFIG, concurrency: 1 } });

    expect(got).toEqual(expected);
    expect(got.map((r) => (r.ok ? "ok" : r.error))).toEqual(["ok", "ok", "not_ready", "rejected", "not_found", "ok", "no_ai_copy", "ok", "ok"]);
    expect(now.records).toEqual(ref.records);
    expect(now.ledger).toEqual(ref.ledger);
    expect(now.requests).toEqual(ref.requests);
    // photo 1, 8, 9 are new images; 2 was cached; 6 is photo 1's image → a cache hit, no second call
    expect(now.requests).toHaveLength(3);
    expect(now.records.map((r) => r.photoId)).toEqual([pid(1), pid(8), pid(9)]);
    // + a fresh rejected check before each live call; + a fresh cache look-up for photo 6 (its
    // image was analysed earlier in this batch, so the batch's read is out of date for it)
    expect(now.calls).toEqual({ loadPhotos: 1, listRejected: 1 + 3, loadAiCopies: 1, getCachedMany: 1 + 1 });
  });

  it("(a) with parallel workers the same rows and ledger events come out (order aside)", async () => {
    const ref = fakeDb();
    await photoByPhoto(IDS, ref.single);
    const now = fakeDb();
    const got = await analyzePhotos(IDS, { ...now.bulk, config: { ...CONFIG, concurrency: 4 } });
    // Which of two photos with the SAME image starts the one shared call is a race with parallel
    // workers (before and after this change), so rows / events are compared without the photo id.
    const sortBy = (xs: readonly unknown[]) =>
      xs
        .map((x) => {
          const rest = { ...(x as Record<string, unknown>) };
          delete rest.photoId;
          delete rest.runId;
          return JSON.stringify(rest);
        })
        .sort();
    expect(got.map((r) => (r.ok ? "ok" : r.error))).toEqual(["ok", "ok", "not_ready", "rejected", "not_found", "ok", "no_ai_copy", "ok", "ok"]);
    expect(sortBy(now.records)).toEqual(sortBy(ref.records));
    expect(sortBy(now.ledger)).toEqual(sortBy(ref.ledger));
    expect(now.requests).toHaveLength(3);
  });

  it("(a) a failing bulk read falls back to the single-photo read (same results)", async () => {
    const ref = fakeDb();
    const expected = await photoByPhoto(IDS, ref.single);
    const now = fakeDb();
    const broken: PhotoIntelligenceDeps = {
      ...now.bulk,
      loadPhotos: async () => {
        throw new Error("down");
      },
      // the fallbacks the batch uses when its bulk read failed
      loadPhoto: now.single.loadPhoto,
    };
    const got = await analyzePhotos(IDS, { ...broken, config: { ...CONFIG, concurrency: 1 } });
    expect(got).toEqual(expected);
    expect(now.records).toEqual(ref.records);
  });

  it("(b) the spend cap is checked before EVERY live call inside a batch: it stops at the same call as photo-by-photo, never later", async () => {
    const cost = costUsd("claude-opus-5-5", { input: 900, output: 150, cacheRead: 600, cacheWrite: 0 });
    const cap = (spent: number) => spent >= cost * 1.5; // over after the 2nd paid call
    const ids = [1, 8, 9, 2].map(pid); // three new images, then a cached one
    const ref = fakeDb({ overSpendCap: cap });
    const expected = await photoByPhoto(ids, ref.single);
    for (const concurrency of [1, 3]) {
      // the reference for parallel workers: the per-photo reads (injected single deps) with the same concurrency
      const old = fakeDb({ overSpendCap: cap });
      await analyzePhotos(ids, { ...old.single, config: { ...CONFIG, concurrency } });
      const now = fakeDb({ overSpendCap: cap });
      const got = await analyzePhotos(ids, { ...now.bulk, config: { ...CONFIG, concurrency } });
      if (concurrency === 1) {
        expect(got).toEqual(expected);
        expect(now.ledger).toEqual(ref.ledger);
      }
      expect(now.requests.length).toBeLessThanOrEqual(old.requests.length);
      expect(now.spent()).toBeLessThanOrEqual(old.spent());
      expect(now.ledger.length).toBeLessThanOrEqual(old.ledger.length);
      // every model call was preceded by its own passed cap check
      let passed = 0;
      for (const e of now.log) {
        if (e.kind === "cap:ok") passed++;
        if (e.kind === "call") expect(passed-- > 0).toBe(true);
      }
    }
    expect(expected.map((r) => ((r as { ok: boolean }).ok ? "ok" : (r as { error: string }).error))).toEqual(["ok", "ok", "budget_exhausted", "budget_exhausted"]);
    expect(ref.requests).toHaveLength(2);
  });

  it("the batch keeps its AI copies in the tick's memory, and a book hint reads the rejected ids once, alongside the photo rows", async () => {
    const db = fakeDb();
    const kept = new Map<string, string>();
    const got = await analyzePhotos(IDS, { ...db.bulk, mode: "replay", bookHint: BOOK, aiCopyCache: { get: (p) => kept.get(p), set: (p, b) => void kept.set(p, b) }, config: { ...CONFIG, concurrency: 2 } });
    expect(got.map((r) => (r.ok ? "ok" : r.error))).toEqual(["ok", "ok", "not_ready", "rejected", "not_found", "ok", "no_ai_copy", "ok", "ok"]);
    expect(db.calls.listRejected).toBe(1);
    expect([...kept.keys()].sort()).toEqual([1, 2, 8, 9].map(pathOf).sort()); // the copies read (not the rejected / not-ready ones)
    expect(kept.get(pathOf(8))).toBe(copyOf(8));
  });

  it("(c) rejected ids are read once per batch, so a photo rejected between batches is seen by the next one", async () => {
    const db = fakeDb();
    const deps = { ...db.bulk, mode: "replay" as const, config: { ...CONFIG, concurrency: 2 } };
    const first = await analyzePhotos([pid(1), pid(8)], deps);
    expect(first.every((r) => r.ok)).toBe(true);
    expect(db.calls.listRejected).toBe(1);
    db.rejected.add(pid(9)); // ingestion rejects photo 9 while the run is between batches
    const second = await analyzePhotos([pid(9), pid(2)], deps);
    expect(second.map((r) => (r.ok ? "ok" : r.error))).toEqual(["rejected", "ok"]);
    expect(db.calls.listRejected).toBe(2);
  });

  it("(c) a photo rejected WHILE its batch runs is never sent to the model (fresh check right before each live call)", async () => {
    const db = fakeDb();
    const parse = db.bulk.transport!.parse.bind(db.bulk.transport);
    const transport: AgentTransport = {
      kind: "live",
      async parse<T>(req: AgentRequest<T>) {
        db.rejected.add(pid(9)); // lands during photo 8's call
        return parse(req);
      },
    };
    const got = await analyzePhotos([pid(8), pid(9)], { ...db.bulk, transport, config: { ...CONFIG, concurrency: 1 } });
    expect(got.map((r) => (r.ok ? "ok" : r.error))).toEqual(["ok", "rejected"]);
    expect(db.requests).toHaveLength(1);
    expect(db.records.map((r) => r.photoId)).toEqual([pid(8)]);
  });
});

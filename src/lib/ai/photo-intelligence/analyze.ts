import "server-only";
// Photo Intelligence: analyzePhoto(photoId) → PhotoAnalysis.
//
//   1. load the photo with the caller's session (RLS) — someone else's photo does not exist
//   2. take the AI analysis copy (512 px JPEG, validated + metadata stripped by
//      loadThumbBase64 / prepareAiCopy) — never the original or the web copy
//   3. cache key = SHA-256 of those bytes + model + prompt version (+ user) → hit: no model call
//   4. miss: limits (analysed photos per book, daily AI budget) → ONE vision call through the
//      shared transport and runAgentStep (timeout, retries with backoff, stop_reason handling,
//      strict zod validation, cost) → store the result with tokens, model, latency and cost
//   5. assemble PhotoAnalysis: dates, GPS presence, place and size come from the photo row
//      (metadata / geocoding / user), never from the model
//
// What the model returns is only about visible content (prompt.ts). Nothing here logs images,
// base64, signed URLs, paths, descriptions or metadata — error codes only.

import { createHash } from "node:crypto";
import { EFFORT, resolveAiMode, type AiMode } from "@/lib/ai/client";
import { checkDailyAiBudget } from "@/lib/ai/budget";
import { isOverDailyBudget, limitsFor, readDailyBudgetUsd } from "@/lib/ai/limits";
import { runAgentStep, type AgentStepRecord, type StepLogger } from "@/lib/ai/run-step";
import { DROP_REASONS, MOODS, SCENES } from "@/lib/ai/schemas";
import { cachedSystem, type AgentTransport } from "@/lib/ai/transport";
import { getTransport } from "@/lib/ai/transport-factory";
import { ReplayTransport, type ReplaySynth } from "@/lib/ai/transport-replay";
import { listRejectedPhotoIds } from "@/lib/db/photo-ingest";
import {
  countAnalysedPhotos,
  getCachedAnalyses,
  getCachedAnalysis,
  getTodayPhotoAnalysisSpendUsd,
  loadOwnPhoto,
  loadOwnPhotos,
  recordAnalysisCall,
  type CacheKey,
  type CachedAnalysis,
  type CallRecord,
  type OwnPhoto,
} from "@/lib/db/photo-analyses";
import { loadThumbBase64 } from "@/lib/db/photos";
import { PhotoAnalysisSchema, PhotoVisionSchema, STORY_LIMITS } from "@/lib/storybook/schemas";
import type { PhotoAnalysis, PhotoVision } from "@/lib/storybook/types";
import { clipText } from "@/lib/text/clip";
import { isOverSpendCap } from "@/lib/ai/spend-caps";
import { createUsageMeter } from "@/lib/ai/usage/meter";
import type { UsageMeter } from "@/lib/ai/usage/types";
import { getEntitlementTier } from "@/lib/entitlements";
import type { AiCopyCache } from "@/lib/photos/ai-copy-cache";
import { readPhotoAiConfig, type PhotoAiConfig } from "./config";
import {
  PHOTO_MAX_TOKENS,
  PHOTO_PROMPT_VERSION,
  PHOTO_SYSTEM_PROMPT,
  PhotoInsightAiSchema,
  PhotoInsightStrictSchema,
  photoInsightLogOutput,
  type PhotoInsight,
} from "./prompt";

export const PHOTO_INTELLIGENCE_ERRORS = [
  "not_found", // missing, malformed id, or not the caller's photo
  "not_ready", // upload not finished
  "rejected", // failed server-side ingestion
  "no_ai_copy", // the analysis copy is missing or not a valid ≤ 512 px JPEG
  "ai_off", // AI mode is off
  "cache_unavailable", // migration 2400 not applied: live calls are refused
  "limit_reached", // analysed-photos limit of the book (free 150 / paid 500)
  "budget_exhausted", // daily AI budget
  "refused", // the model declined
  "model_error", // timeout / rate limit / 5xx after retries, or unusable output
  "invalid_result", // assembled analysis failed validation
] as const;
export type PhotoIntelligenceErrorCode = (typeof PHOTO_INTELLIGENCE_ERRORS)[number];

/** `message` is the code plus an optional sub-code — never ids, paths or content. */
export class PhotoIntelligenceError extends Error {
  constructor(
    public readonly code: PhotoIntelligenceErrorCode,
    public readonly detail?: string,
    /** Worth trying again later (transient model / network failure). */
    public readonly retryable = false,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PhotoIntelligenceError";
  }
}

export type PhotoIntelligenceDeps = {
  loadPhoto?: (photoId: string) => Promise<OwnPhoto | null>;
  isRejected?: (photo: OwnPhoto) => Promise<boolean>;
  /** Validated, metadata-free AI copy as base64, or null. */
  loadAiCopy?: (thumbPath: string) => Promise<string | null>;
  getCached?: (key: CacheKey) => Promise<CachedAnalysis | null | "unavailable">;
  // Bulk readers behind the per-batch memo of analyzePhotos (used when the matching single-photo
  // dep above is NOT injected; analyzePhoto alone uses them for its one photo).
  /** Several photos in one RLS read (absent = not found). Default loadOwnPhotos. */
  loadPhotos?: (photoIds: readonly string[]) => Promise<Map<string, OwnPhoto>>;
  /** Ids of the book's photos that failed server-side ingestion. Default listRejectedPhotoIds. */
  listRejected?: (bookId: string) => Promise<Set<string>>;
  /** path → validated AI copy (absent = none). Default loadThumbBase64. */
  loadAiCopies?: (thumbPaths: string[]) => Promise<Map<string, string>>;
  /** sha → stored analysis for one user / model / prompt version. Default getCachedAnalyses. */
  getCachedMany?: (key: Omit<CacheKey, "imageSha256">, imageSha256s: readonly string[]) => Promise<Map<string, CachedAnalysis> | "unavailable">;
  /** The book the batch's photos belong to (a hint: its rejected ids are read alongside the photo rows). */
  bookHint?: string;
  /** Tick-scoped memory the batch's AI copies are kept in (the quality stage of the same tick reuses them). */
  aiCopyCache?: AiCopyCache;
  record?: (rec: CallRecord) => Promise<void>;
  countAnalysed?: (bookId: string, userId: string) => Promise<number>;
  /** True when the daily AI budget is used up (pipeline spend + photo-analysis spend). */
  budgetExhausted?: () => Promise<boolean>;
  /** Task 9: true when a per-book / per-user spending cap is reached (never throws). */
  overSpendCap?: (photo: OwnPhoto) => Promise<boolean>;
  /** Task 9: usage ledger (default: ai_usage_ledger, operation photo_analysis, bucket from the entitlement). */
  meter?: UsageMeter;
  mode?: AiMode;
  transport?: AgentTransport | null;
  config?: PhotoAiConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The reads analyzePhoto makes before a model call. One photo: plain reads (`singleReaders`).
 * A batch (analyzePhotos): the same reads made ONCE for the whole batch and shared
 * (`batchReaders`) — the photo rows, the book's rejected ids, the AI copies, the cache lookups and
 * the entitlement tier are identical for every photo of a batch, so 8 photos no longer pay 8 × 5
 * sequential round trips. Results are the same: a bulk read that fails falls back to the
 * single-photo read (same errors as before), and an image seen twice in one batch is looked up
 * fresh the second time (the first may have just been analysed and cached).
 */
type Readers = {
  photo(photoId: string): Promise<OwnPhoto | null>;
  rejected(photo: OwnPhoto): Promise<boolean>;
  aiCopy(thumbPath: string): Promise<string | null>;
  cached(key: CacheKey): Promise<CachedAnalysis | null | "unavailable">;
  tier(bookId: string): Promise<"preview" | "full">;
  /**
   * Batch only: a FRESH rejected check made right before a live model call (with the limit checks,
   * no extra wait) — `rejected` is read once per batch, so a photo rejected while its batch runs is
   * still never sent. Single photos need none (their check was just made).
   */
  rejectedNow?(photo: OwnPhoto): Promise<boolean>;
};

/** Plain reads for one photo (an injected bulk reader is used with one item when its single twin isn't). */
function singleReaders(deps: PhotoIntelligenceDeps): Readers {
  const { loadPhotos, getCachedMany } = deps;
  return {
    photo: deps.loadPhoto ?? (loadPhotos ? async (id) => (await loadPhotos([id])).get(id) ?? null : loadOwnPhoto),
    rejected: deps.isRejected ?? (async (p) => (await (deps.listRejected ?? listRejectedPhotoIds)(p.book_id)).has(p.id)),
    aiCopy: deps.loadAiCopy ?? (async (path) => (await (deps.loadAiCopies ?? loadThumbBase64)([path])).get(path) ?? null),
    cached:
      deps.getCached ??
      (getCachedMany
        ? async ({ imageSha256, ...rest }) => {
            const found = await getCachedMany(rest, [imageSha256]);
            return found === "unavailable" ? found : (found.get(imageSha256) ?? null);
          }
        : getCachedAnalysis),
    tier: (bookId) => getEntitlementTier(bookId),
  };
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

/** Memo per key; a failed promise is forgotten (the next caller reads again, like before). */
function memo<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const m = new Map<string, Promise<T>>();
  return (key) => {
    let p = m.get(key);
    if (!p) {
      p = fn(key);
      m.set(key, p);
      p.catch(() => m.delete(key));
    }
    return p;
  };
}

function batchReaders(photoIds: readonly string[], deps: PhotoIntelligenceDeps, model: string): Readers {
  const single = singleReaders(deps);
  // An injected single-photo dep wins (tests): its stage then stays per photo.
  const bulkPhotos = !deps.loadPhoto;
  const photos = once(() => (deps.loadPhotos ?? loadOwnPhotos)(photoIds).catch(() => null));
  const rejectedOf = memo((bookId) => (deps.listRejected ?? listRejectedPhotoIds)(bookId));
  // Start the book's rejected ids together with the photo rows (used only for photos of that book).
  if (deps.bookHint && !deps.isRejected) rejectedOf(deps.bookHint).catch(() => undefined);
  const rejected = deps.isRejected ?? (async (p: OwnPhoto) => (await rejectedOf(p.book_id)).has(p.id));
  // AI copies of every batch photo that passes the checks analyzePhoto makes before reading one.
  const bulkCopies = bulkPhotos && !deps.isRejected && !deps.loadAiCopy;
  const copies = once(async () => {
    const rows = await photos();
    if (!rows) return null;
    const paths: string[] = [];
    for (const id of photoIds) {
      const p = rows.get(id);
      if (p && p.upload_state === "ready" && p.thumb_path && !(await rejected(p))) paths.push(p.thumb_path);
    }
    // the batch's copies in one go (≤ 8 at once instead of the default 5: one round of downloads)
    const byPath = await (deps.loadAiCopies ?? ((list: string[]) => loadThumbBase64(list, { concurrency: list.length })))(paths);
    for (const [path, b64] of byPath) deps.aiCopyCache?.set(path, b64);
    return { paths: new Set(paths), byPath, rows };
  });
  const safeCopies = once(() => copies().catch(() => null));
  const bulkCache = bulkCopies && !deps.getCached;
  const cache = once(async () => {
    const c = await safeCopies();
    if (!c) return null;
    const shasByUser = new Map<string, Set<string>>();
    for (const p of c.rows.values()) {
      const b64 = p.thumb_path && c.paths.has(p.thumb_path) ? c.byPath.get(p.thumb_path) : undefined;
      if (!b64) continue;
      const set = shasByUser.get(p.user_id) ?? new Set<string>();
      set.add(sha256Of(b64));
      shasByUser.set(p.user_id, set);
    }
    const out = new Map<string, { shas: Set<string>; found: Map<string, CachedAnalysis> | "unavailable" }>();
    await Promise.all(
      [...shasByUser].map(async ([userId, shas]) => {
        const found = await (deps.getCachedMany ?? getCachedAnalyses)({ userId, model, promptVersion: PHOTO_PROMPT_VERSION }, [...shas]);
        out.set(userId, { shas, found });
      }),
    );
    return out;
  });
  const safeCache = once(() => cache().catch(() => null));
  const seen = new Set<string>();
  const tierOf = memo((bookId) => getEntitlementTier(bookId));
  return {
    photo: async (id) => {
      if (!bulkPhotos) return single.photo(id);
      const rows = await photos();
      return rows ? (rows.get(id) ?? null) : single.photo(id);
    },
    rejected,
    aiCopy: async (path) => {
      if (!bulkCopies) return single.aiCopy(path);
      const c = await safeCopies();
      return c && c.paths.has(path) ? (c.byPath.get(path) ?? null) : single.aiCopy(path);
    },
    cached: async (key) => {
      const seenKey = `${key.userId}:${key.imageSha256}`;
      const first = !seen.has(seenKey);
      seen.add(seenKey);
      if (!bulkCache || !first || key.model !== model || key.promptVersion !== PHOTO_PROMPT_VERSION) return single.cached(key);
      const entry = (await safeCache())?.get(key.userId);
      if (!entry || !entry.shas.has(key.imageSha256)) return single.cached(key);
      return entry.found === "unavailable" ? "unavailable" : (entry.found.get(key.imageSha256) ?? null);
    },
    tier: tierOf,
    rejectedNow: deps.isRejected ? undefined : async (p) => (await (deps.listRejected ?? listRejectedPhotoIds)(p.book_id)).has(p.id),
  };
}

const sha256Of = (base64: string) => createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

/** Pipeline spend (agent_runs) + photo-analysis spend against AI_DAILY_BUDGET_USD. Fails open like checkDailyAiBudget. */
async function defaultBudgetExhausted(): Promise<boolean> {
  const budget = readDailyBudgetUsd();
  if (budget === null) return false;
  const pipeline = await checkDailyAiBudget();
  if (!pipeline.allowed) return true;
  try {
    const { getTodaySpendUsd } = await import("@/lib/db/ai-spend");
    const [a, b] = await Promise.all([getTodaySpendUsd(), getTodayPhotoAnalysisSpendUsd()]);
    return isOverDailyBudget(a + b, budget);
  } catch {
    return false;
  }
}

async function defaultOverSpendCap(photo: OwnPhoto, tierOf: (bookId: string) => Promise<"preview" | "full"> = getEntitlementTier): Promise<boolean> {
  return isOverSpendCap({ userId: photo.user_id, bookId: photo.book_id, tier: await tierOf(photo.book_id) });
}

/** Deterministic replay answer (local dev, previews, tests) — never derived from the image. */
export const photoReplaySynth: ReplaySynth = (meta) => {
  const seed = typeof meta.seed === "number" ? meta.seed : 0;
  return {
    description: "A sample photo used in replay mode.",
    scene: SCENES[seed % SCENES.length],
    objects: ["sample object"],
    activities: [],
    peopleCount: seed % 3,
    storyRole: (["establishing", "action", "portrait", "detail", "emotion", "closing"] as const)[seed % 6],
    atmosphere: MOODS[seed % MOODS.length],
  };
};

function transportFor(mode: AiMode): AgentTransport | null {
  if (mode === "replay") return new ReplayTransport({ scenario: "ok", synths: { curator: photoReplaySynth } });
  return getTransport(mode);
}

function orientationOf(width: number | null, height: number | null): "portrait" | "landscape" | "square" {
  if (!width || !height) return "square";
  const r = width / height;
  return r > 1.05 ? "landscape" : r < 0.95 ? "portrait" : "square";
}

const isoOrNull = (v: string | null) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Curator notes on the row (photos.ai) → the story-layer `ai` block, or null when absent / not that shape. */
function curatorNotes(ai: unknown): PhotoAnalysis["ai"] {
  const parsed = PhotoAnalysisSchema.shape.ai.safeParse(
    ai && typeof ai === "object"
      ? (({ description, scene, peopleCount, mood, quality, coverWorthy }: Record<string, unknown>) => ({ description, scene, peopleCount, mood, quality, coverWorthy }))(
          ai as Record<string, unknown>,
        )
      : null,
  );
  return parsed.success ? parsed.data : null;
}

/** Photo row + vision result → PhotoAnalysis. Timestamps, GPS, place and size are metadata only. */
export function toPhotoAnalysis(photo: OwnPhoto, vision: PhotoVision): PhotoAnalysis {
  const keep = photo.status !== "dropped";
  const known = (DROP_REASONS as readonly string[]).includes(photo.drop_reason ?? "") || photo.drop_reason === "user_removed" || photo.drop_reason === "similar";
  const dropReason = keep ? null : known ? (photo.drop_reason as PhotoAnalysis["dropReason"]) : "other";
  const width = photo.width ?? 0;
  const height = photo.height ?? 0;
  const place = photo.place?.trim() ? clipText(photo.place.trim(), STORY_LIMITS.shortText) : null;
  return {
    v: 1,
    photoId: photo.id,
    takenAt: isoOrNull(photo.taken_at),
    dateSource: photo.date_source === "exif" || photo.date_source === "file" ? photo.date_source : null,
    place,
    hasGps: photo.lat !== null && photo.lng !== null,
    orientation: orientationOf(photo.width, photo.height),
    aspect: width > 0 && height > 0 ? Math.min(20, Math.max(0.05, width / height)) : 1,
    blurScore: photo.blur_score !== null && photo.blur_score >= 0 ? photo.blur_score : null,
    dupGroup: photo.dup_group !== null && photo.dup_group >= 0 ? photo.dup_group : null,
    color: photo.color && /^#[0-9a-f]{6}$/.test(photo.color) ? photo.color : null,
    ai: curatorNotes(photo.ai),
    keep,
    dropReason,
    userOverride: photo.user_override,
    vision,
  };
}

function toVision(insight: PhotoInsight, photo: OwnPhoto, model: string): PhotoVision {
  return {
    description: insight.description,
    scene: insight.scene,
    objects: insight.objects,
    activities: insight.activities,
    peopleCount: insight.peopleCount,
    orientation: orientationOf(photo.width, photo.height),
    storyRole: insight.storyRole,
    atmosphere: { label: insight.atmosphere, interpretation: true },
    model,
    promptVersion: PHOTO_PROMPT_VERSION,
  };
}

/** Same key in flight → one model call (two tabs, or analyzePhotos given a photo twice). */
const inFlight = new Map<string, Promise<PhotoVision>>();

/**
 * Analyses one photo of the signed-in user. Throws PhotoIntelligenceError (code only) — callers
 * show "AI is not available for this photo" and carry on; the album never depends on it.
 */
export async function analyzePhoto(photoId: string, deps: PhotoIntelligenceDeps = {}): Promise<PhotoAnalysis> {
  return analyzeWith(photoId, deps, singleReaders(deps));
}

async function analyzeWith(photoId: string, deps: PhotoIntelligenceDeps, read: Readers): Promise<PhotoAnalysis> {
  const config = deps.config ?? readPhotoAiConfig();
  const mode = deps.mode ?? resolveAiMode();
  const now = deps.now ?? Date.now;

  const photo = await read.photo(photoId);
  if (!photo) throw new PhotoIntelligenceError("not_found");
  if (photo.upload_state !== "ready" || !photo.thumb_path) throw new PhotoIntelligenceError("not_ready");
  if (await read.rejected(photo)) throw new PhotoIntelligenceError("rejected");
  if (mode === "off") throw new PhotoIntelligenceError("ai_off");

  const base64 = await read.aiCopy(photo.thumb_path);
  if (!base64) throw new PhotoIntelligenceError("no_ai_copy");
  const imageSha256 = sha256Of(base64);
  const key: CacheKey = { userId: photo.user_id, imageSha256, model: config.model, promptVersion: PHOTO_PROMPT_VERSION };

  const cached = await read.cached(key);
  if (cached && cached !== "unavailable") {
    const vision = PhotoVisionSchema.safeParse(cached.analysis);
    // The cached block describes the pixels; orientation is re-derived for THIS photo's row.
    if (vision.success) return finish(photo, { ...vision.data, orientation: orientationOf(photo.width, photo.height) });
    // an unreadable cache row is ignored (older shape): analyse again
  }
  if (cached === "unavailable" && mode === "live") throw new PhotoIntelligenceError("cache_unavailable");

  const flightKey = `${key.userId}:${key.imageSha256}:${key.model}:${key.promptVersion}`;
  let pending = inFlight.get(flightKey);
  if (!pending) {
    pending = callModel({ photo, base64, key, config, mode, now, deps, tierOf: read.tier, rejectedNow: read.rejectedNow, canRecord: cached !== "unavailable" }).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, pending);
  }
  const vision = await pending;
  return finish(photo, { ...vision, orientation: orientationOf(photo.width, photo.height) });
}

function finish(photo: OwnPhoto, vision: PhotoVision): PhotoAnalysis {
  const out = PhotoAnalysisSchema.safeParse(toPhotoAnalysis(photo, vision));
  if (!out.success) throw new PhotoIntelligenceError("invalid_result", `${out.error.issues.length}_issues`);
  return out.data;
}

async function callModel(a: {
  photo: OwnPhoto;
  base64: string;
  key: CacheKey;
  config: PhotoAiConfig;
  mode: AiMode;
  now: () => number;
  deps: PhotoIntelligenceDeps;
  tierOf: (bookId: string) => Promise<"preview" | "full">;
  rejectedNow?: (photo: OwnPhoto) => Promise<boolean>;
  canRecord: boolean;
}): Promise<PhotoVision> {
  const { photo, key, config, mode, deps } = a;
  const live = mode === "live";

  if (live) {
    // All three checks run before EVERY live call, read fresh (spend by other books / users counts
    // at once). They go out together and are judged in the old order, so the outcome — which
    // error, and that no call is made — is the same as checking them one after another.
    const [rejected, used, broke, capped] = await Promise.allSettled([
      a.rejectedNow ? a.rejectedNow(photo) : Promise.resolve(false),
      (deps.countAnalysed ?? countAnalysedPhotos)(photo.book_id, photo.user_id),
      (deps.budgetExhausted ?? defaultBudgetExhausted)(),
      deps.overSpendCap ? deps.overSpendCap(photo) : defaultOverSpendCap(photo, a.tierOf),
    ]);
    if (rejected.status === "rejected") throw rejected.reason;
    if (rejected.value) throw new PhotoIntelligenceError("rejected");
    if (used.status === "rejected") throw used.reason;
    if (used.value >= limitsFor(photo.bookIsPaid).maxAnalyzedPhotos) throw new PhotoIntelligenceError("limit_reached");
    if (broke.status === "rejected") throw broke.reason;
    if (broke.value) throw new PhotoIntelligenceError("budget_exhausted");
    // Task 9: per-book / per-user spending caps (a cap reached stops analysis like the daily budget)
    if (capped.status === "rejected") throw capped.reason;
    if (capped.value) throw new PhotoIntelligenceError("budget_exhausted", "spend_cap");
  }

  const transport = deps.transport === undefined ? transportFor(mode) : deps.transport;
  if (!transport) throw new PhotoIntelligenceError("ai_off");

  // runAgentStep reports through a StepLogger; here the "step" is kept in memory and written to
  // photo_analyses below (there is no agent_runs row for a single-photo analysis).
  let step: AgentStepRecord | null = null;
  const logger: StepLogger = {
    insertStep: async (row) => {
      step = row;
    },
    addRunTotals: async () => {},
    meter: deps.meter ?? createUsageMeter({ userId: photo.user_id, bookId: photo.book_id, flow: "storybook", operation: "photo_analysis" }, { tierOf: a.tierOf }),
  };

  const result = await runAgentStep({
    runId: photo.id,
    agent: "curator",
    stepKey: "photo-insight",
    inputSummary: { images: 1, promptVersion: PHOTO_PROMPT_VERSION },
    request: {
      agent: "curator",
      system: cachedSystem(PHOTO_SYSTEM_PROMPT),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: a.base64 } },
            { type: "text", text: "Describe this photo." },
          ],
        },
      ],
      schema: PhotoInsightAiSchema,
      effort: EFFORT.curator,
      maxTokens: PHOTO_MAX_TOKENS,
      model: config.model,
      timeoutMs: config.timeoutMs,
      scenarioMeta: { seed: parseInt(key.imageSha256.slice(0, 6), 16) },
    },
    strictSchema: PhotoInsightStrictSchema,
    toLogOutput: photoInsightLogOutput,
    transport,
    logger,
    retry: { retries: config.retries, sleep: deps.sleep },
    now: a.now,
  });

  const logged = step as AgentStepRecord | null;
  const usage = {
    input: logged?.inputTokens ?? 0,
    output: logged?.outputTokens ?? 0,
    cacheRead: logged?.cacheReadTokens ?? 0,
    cacheWrite: logged?.cacheWriteTokens ?? 0,
  };
  const common = {
    userId: photo.user_id,
    bookId: photo.book_id,
    photoId: photo.id,
    imageSha256: key.imageSha256,
    // The row is keyed by the REQUESTED model (the cache key), even if a server fallback answered.
    model: key.model,
    promptVersion: key.promptVersion,
    mode: live ? ("live" as const) : ("replay" as const),
    usage,
    costUsd: live ? result.costUsd : 0,
    latencyMs: logged?.latencyMs ?? 0,
  };
  const record = async (rec: CallRecord) => {
    if (!a.canRecord) return;
    try {
      await (deps.record ?? recordAnalysisCall)(rec);
    } catch {
      console.error("[photo-intelligence] record_failed");
    }
  };

  if (!result.ok) {
    await record({ ...common, status: "error", error: String(result.code).replace(/[^a-z_]/g, "_") });
    if (result.status === "refused") throw new PhotoIntelligenceError("refused");
    throw new PhotoIntelligenceError("model_error", String(result.code), result.retryable);
  }

  const vision = toVision(result.data, photo, result.model);
  await record({ ...common, status: "ok", analysis: vision });
  return vision;
}

export type AnalyzePhotosResult = { photoId: string } & ({ ok: true; analysis: PhotoAnalysis } | { ok: false; error: PhotoIntelligenceErrorCode; retryable: boolean });

/**
 * Analyses several photos with at most `config.concurrency` model calls in flight. One failing
 * photo never fails the batch; results come back in input order. Once the daily budget is used up
 * (or AI is off / the cache table is missing) no NEW photo is started: the rest report that error.
 */
export async function analyzePhotos(photoIds: readonly string[], deps: PhotoIntelligenceDeps = {}): Promise<AnalyzePhotosResult[]> {
  const config = deps.config ?? readPhotoAiConfig();
  // The reads that are the same for every photo of this batch are made once (batchReaders).
  // Per batch, not per run: a photo rejected or analysed between two batches is seen by the next.
  const read = batchReaders(photoIds, deps, config.model);
  const out = new Array<AnalyzePhotosResult>(photoIds.length);
  let next = 0;
  let stop: PhotoIntelligenceErrorCode | null = null;
  const worker = async () => {
    while (next < photoIds.length) {
      const i = next++;
      const photoId = photoIds[i]!;
      if (stop) {
        out[i] = { photoId, ok: false, error: stop, retryable: false };
        continue;
      }
      try {
        out[i] = { photoId, ok: true, analysis: await analyzeWith(photoId, { ...deps, config }, read) };
      } catch (e) {
        const err = e instanceof PhotoIntelligenceError ? e : new PhotoIntelligenceError("model_error", "unexpected");
        if (err.code === "budget_exhausted" || err.code === "ai_off" || err.code === "cache_unavailable") stop = err.code;
        out[i] = { photoId, ok: false, error: err.code, retryable: err.retryable };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, photoIds.length) }, worker));
  return out;
}

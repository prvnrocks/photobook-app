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
  getCachedAnalysis,
  getTodayPhotoAnalysisSpendUsd,
  loadOwnPhoto,
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

const defaultIsRejected = async (photo: OwnPhoto) => (await listRejectedPhotoIds(photo.book_id)).has(photo.id);
const defaultLoadAiCopy = async (path: string) => (await loadThumbBase64([path])).get(path) ?? null;

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

async function defaultOverSpendCap(photo: OwnPhoto): Promise<boolean> {
  return isOverSpendCap({ userId: photo.user_id, bookId: photo.book_id, tier: await getEntitlementTier(photo.book_id) });
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
  const known = (DROP_REASONS as readonly string[]).includes(photo.drop_reason ?? "") || photo.drop_reason === "user_removed";
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
  const config = deps.config ?? readPhotoAiConfig();
  const mode = deps.mode ?? resolveAiMode();
  const now = deps.now ?? Date.now;

  const photo = await (deps.loadPhoto ?? loadOwnPhoto)(photoId);
  if (!photo) throw new PhotoIntelligenceError("not_found");
  if (photo.upload_state !== "ready" || !photo.thumb_path) throw new PhotoIntelligenceError("not_ready");
  if (await (deps.isRejected ?? defaultIsRejected)(photo)) throw new PhotoIntelligenceError("rejected");
  if (mode === "off") throw new PhotoIntelligenceError("ai_off");

  const base64 = await (deps.loadAiCopy ?? defaultLoadAiCopy)(photo.thumb_path);
  if (!base64) throw new PhotoIntelligenceError("no_ai_copy");
  const imageSha256 = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
  const key: CacheKey = { userId: photo.user_id, imageSha256, model: config.model, promptVersion: PHOTO_PROMPT_VERSION };

  const cached = await (deps.getCached ?? getCachedAnalysis)(key);
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
    pending = callModel({ photo, base64, key, config, mode, now, deps, canRecord: cached !== "unavailable" }).finally(() => inFlight.delete(flightKey));
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
  canRecord: boolean;
}): Promise<PhotoVision> {
  const { photo, key, config, mode, deps } = a;
  const live = mode === "live";

  if (live) {
    const used = await (deps.countAnalysed ?? countAnalysedPhotos)(photo.book_id, photo.user_id);
    if (used >= limitsFor(photo.bookIsPaid).maxAnalyzedPhotos) throw new PhotoIntelligenceError("limit_reached");
    if (await (deps.budgetExhausted ?? defaultBudgetExhausted)()) throw new PhotoIntelligenceError("budget_exhausted");
    // Task 9: per-book / per-user spending caps (a cap reached stops analysis like the daily budget)
    if (await (deps.overSpendCap ?? defaultOverSpendCap)(photo)) throw new PhotoIntelligenceError("budget_exhausted", "spend_cap");
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
    meter: deps.meter ?? createUsageMeter({ userId: photo.user_id, bookId: photo.book_id, flow: "storybook", operation: "photo_analysis" }),
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
        out[i] = { photoId, ok: true, analysis: await analyzePhoto(photoId, { ...deps, config }) };
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

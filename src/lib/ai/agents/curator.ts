// Curator agent (①): one batch of ≤ 10 photos → keep/drop + photo notes. Pure async function; all
// I/O comes in through `deps` (thumb loading) and `logger` (agent_steps), so the orchestrator
// (T10) wires the DB in and tests use fakes.
//
// Contract:
//  - Exactly one runAgentStep (→ one agent_steps row) per call that has at least one thumbnail.
//    No thumbnails at all → no call, every photo gets the rule decision.
//  - Never throws on model/transport problems: refusal / error / invalid output → the whole batch
//    gets ruleCurate() decisions (usedAi false). Logger errors propagate (no silent calls).
//  - Post-checks on a valid answer: entries for unknown aliases are ignored, duplicate aliases →
//    first wins, invalid single entries are ignored; photos without a usable entry get the rule
//    decision; per dup group ≥ 1 photo stays kept; user_override photos keep their current
//    status (their AI notes are still returned so they can be stored).
//  - Privacy (D-027): the step log holds only alias → keep/dropReason/quality/scene/coverWorthy.

import { z } from "zod";
import { EFFORT } from "../client";
import {
  aspectRatio,
  compareRuleRank,
  currentDecision,
  ruleCurate,
  type CurationPhoto,
  type DropReason,
  type RuleDecision,
} from "../fallback";
import { buildCuratorUserContent, CURATOR_PROMPT_VERSION, CURATOR_SYSTEM_PROMPT, type CuratorPromptItem } from "../prompts/curator";
import { runAgentStep, type RetryOptions, type StepErrorCode, type StepLogger } from "../run-step";
import {
  AI_TEXT_LIMITS,
  CuratorBatchAiSchema,
  PhotoAnalysisStrictSchema,
  type MoodSchema,
  type PhotoAnalysis,
  type SceneSchema,
} from "../schemas";
import { cachedSystem, MAX_IMAGES_PER_REQUEST, type AgentTransport } from "../transport";
import { clipText } from "@/lib/text/clip";
import type { Occasion } from "@/lib/book/options";
import type { CuratorReplayHint } from "./curator-replay";

export { CURATOR_PROMPT_VERSION };

export type Scene = z.infer<typeof SceneSchema>;
export type Mood = z.infer<typeof MoodSchema>;

/** What is stored in photos.ai (descriptions live ONLY here — D-027). */
export interface CuratorNotes {
  v: number;
  description: string;
  scene: Scene;
  peopleCount: number;
  mood: Mood;
  quality: number;
  coverWorthy: boolean;
}

export interface CuratorResult {
  keep: boolean;
  dropReason: DropReason | null;
  ai: CuratorNotes | null;
  source: "ai" | "rule";
}

/** Thumb loader: storage path → base64 JPEG. Missing entries = not loadable (rule result). */
export interface CuratorDeps {
  loadThumbs(paths: string[]): Promise<Map<string, string>>;
}

export interface CurateBatchArgs {
  runId: string;
  /** Idempotency key within the run, e.g. "curator:3". */
  stepKey: string;
  attempt?: number;
  batch: CurationPhoto[];
  occasion: Occasion;
  /** photo id → prompt alias ("p12"), stable for the whole run (D-023). */
  aliasOf: Map<string, string>;
  transport: AgentTransport;
  logger: StepLogger;
  deps: CuratorDeps;
  retry?: RetryOptions;
}

export interface CurateBatchResult {
  results: Map<string, CuratorResult>;
  /** True when the model answered with a valid batch (some photos may still be source 'rule'). */
  usedAi: boolean;
  /** Set when a call was made and failed (refusal/error) — for ai_status 'partial' + "Try AI again". */
  failure?: { code: StepErrorCode; retryable: boolean };
  /** USD of the step (0 when no call was made). */
  costUsd: number;
}

/** Output budget per batch (Opus 5.5 thinks at effort low; ~120 tokens of JSON per photo). */
export const CURATOR_MAX_TOKENS = 8000;

/** True unless photos.ai already holds notes from the current Curator prompt version. */
export function needsCuration(photo: Pick<CurationPhoto, "ai">): boolean {
  const ai = photo.ai;
  if (!ai || typeof ai !== "object" || Array.isArray(ai)) return true;
  return (ai as { v?: unknown }).v !== CURATOR_PROMPT_VERSION;
}

/** Validated, cleaned batch used inside the step (strict schema output). */
interface CleanBatch {
  photos: PhotoAnalysis[];
  ignored: { unknown: number; duplicate: number; invalid: number };
}

/**
 * Per-call strict schema: validates entries one by one (one bad entry doesn't sink the batch),
 * drops unknown aliases and repeats (first wins). Fails only when no entry survives.
 */
export function curatorStrictSchema(knownAliases: ReadonlySet<string>) {
  return z.object({ photos: z.array(z.unknown()) }).transform((raw, ctx): CleanBatch => {
    const photos: PhotoAnalysis[] = [];
    const seen = new Set<string>();
    const ignored = { unknown: 0, duplicate: 0, invalid: 0 };
    for (const entry of raw.photos) {
      const parsed = PhotoAnalysisStrictSchema.safeParse(entry);
      if (!parsed.success) {
        ignored.invalid++;
        continue;
      }
      const p = parsed.data;
      if (!knownAliases.has(p.photoId)) {
        ignored.unknown++;
        continue;
      }
      if (seen.has(p.photoId)) {
        ignored.duplicate++;
        continue;
      }
      seen.add(p.photoId);
      photos.push(p);
    }
    if (photos.length === 0) {
      ctx.addIssue({ code: "custom", message: "no usable photo entries" });
      return z.NEVER;
    }
    return { photos, ignored };
  });
}

/** agent_steps.output for a Curator step — no descriptions (D-027). */
export function curatorLogOutput(b: CleanBatch) {
  const photos: Record<string, { keep: boolean; dropReason: DropReason | null; quality: number; scene: Scene; coverWorthy: boolean }> = {};
  for (const p of b.photos) {
    photos[p.photoId] = { keep: p.keep, dropReason: p.dropReason, quality: p.quality, scene: p.scene, coverWorthy: p.coverWorthy };
  }
  return { photos, ignored: b.ignored };
}

function notesFrom(p: PhotoAnalysis): CuratorNotes {
  return {
    v: CURATOR_PROMPT_VERSION,
    description: clipText(p.description, AI_TEXT_LIMITS.description),
    scene: p.scene,
    peopleCount: p.peopleCount,
    mood: p.mood,
    quality: p.quality,
    coverWorthy: p.coverWorthy,
  };
}

const fromRule = (d: RuleDecision): CuratorResult => ({ keep: d.keep, dropReason: d.dropReason, ai: null, source: "rule" });

function isPng(p: CurationPhoto): boolean {
  return (p.originalMime ?? "").trim().toLowerCase() === "image/png";
}
function hasNoCamera(p: CurationPhoto): boolean {
  return (p.camera ?? "").trim() === "";
}

export async function curateBatch(args: CurateBatchArgs): Promise<CurateBatchResult> {
  const { batch, aliasOf } = args;
  if (batch.length > MAX_IMAGES_PER_REQUEST) {
    throw new RangeError(`curator batch has ${batch.length} photos (max ${MAX_IMAGES_PER_REQUEST}); use buildBatches()`);
  }

  // Unique photos, in the given (buildBatches) order.
  const photos: CurationPhoto[] = [];
  const ids = new Set<string>();
  for (const p of batch) {
    if (ids.has(p.id)) continue;
    ids.add(p.id);
    photos.push(p);
  }

  const rule = ruleCurate(photos, { ensureOneKept: false });
  const allRule = (): Map<string, CuratorResult> => new Map(photos.map((p) => [p.id, fromRule(rule.get(p.id)!)]));

  // Thumbnails (only photos with an alias and a loadable thumb go to the model).
  const paths = photos.map((p) => p.thumbPath).filter((x): x is string => !!x);
  const thumbs = paths.length ? await args.deps.loadThumbs([...new Set(paths)]) : new Map<string, string>();
  const items: Array<CuratorPromptItem & { photo: CurationPhoto }> = [];
  for (const p of photos) {
    const alias = aliasOf.get(p.id);
    const data = p.thumbPath ? thumbs.get(p.thumbPath) : undefined;
    if (!alias || !data) continue;
    items.push({
      photo: p,
      alias,
      takenAt: p.takenAt,
      dateSource: p.dateSource,
      width: p.width,
      height: p.height,
      place: p.place,
      dupGroup: p.dupGroup,
      isPng: isPng(p),
      noCamera: hasNoCamera(p),
      thumbBase64: data,
    });
  }
  if (items.length === 0) return { results: allRule(), usedAi: false, costUsd: 0 };

  const aliases = items.map((i) => i.alias);
  const hints: Record<string, CuratorReplayHint> = {};
  for (const i of items) {
    hints[i.alias] = {
      isPng: i.isPng,
      noCamera: i.noCamera,
      aspect: aspectRatio(i.photo),
      blur: i.photo.blurScore,
      dupGroup: i.dupGroup,
    };
  }

  const step = await runAgentStep({
    runId: args.runId,
    agent: "curator",
    stepKey: args.stepKey,
    attempt: args.attempt,
    inputSummary: {
      promptVersion: CURATOR_PROMPT_VERSION,
      aliases,
      images: items.length,
      ruleOnly: photos.length - items.length,
      occasion: args.occasion,
    },
    request: {
      agent: "curator",
      system: cachedSystem(CURATOR_SYSTEM_PROMPT),
      messages: [{ role: "user", content: buildCuratorUserContent(args.occasion, items) }],
      schema: CuratorBatchAiSchema,
      effort: EFFORT.curator,
      maxTokens: CURATOR_MAX_TOKENS,
      scenarioMeta: { aliases, hints },
    },
    strictSchema: curatorStrictSchema(new Set(aliases)),
    toLogOutput: curatorLogOutput,
    transport: args.transport,
    logger: args.logger,
    retry: args.retry,
  });

  if (!step.ok) {
    return { results: allRule(), usedAi: false, failure: { code: step.code, retryable: step.retryable }, costUsd: step.costUsd };
  }

  const byAlias = new Map(step.data.photos.map((p) => [p.photoId, p]));
  const sent = new Map(items.map((i) => [i.photo.id, i.alias]));
  const results = new Map<string, CuratorResult>();
  for (const p of photos) {
    const alias = sent.get(p.id);
    const a = alias ? byAlias.get(alias) : undefined;
    if (!a) {
      results.set(p.id, fromRule(rule.get(p.id)!));
      continue;
    }
    const decision = p.userOverride ? currentDecision(p) : { keep: a.keep, dropReason: a.keep ? null : a.dropReason };
    results.set(p.id, { keep: decision.keep, dropReason: decision.dropReason, ai: notesFrom(a), source: "ai" });
  }

  ensureGroupKeepers(photos, results);
  return { results, usedAi: true, costUsd: step.costUsd };
}

/**
 * D-019: every dup group in the batch keeps ≥ 1 photo. Override-kept members count. If none is
 * kept, restore the non-override member (not dropped as screenshot/document) with the highest AI
 * quality; ties (or no notes) → rule rank (sharpest, largest, smallest id). Mutates `results`.
 */
function ensureGroupKeepers(photos: CurationPhoto[], results: Map<string, CuratorResult>): void {
  const groups = new Map<number, CurationPhoto[]>();
  for (const p of photos) {
    if (p.dupGroup === null || !Number.isFinite(p.dupGroup)) continue;
    groups.set(p.dupGroup, [...(groups.get(p.dupGroup) ?? []), p]);
  }
  for (const members of groups.values()) {
    if (members.some((p) => results.get(p.id)?.keep)) continue;
    const candidates = members.filter((p) => {
      const r = results.get(p.id)!;
      return !p.userOverride && r.dropReason !== "screenshot" && r.dropReason !== "document";
    });
    if (candidates.length === 0) continue;
    const q = (p: CurationPhoto) => results.get(p.id)?.ai?.quality ?? 0;
    const best = [...candidates].sort((a, b) => q(b) - q(a) || compareRuleRank(a, b))[0];
    const r = results.get(best.id)!;
    results.set(best.id, { ...r, keep: true, dropReason: null });
  }
}

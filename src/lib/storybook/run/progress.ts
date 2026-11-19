// Storybook generation job (Task 8) — the progress model shared by the server (src/lib/ai/story/run.ts
// writes it into agent_runs.progress) and the browser (the wizard's Create step and the editor's
// "Regenerate story" sheet read it). Pure and client-safe: no zod, no server imports.
//
// Four stages, 1:1 with real pipeline steps and with the run's `state` (migration 2800):
//   discovering  "Discovering your best moments"   photo analysis + quality / duplicates
//   organizing   "Organizing your memories"        moments + story plan
//   writing      "Writing your story"              narrative, one chapter per tick
//   designing    "Designing your pages"            page composition
// Only counts the server really has are stored ("12 of 40 photos", "Chapter 2 of 3"); there is no
// percentage anywhere in this model, and nothing here is driven by a timer.
//
// agent_runs.progress is capped at 4096 bytes (0600): the object stays small (counts + codes).

export const STORY_RUN_STATES = ["discovering", "organizing", "writing", "designing"] as const;
export type StoryRunStage = (typeof STORY_RUN_STATES)[number];
export type StoryRunState = StoryRunStage | "done" | "failed";

export const STAGE_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STAGE_LABELS: Record<StoryRunStage, string> = {
  discovering: "Discovering your best moments",
  organizing: "Organizing your memories",
  writing: "Writing your story",
  designing: "Designing your pages",
};

export const STORY_HEADLINE = "Your memories are becoming a story.";

/**
 * Why parts of the book were made without AI (codes only). Shown as one honest line on
 * completion / in the editor — never fake AI copy.
 */
export const OUTCOME_NOTES = [
  "ai_off", // AI is switched off: rule plan, no text, deterministic pages
  "budget_exhausted", // the daily AI budget is used up
  "limit_reached", // the book's story limit is used up
  "usage_unavailable", // the usage table is missing (migration) → no live calls
  "photos_unanalysed", // some photos could not be analysed (grouped with less evidence)
  "plan_rule", // the outline came from the rule planner
  "chapter_failed", // one or more chapters were written without text
  "story_kept", // regeneration: no new text could be written, the current story was kept
  "pages_rule", // the page intent call was not used (deterministic composer only)
] as const;
export type OutcomeNote = (typeof OUTCOME_NOTES)[number];

export type StoryStageProgress = {
  status: StageStatus;
  /** discovering: photos analysed so far / photos that need an analysis (null = not known yet). */
  done?: number | null;
  total?: number | null;
  /** organizing: moments found, chapters planned. writing: chapters written / planned. designing: pages. */
  moments?: number | null;
  chapters?: number | null;
  pages?: number | null;
  /** writing: the closing page is being written (after the last chapter). */
  closing?: boolean;
};

export type StoryRunOutcome = {
  /** "full" = every step used AI; "partial" = some fell back; "none" = made without AI. */
  ai: "full" | "partial" | "none";
  notes: OutcomeNote[];
  /** Composition warnings by kind (counts only — the editor re-checks the pages itself). */
  warnings: number;
};

export type StoryRunProgress = {
  v: 1;
  kind: "storybook";
  /** Mirrors the run state (the reaper writes "failed" here too). */
  phase: StoryRunState;
  stages: Record<StoryRunStage, StoryStageProgress>;
  /** Set when the run finished (done). */
  outcome: StoryRunOutcome | null;
};

/** What the client sees of a run (GET / advance / start answers). */
export type StoryRunView = {
  runId: string;
  state: StoryRunState;
  progress: StoryRunProgress;
  done: boolean;
  aiStatus: "ok" | "partial" | "failed" | null;
  /** 'cancelled' after Stop; other codes for failures (see storyErrorCopy). */
  errorCode: string | null;
  mode: "live" | "replay" | "rule";
};

/** A storybook agent_runs row (owner columns are enough) → the client view. */
export function storyRunViewOf(run: { id: string; state: string; progress: unknown; ai_status: string | null; error_code: string | null; mode: string }): StoryRunView {
  const state: StoryRunState = isStoryRunState(run.state) ? run.state : "failed";
  const ai = run.ai_status;
  const mode = run.mode === "live" || run.mode === "replay" || run.mode === "rule" ? run.mode : "rule";
  return {
    runId: run.id,
    state,
    progress: parseStoryProgress(run.progress, state),
    done: state === "done" || state === "failed",
    aiStatus: ai === "ok" || ai === "partial" || ai === "failed" ? ai : null,
    errorCode: run.error_code ?? null,
    mode,
  };
}

export function emptyStoryProgress(phase: StoryRunState = "discovering"): StoryRunProgress {
  return {
    v: 1,
    kind: "storybook",
    phase,
    stages: {
      discovering: { status: phase === "discovering" ? "running" : "pending" },
      organizing: { status: "pending" },
      writing: { status: "pending" },
      designing: { status: "pending" },
    },
    outcome: null,
  };
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const countOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

export function isStoryRunState(v: unknown): v is StoryRunState {
  return v === "done" || v === "failed" || isOneOf(STORY_RUN_STATES, v);
}

function parseStage(raw: unknown): StoryStageProgress {
  const o = obj(raw) ?? {};
  const out: StoryStageProgress = { status: isOneOf(STAGE_STATUSES, o.status) ? o.status : "pending" };
  for (const k of ["done", "total", "moments", "chapters", "pages"] as const) {
    const n = countOrNull(o[k]);
    if (n !== null) out[k] = n;
  }
  if (o.closing === true) out.closing = true;
  return out;
}

/** Lenient parse of agent_runs.progress (unknown / missing fields → defaults). */
export function parseStoryProgress(raw: unknown, state: StoryRunState): StoryRunProgress {
  const o = obj(raw) ?? {};
  const stagesRaw = obj(o.stages) ?? {};
  const base = emptyStoryProgress(state);
  const stages = { ...base.stages };
  for (const s of STORY_RUN_STATES) if (stagesRaw[s] !== undefined) stages[s] = parseStage(stagesRaw[s]);
  const oc = obj(o.outcome);
  const outcome: StoryRunOutcome | null = oc
    ? {
        ai: oc.ai === "full" || oc.ai === "partial" || oc.ai === "none" ? oc.ai : "partial",
        notes: Array.isArray(oc.notes) ? (oc.notes.filter((n) => isOneOf(OUTCOME_NOTES, n)) as OutcomeNote[]) : [],
        warnings: countOrNull(oc.warnings) ?? 0,
      }
    : null;
  return { v: 1, kind: "storybook", phase: isStoryRunState(o.phase) ? o.phase : state, stages, outcome };
}

// ---------------------------------------------------------------------------- copy

export type StageRow = {
  stage: StoryRunStage;
  label: string;
  status: StageStatus;
  /** A real count from the server ("12 of 40 photos", "Chapter 2 of 3"), or null. */
  detail: string | null;
  /** Spoken state for screen readers (status is never shown by colour alone). */
  statusText: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function stageDetail(stage: StoryRunStage, p: StoryStageProgress): string | null {
  switch (stage) {
    case "discovering": {
      if (p.status === "skipped") return "Sorted without AI";
      if (typeof p.total === "number" && p.total > 0 && typeof p.done === "number") {
        if (p.status === "done") return plural(p.total, "photo", "photos");
        return `${Math.min(p.done, p.total)} of ${p.total} photos`;
      }
      return null;
    }
    case "organizing": {
      const parts: string[] = [];
      if (typeof p.moments === "number" && p.moments > 0) parts.push(plural(p.moments, "moment", "moments"));
      if (typeof p.chapters === "number" && p.chapters > 0) parts.push(plural(p.chapters, "chapter", "chapters"));
      return parts.length ? parts.join(" · ") : null;
    }
    case "writing": {
      if (p.status === "skipped") return "No text this time";
      const total = typeof p.chapters === "number" ? p.chapters : null;
      const done = typeof p.done === "number" ? p.done : null;
      if (p.status === "running" && p.closing) return "Closing words";
      if (p.status === "running" && total !== null && total > 0 && done !== null) return `Chapter ${Math.min(done + 1, total)} of ${total}`;
      if (p.status === "done" && total !== null && total > 0) return plural(total, "chapter", "chapters");
      return null;
    }
    case "designing":
      return p.status === "done" && typeof p.pages === "number" && p.pages > 0 ? plural(p.pages, "page", "pages") : null;
  }
}

const STATUS_TEXT: Record<StageStatus, string> = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  failed: "Stopped here",
  skipped: "Done without AI",
};

export function stageRows(progress: StoryRunProgress): StageRow[] {
  return STORY_RUN_STATES.map((stage) => {
    const p = progress.stages[stage];
    return { stage, label: STAGE_LABELS[stage], status: p.status, detail: stageDetail(stage, p), statusText: STATUS_TEXT[p.status] };
  });
}

/** The stage the run is in (or stopped at) — null when done. */
export function currentStage(progress: StoryRunProgress): StoryRunStage | null {
  for (const s of STORY_RUN_STATES) if (progress.stages[s].status === "running" || progress.stages[s].status === "failed") return s;
  if (isOneOf(STORY_RUN_STATES, progress.phase)) return progress.phase;
  return null;
}

/** One polite line for the live region when the stage changes. */
export function stageAnnouncement(progress: StoryRunProgress): string {
  const s = currentStage(progress);
  if (!s) return "";
  const d = stageDetail(s, progress.stages[s]);
  return d ? `${STAGE_LABELS[s]} — ${d}` : STAGE_LABELS[s];
}

export const CANCELLED_CODE = "cancelled";

/** Plain reasons for a stopped / failed run (codes from run.ts and the reaper). */
export function storyErrorCopy(code: string | null): string {
  switch (code) {
    case CANCELLED_CODE:
      return "You stopped this. Nothing on your book was changed — pick up where it stopped whenever you like.";
    case "no_photos":
      return "There are no photos to make a story from. Add a few photos first.";
    case "user_edited":
      return "Your book already has your own changes, so we didn't replace it.";
    case "conflict":
      return "The book changed while we were designing it. Try again to use the latest version.";
    case "unsupported_design":
      return "This book's style can't be laid out yet. Pick another style and try again.";
    case "stale":
      return "This took too long and was stopped. Try again — finished steps are kept.";
    case "not_found":
      return "We couldn't find this book.";
    default:
      return "Something went wrong while making your story. Try again — finished steps are kept.";
  }
}

/** Honest one-liner about how the finished book was made (null = everything used AI). */
export function outcomeCopy(outcome: StoryRunOutcome | null): string | null {
  if (!outcome || outcome.ai === "full") return null;
  const n = new Set(outcome.notes);
  if (outcome.ai === "none") {
    if (n.has("ai_off")) return "Made without AI: your photos are laid out in order — add your own words anywhere.";
    if (n.has("budget_exhausted")) return "Made without AI today (our AI is taking a break): your photos are laid out — add your own words.";
    if (n.has("limit_reached")) return "Made without AI: this book's AI story limit is used up. Your photos are laid out — add your own words.";
    if (n.has("story_kept")) return "We couldn't write new text this time, so your current story was kept.";
    return "Made without AI text: your photos are laid out — add your own words anywhere.";
  }
  if (n.has("story_kept")) return "We couldn't write new text this time, so your current story was kept.";
  if (n.has("chapter_failed")) return "Some chapters have no text yet — tap a page to add your own words or try “Rewrite story”.";
  if (n.has("photos_unanalysed")) return "A few photos couldn't be looked at closely; they're still in your book.";
  return null;
}

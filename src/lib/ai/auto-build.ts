import "server-only";
// M13 T4 (D-070 (2)): the automatic FIRST build, fired by the client when the first upload
// settles. The server alone decides whether it may run (lessons 2026-11-09: never let the client
// choose build vs rebuild):
//   - not_first  — the book already has an agent_run (any trigger, any state) or an AI-made doc.
//                  An automatic start never becomes a rebuild; photos added after a build go
//                  through the free "Update album" path (D-028).
//   - not_ready  — fewer than AUTO_BUILD_MIN_READY_PHOTOS ready photos, or an upload is pending.
//   - everything else is the normal start (startRun): caps D-021/026/035, daily budget D-059,
//     AI_MODE=off → synchronous rule run, user_edited / unsupported_design refusals.
//
// Exactly one run for concurrent automatic starts. agent_runs_one_active_per_book_idx already
// refuses a second ACTIVE run (already_running). The remaining race is a rule run (AI off) that
// finishes inside its own request before the twin request inserts: both passed the "no run yet"
// pre-check, so the twin's insert succeeds. The guard below re-checks right after the insert and
// before anything else touches the run: if another run of the book exists, ours is the duplicate
// — the other one must have finished before our insert (the unique index), so it can't be seeing
// us in its own check, and exactly one run survives. The duplicate row is deleted (still queued,
// never claimed) and the call answers not_first.
//
// Logs carry error codes only — never ids or photo data.
import { docOrigin } from "@/lib/book/replaceable";
import * as agentRunsDb from "@/lib/db/agent-runs";
import * as photosDb from "@/lib/db/photos";
import { errorCodeOf } from "@/lib/http/json";
import {
  defaultDeps as defaultOrchestratorDeps,
  startRun as orchestratorStartRun,
  type OrchestratorDeps,
  type StartInput,
  type StartResult,
} from "@/lib/ai/orchestrator";

/** D-070: the automatic first build needs at least this many ready photos. */
export const AUTO_BUILD_MIN_READY_PHOTOS = 5;

export type AutoBuildRefusal = "not_first" | "not_ready";

export type AutoBuildResult = StartResult | { ok: false; error: AutoBuildRefusal };

export function isAutoBuildRefusal(r: AutoBuildResult): r is { ok: false; error: AutoBuildRefusal } {
  return !r.ok && (r.error === "not_first" || r.error === "not_ready");
}

export type AutoBuildDeps = {
  hasAnyRunForBook: (bookId: string, exceptRunId?: string) => Promise<boolean>;
  deleteUnclaimedRun: (runId: string, bookId: string) => Promise<boolean>;
  listUploadState: (bookId: string) => Promise<ReadonlyArray<{ upload_state: string }>>;
  startRun: (input: StartInput, deps: OrchestratorDeps) => Promise<StartResult>;
  orchestratorDeps: () => OrchestratorDeps;
};

export function defaultAutoBuildDeps(): AutoBuildDeps {
  return {
    hasAnyRunForBook: agentRunsDb.hasAnyRunForBook,
    deleteUnclaimedRun: agentRunsDb.deleteUnclaimedRun,
    listUploadState: photosDb.listUploadState,
    startRun: orchestratorStartRun,
    orchestratorDeps: defaultOrchestratorDeps,
  };
}

/** Ready = every photo row finished uploading and at least the minimum number are ready. */
export function isAutoBuildReady(rows: ReadonlyArray<{ upload_state: string }>): boolean {
  let ready = 0;
  for (const r of rows) {
    if (r.upload_state !== "ready") return false; // pending (or unknown) → upload not settled
    ready++;
  }
  return ready >= AUTO_BUILD_MIN_READY_PHOTOS;
}

/**
 * Starts the automatic first build of `book` for `userId`. The caller has checked ownership
 * (getMyBook under RLS). Never creates a run when it answers not_first / not_ready.
 */
export async function startAutoBuild(
  input: { book: { id: string; doc: unknown }; userId: string },
  deps: AutoBuildDeps = defaultAutoBuildDeps(),
): Promise<AutoBuildResult> {
  const { book, userId } = input;
  // An AI-made doc means a build already happened (D-031 origin) → never an automatic rebuild.
  if (docOrigin(book.doc).generator === "ai") return { ok: false, error: "not_first" };
  if (await deps.hasAnyRunForBook(book.id)) return { ok: false, error: "not_first" };
  if (!isAutoBuildReady(await deps.listUploadState(book.id))) return { ok: false, error: "not_ready" };

  const base = deps.orchestratorDeps();
  let duplicate = false;
  const guarded: OrchestratorDeps = {
    ...base,
    createRunCapped: async (create) => {
      const created = await base.createRunCapped(create);
      if (!("id" in created)) return created;
      let other: boolean;
      try {
        other = await deps.hasAnyRunForBook(create.bookId, created.id);
      } catch (e) {
        // Can't verify → keep the run we legitimately created (fail open: the user gets a build).
        console.error(`[auto-build] duplicate check failed (${errorCodeOf(e)})`);
        return created;
      }
      if (!other) return created;
      duplicate = true;
      await discardDuplicate(base, deps, created.id, create.bookId);
      return { error: "already_running" };
    },
  };

  const result = await deps.startRun({ bookId: book.id, userId, trigger: "build" }, guarded);
  if (duplicate) return { ok: false, error: "not_first" };
  return result;
}

/** Lease held while failing a duplicate run that could not be deleted. */
const DISCARD_LEASE_SECONDS = 30;

/**
 * Deletes the duplicate run (never claimed, no model call). If the delete fails, fails the run
 * instead so no build page resumes it as an active run; as a last resort the stale-run reaper
 * (cleanup cron) fails it. Never throws.
 */
async function discardDuplicate(
  base: OrchestratorDeps,
  deps: AutoBuildDeps,
  runId: string,
  bookId: string,
): Promise<void> {
  try {
    if (await deps.deleteUnclaimedRun(runId, bookId)) return;
    console.error("[auto-build] duplicate run not deleted (not_unclaimed)");
  } catch (e) {
    console.error(`[auto-build] duplicate run not deleted (${errorCodeOf(e)})`);
  }
  try {
    const token = await base.claimRun(runId, DISCARD_LEASE_SECONDS);
    if (!token) return;
    await base.checkpointRun(runId, token, {
      state: "failed",
      ai_status: null,
      error_code: "auto_duplicate",
      finished_at: new Date(base.now()).toISOString(),
    });
    await base.releaseRun(runId, token);
  } catch (e) {
    console.error(`[auto-build] duplicate run not failed (${errorCodeOf(e)})`);
  }
}

import "server-only";
// Daily housekeeping (D-055 retention, D-056 one cron at 01:00 UTC, 240 s budget, batched,
// row-then-storage + orphan sweep). Called by GET /api/cron/cleanup.
//
// Vercel Hobby crons run at most once a day and fire at some point within the scheduled hour
// (01:00–01:59 UTC); nothing here depends on the exact minute. Every sweep is idempotent and
// resumable: work left when the budget runs out is simply picked up by the next day's run.
//
// Sweep order:
//   warnings (T5 hook, no-op by default — runs first so draft deletion sees fresh claims)
//   → expired free books → abandoned drafts → pending uploads → orphan objects (photos, exports)
//   → old export rows → unlock attempts → stale AI runs.
//
// Logs: exactly one line per sweep, `[cleanup] <sweep> n=<count> ms=<ms>` plus count / code
// fields. Never ids, paths, titles or emails.
import {
  CLEANUP_BATCH,
  CRON_TIME_BUDGET_MS,
  DRAFT_IDLE_DAYS,
  DRAFT_NOTICE_DAYS,
  FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY,
  OLD_EXPORT_ROW_DAYS,
  ORPHAN_OBJECT_DAYS,
  PENDING_UPLOAD_DAYS,
  STALE_AGENT_RUN_HOURS,
  UNLOCK_ATTEMPT_HOURS,
  type CleanupBucket,
} from "@/lib/cleanup/rules";
import { removeBookPrefixes } from "@/lib/cleanup/delete-book";
import {
  deleteAbandonedDrafts,
  deleteExpiredBooks,
  deleteOldExportRows,
  deleteOldUnlockAttempts,
  deletePendingUploads,
  listOrphanObjects,
  reapStaleAgentRuns,
  removeStoragePaths,
  type BookRef,
} from "@/lib/db/cleanup";

export const SWEEPS = [
  "warnings",
  "expired_books",
  "abandoned_drafts",
  "pending_uploads",
  "orphans_photos",
  "orphans_exports",
  "old_exports",
  "unlock_attempts",
  "stale_runs",
] as const;
export type SweepName = (typeof SWEEPS)[number];

export type SweepCount = {
  /** Rows (books, photos, export rows, attempts, runs) or objects handled; warnings = emails sent. */
  n: number;
  ms: number;
  /** Storage objects removed by this sweep. */
  storageRemoved: number;
  /** Storage calls that failed (left to the orphan sweep); warnings = emails that failed. */
  storageFailures: number;
  /** The sweep stopped on an error (code logged). */
  failed: boolean;
  /** False when the time budget (or a stuck batch) stopped it before the backlog was empty. */
  complete: boolean;
};

export type CleanupCounts = {
  /** No sweep failed. */
  ok: boolean;
  /** Every sweep emptied its backlog (false → tomorrow's run continues). */
  complete: boolean;
  /** The time budget ran out during the run. */
  budgetSpent: boolean;
  ms: number;
  sweeps: Record<SweepName, SweepCount>;
};

/** Context handed to the warnings hook (T5 plugs email sending in here). */
export type WarningHookContext = {
  now: () => number;
  /** Epoch ms after which no new batch may start. */
  deadline: number;
};

export type WarningHookResult = { sent: number; failed: number; complete?: boolean };

export type WarningHook = (ctx: WarningHookContext) => Promise<WarningHookResult>;

/** Default warnings hook: no emails yet (T5). */
export const noWarnings: WarningHook = async () => ({ sent: 0, failed: 0, complete: true });

export type RunCleanupOptions = {
  now?: () => number;
  budgetMs?: number;
  sendWarnings?: WarningHook;
};

function errorCode(e: unknown): string {
  const raw = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
}

function emptyCount(): SweepCount {
  return { n: 0, ms: 0, storageRemoved: 0, storageFailures: 0, failed: false, complete: true };
}

function logSweep(name: SweepName, c: SweepCount, extra: { skipped?: boolean; code?: string }): void {
  let line = `[cleanup] ${name} n=${c.n} ms=${c.ms}`;
  if (c.storageRemoved > 0) line += ` storage_removed=${c.storageRemoved}`;
  if (c.storageFailures > 0) line += ` storage_fail=${c.storageFailures}`;
  if (extra.skipped) line += " skipped=1";
  else if (!c.complete && !c.failed) line += " partial=1";
  if (c.failed) {
    line += ` error=${extra.code ?? "unknown"}`;
    console.error(line);
  } else {
    console.info(line);
  }
}

export async function runCleanup(options: RunCleanupOptions = {}): Promise<CleanupCounts> {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? CRON_TIME_BUDGET_MS;
  const sendWarnings = options.sendWarnings ?? noWarnings;
  const start = now();
  const deadline = start + budgetMs;
  const hasTime = () => now() < deadline;

  const sweeps = Object.fromEntries(SWEEPS.map((s) => [s, emptyCount()])) as Record<SweepName, SweepCount>;

  /** Runs one sweep: skip when out of time, time it, catch + log errors, one log line. */
  async function sweep(name: SweepName, body: (c: SweepCount) => Promise<void>): Promise<void> {
    const c = sweeps[name];
    if (!hasTime()) {
      c.complete = false;
      logSweep(name, c, { skipped: true });
      return;
    }
    const t0 = now();
    let code: string | undefined;
    try {
      await body(c);
    } catch (e) {
      c.failed = true;
      c.complete = false;
      code = errorCode(e);
    }
    c.ms = Math.max(0, Math.round(now() - t0));
    logSweep(name, c, { code });
  }

  /** Book-deleting sweep: delete a batch of rows, then remove their prefixes; repeat. */
  async function bookSweep(c: SweepCount, batch: number, fetchBatch: () => Promise<BookRef[]>): Promise<void> {
    for (;;) {
      const books = await fetchBatch();
      c.n += books.length;
      if (books.length > 0) {
        const r = await removeBookPrefixes(books);
        c.storageRemoved += r.storageRemoved;
        c.storageFailures += r.storageFailures;
      }
      if (books.length < batch) return;
      if (!hasTime()) {
        c.complete = false;
        return;
      }
    }
  }

  async function orphanSweep(c: SweepCount, bucket: CleanupBucket): Promise<void> {
    const batch = CLEANUP_BATCH.orphanObjects;
    for (;;) {
      const names = await listOrphanObjects(bucket, ORPHAN_OBJECT_DAYS, batch);
      if (names.length === 0) return;
      let removed: number;
      try {
        removed = await removeStoragePaths(bucket, names);
      } catch {
        // Same objects would be listed again — stop; tomorrow retries.
        c.storageFailures += 1;
        c.complete = false;
        return;
      }
      c.n += removed;
      c.storageRemoved += removed;
      if (names.length < batch) return;
      if (removed === 0) {
        // Storage removed nothing although objects are listed: avoid spinning on them.
        c.complete = false;
        return;
      }
      if (!hasTime()) {
        c.complete = false;
        return;
      }
    }
  }

  await sweep("warnings", async (c) => {
    const r = await sendWarnings({ now, deadline });
    c.n = r.sent;
    c.storageFailures = r.failed;
    c.complete = r.complete ?? true;
  });

  await sweep("expired_books", (c) =>
    bookSweep(c, CLEANUP_BATCH.expiredBooks, () =>
      deleteExpiredBooks(CLEANUP_BATCH.expiredBooks, FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY),
    ),
  );

  await sweep("abandoned_drafts", (c) =>
    bookSweep(c, CLEANUP_BATCH.abandonedDrafts, () =>
      deleteAbandonedDrafts(CLEANUP_BATCH.abandonedDrafts, DRAFT_IDLE_DAYS, DRAFT_NOTICE_DAYS),
    ),
  );

  await sweep("pending_uploads", async (c) => {
    const batch = CLEANUP_BATCH.pendingUploads;
    for (;;) {
      const rows = await deletePendingUploads(batch, PENDING_UPLOAD_DAYS);
      c.n += rows.length;
      const paths = rows.flatMap((r) => r.paths);
      if (paths.length > 0) {
        try {
          c.storageRemoved += await removeStoragePaths("photos", paths);
        } catch {
          // Rows are gone; the objects become orphans and the orphan sweep removes them.
          c.storageFailures += 1;
        }
      }
      if (rows.length < batch) return;
      if (!hasTime()) {
        c.complete = false;
        return;
      }
    }
  });

  await sweep("orphans_photos", (c) => orphanSweep(c, "photos"));
  await sweep("orphans_exports", (c) => orphanSweep(c, "exports"));

  await sweep("old_exports", async (c) => {
    c.n = await deleteOldExportRows(OLD_EXPORT_ROW_DAYS);
  });

  await sweep("unlock_attempts", async (c) => {
    c.n = await deleteOldUnlockAttempts(UNLOCK_ATTEMPT_HOURS);
  });

  await sweep("stale_runs", async (c) => {
    c.n = await reapStaleAgentRuns(STALE_AGENT_RUN_HOURS);
  });

  const all = Object.values(sweeps);
  return {
    ok: all.every((c) => !c.failed),
    complete: all.every((c) => c.complete),
    budgetSpent: !hasTime(),
    ms: Math.max(0, Math.round(now() - start)),
    sweeps,
  };
}

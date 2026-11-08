import "server-only";
// Finalize rate limit + daily reverse-geocode cap (0500, review S2).
// Backed by private.finalize_runs through two service-role-only RPCs
// (public.claim_finalize_run / public.reserve_geocode_calls), so this module
// uses the secret-key admin client. Callers MUST have checked book ownership
// first (finalizeBook → getMyBook under RLS).
// Errors carry only the operation and a Postgres code.
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

export class FinalizeRunsQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "FinalizeRunsQueryError";
    this.code = code;
  }
}

export type ClaimResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Atomically claims a finalize run for the book. ok:false (with seconds to
 * wait) when the previous run started less than `minIntervalSeconds` ago.
 */
export async function claimFinalizeRun(
  bookId: string,
  minIntervalSeconds: number,
): Promise<ClaimResult> {
  if (!isUuid(bookId)) throw new FinalizeRunsQueryError("claim finalize run", "invalid_id");
  const { data, error } = await createAdminClient().rpc("claim_finalize_run", {
    p_book_id: bookId,
    p_min_interval_seconds: minIntervalSeconds,
  });
  if (error) throw new FinalizeRunsQueryError("claim finalize run", error.code);
  const wait = typeof data === "number" && Number.isFinite(data) ? Math.ceil(data) : 0;
  return wait <= 0 ? { ok: true } : { ok: false, retryAfterSeconds: wait };
}

/**
 * Reserves up to `want` reverse-geocode calls for the book today (UTC), never
 * more than `dailyCap` per day. Returns how many were granted (0..want).
 */
export async function reserveGeocodeCalls(
  bookId: string,
  want: number,
  dailyCap: number,
): Promise<number> {
  if (!isUuid(bookId) || want <= 0) return 0;
  const { data, error } = await createAdminClient().rpc("reserve_geocode_calls", {
    p_book_id: bookId,
    p_want: Math.floor(want),
    p_daily_cap: Math.floor(dailyCap),
  });
  if (error) throw new FinalizeRunsQueryError("reserve geocode calls", error.code);
  const n = typeof data === "number" && Number.isFinite(data) ? Math.floor(data) : 0;
  return Math.max(0, Math.min(n, Math.floor(want)));
}

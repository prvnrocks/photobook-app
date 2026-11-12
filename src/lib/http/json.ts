// JSON response helpers for API routes. Every response is `cache-control: no-store`
// (lessons: no-store everywhere) and errors are typed codes, never stack traces.

import { isSupabaseTimeout } from "@/lib/supabase/deadline";

export const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** Safe log code of an unknown error: its `code` (alnum/_/-, ≤32 chars) or "unknown". */
export function errorCodeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
  }
  return "unknown";
}

/** Default Retry-After (seconds) for a Supabase timeout. */
export const UNAVAILABLE_RETRY_AFTER_S = 3;

/**
 * M12 (D-069): a Supabase deadline timeout (SUPABASE_TIMEOUT in any library's error shape, or
 * SupabaseUnavailableError from getCurrentUser) → `503 { error: "unavailable" }` + Retry-After.
 * Anything else → null (the caller keeps its own error answer). Use in every API route's catch:
 *   const unavailable = unavailableIfTimeout(err); if (unavailable) return unavailable;
 */
export function unavailableIfTimeout(err: unknown, retryAfterSeconds = UNAVAILABLE_RETRY_AFTER_S): Response | null {
  if (!isSupabaseTimeout(err)) return null;
  return json({ error: "unavailable" }, 503, { "retry-after": String(retryAfterSeconds) });
}

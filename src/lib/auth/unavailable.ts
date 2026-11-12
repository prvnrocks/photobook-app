// "Supabase Auth did not answer" vs. a real auth answer (M12, D-069). Isomorphic (used by the
// Edge middleware and server code): no "server-only", no supabase-js import — auth-js errors are
// recognised by name, like auth-js's own isAuthRetryableFetchError.
import { isSupabaseTimeout } from "@/lib/supabase/deadline";

/**
 * True for an auth error that means "try again later", never "signed out":
 * - the deadline fetch's synthetic 504 (AuthRetryableFetchError carrying SUPABASE_TIMEOUT),
 * - any other AuthRetryableFetchError (fetch threw, or Auth answered 502 / 503 / 504),
 * - SupabaseUnavailableError (stalled body).
 */
export function isAuthUnavailableError(err: unknown): boolean {
  if (isSupabaseTimeout(err)) return true;
  return Boolean(err && typeof err === "object" && (err as { name?: unknown }).name === "AuthRetryableFetchError");
}

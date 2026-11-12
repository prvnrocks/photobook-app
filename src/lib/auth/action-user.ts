import "server-only";
// Server-action wrapper around getCurrentUser (M12, D-069). getCurrentUser throws
// SupabaseUnavailableError when Supabase Auth does not answer; a server action must not throw it
// to the client (useActionState / transitions would hit the error boundary) — it returns its own
// generic "failed" result instead. Separate module so tests that mock current-user keep working.
import type { User } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSupabaseTimeout } from "@/lib/supabase/deadline";

export const AUTH_UNAVAILABLE = "unavailable" as const;

/** The signed-in user, null when signed out, or "unavailable" when Auth timed out. */
export async function getActionUser(): Promise<User | null | typeof AUTH_UNAVAILABLE> {
  try {
    return await getCurrentUser();
  } catch (err) {
    if (isSupabaseTimeout(err)) {
      console.error("[auth] session check unavailable (SUPABASE_TIMEOUT)");
      return AUTH_UNAVAILABLE;
    }
    throw err;
  }
}

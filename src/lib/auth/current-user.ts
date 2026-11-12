import "server-only";
// The signed-in user for the current request. React `cache` dedupes this per
// server request, so pages and src/lib/db/* share ONE Auth call (plus the one
// in middleware). getUser() verifies the session with Supabase Auth.
//
// M12 (D-069): Supabase Auth not answering (deadline timeout → AuthRetryableFetchError 504
// SUPABASE_TIMEOUT, network failure, Auth 502/503/504) THROWS SupabaseUnavailableError instead of
// returning null — a hung Auth call must never look like "signed out" (401 / login redirect).
// Pages let it reach error.tsx ("Try again"); API routes map it to 503 via unavailableIfTimeout;
// server actions use getActionUser (src/lib/auth/action-user.ts) and return their generic error.
// Real auth answers (no session, invalid / expired JWT, user gone) still return null.
//
// Total cap: one auth request has the 8 s server budget, but auth-js retries a failed token
// refresh with backoff for up to ~30 s. getUser() is raced against CURRENT_USER_AUTH_TOTAL_MS;
// when the cap fires (or the first auth timeout arrives) the client's auth gate closes, so the
// abandoned refresh loop answers the synthetic 504 at once instead of calling Auth again.
import { cache } from "react";
import { isAuthUnavailableError } from "@/lib/auth/unavailable";
import { DEADLINE_BUDGETS, SupabaseUnavailableError } from "@/lib/supabase/deadline";
import { createClientWithAuthGate } from "@/lib/supabase/server";

/** Hard cap on the whole getUser() (one 8 s auth request + a little slack). */
export const CURRENT_USER_AUTH_TOTAL_MS = DEADLINE_BUDGETS.server.authMs + 2_000;

const AUTH_CAP = Symbol("auth-cap");

export const getCurrentUser = cache(async () => {
  const { supabase, closeAuthGate } = await createClientWithAuthGate();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<typeof AUTH_CAP>((resolve) => {
    timer = setTimeout(() => resolve(AUTH_CAP), CURRENT_USER_AUTH_TOTAL_MS);
  });
  const getUser = supabase.auth.getUser();
  try {
    const outcome = await Promise.race([getUser, cap]);
    if (outcome === AUTH_CAP) {
      closeAuthGate();
      getUser.catch(() => {}); // finishes (or not) later; never unhandled
      throw new SupabaseUnavailableError("Supabase Auth did not answer within the total cap (SUPABASE_TIMEOUT)");
    }
    const { data, error } = outcome;
    if (error) {
      if (isAuthUnavailableError(error)) {
        closeAuthGate();
        throw new SupabaseUnavailableError();
      }
      return null;
    }
    return data.user;
  } catch (err) {
    if (err instanceof SupabaseUnavailableError) throw err;
    if (isAuthUnavailableError(err)) {
      closeAuthGate();
      throw new SupabaseUnavailableError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
});

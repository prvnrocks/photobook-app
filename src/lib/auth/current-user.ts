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
import { cache } from "react";
import { isAuthUnavailableError } from "@/lib/auth/unavailable";
import { SupabaseUnavailableError } from "@/lib/supabase/deadline";
import { createClient } from "@/lib/supabase/server";

export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (isAuthUnavailableError(error)) throw new SupabaseUnavailableError();
    return null;
  }
  return data.user;
});

import "server-only";
// Admin Supabase client using the secret key (`sb_secret_…`), bypasses RLS.
// WARNING: server-only (webhooks, cron, PDF export).
// Never import from client code; never use it to act on behalf of a user without
// checking ownership yourself first.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { deadlineClientOptions } from "./deadline";
import { getSupabaseUrl } from "./env";

export function createAdminClient() {
  // Secret key, bypasses RLS. Only ever read here.
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("Missing env var SUPABASE_SECRET_KEY — see .env.example");
  }

  return createClient<Database>(getSupabaseUrl(), secretKey, {
    // Deadline fetch: every call has a time budget; timeouts surface as SUPABASE_TIMEOUT.
    ...deadlineClientOptions("server"),
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

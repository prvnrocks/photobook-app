import "server-only";
// Admin Supabase client using the SERVICE ROLE key.
// WARNING: this BYPASSES Row Level Security. Server-only (webhooks, cron, PDF export).
// Never import from client code; never use it to act on behalf of a user without
// checking ownership yourself first.
import { createClient } from "@supabase/supabase-js";
import { getSupabaseUrl } from "./env";

// TODO(M1): add generated `Database` type generic: createClient<Database>(...)
export function createAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("Missing env var SUPABASE_SERVICE_ROLE_KEY — see .env.example");
  }

  return createClient(getSupabaseUrl(), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

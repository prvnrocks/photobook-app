// Browser Supabase client (publishable key, RLS enforced). Safe for "use client" components.
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { deadlineClientOptions } from "./deadline";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

export function createClient() {
  // Deadline fetch (browser budgets): hung requests become a retryable 504 SUPABASE_TIMEOUT.
  return createBrowserClient<Database>(
    getSupabaseUrl(),
    getSupabasePublishableKey(),
    deadlineClientOptions("browser"),
  );
}

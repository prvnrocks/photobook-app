// Browser Supabase client (anon key, RLS enforced). Safe for "use client" components.
import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

// TODO(M1): add generated `Database` type generic: createBrowserClient<Database>(...)
export function createClient() {
  return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey());
}

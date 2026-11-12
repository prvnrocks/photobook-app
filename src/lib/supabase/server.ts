import "server-only";
// Server Supabase client (publishable key + user session cookies, RLS enforced).
// Use in Server Components, Server Actions and Route Handlers.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { deadlineClientOptions } from "./deadline";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(getSupabaseUrl(), getSupabasePublishableKey(), {
    // Deadline fetch: every call has a time budget; timeouts surface as SUPABASE_TIMEOUT.
    ...deadlineClientOptions("server"),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Safe to ignore when middleware refreshes the session.
        }
      },
    },
  });
}

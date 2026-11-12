import "server-only";
// Server Supabase client (publishable key + user session cookies, RLS enforced).
// Use in Server Components, Server Actions and Route Handlers.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { createGatedAuthFetch } from "./deadline";
import { getSupabasePublishableKey, getSupabaseUrl } from "./env";

/**
 * A server client plus its auth gate (M12, D-069). Every call has a deadline (timeouts surface as
 * SUPABASE_TIMEOUT); after one auth timeout — or `closeAuthGate()` when the caller gives up — later
 * auth calls of this client answer the synthetic 504 at once, so auth-js's ≈ 30 s refresh retry
 * loop makes no more network calls. Used by getCurrentUser for its total cap.
 */
export async function createClientWithAuthGate() {
  const cookieStore = await cookies();
  const gate = createGatedAuthFetch("server");

  const supabase = createServerClient<Database>(getSupabaseUrl(), getSupabasePublishableKey(), {
    global: { fetch: gate.fetch },
    db: { retry: false }, // the deadline fetch owns the single rest GET/HEAD retry
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
  return { supabase, closeAuthGate: gate.close };
}

export async function createClient() {
  return (await createClientWithAuthGate()).supabase;
}

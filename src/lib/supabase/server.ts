import "server-only";
// Server Supabase client (anon key + user session cookies, RLS enforced).
// Use in Server Components, Server Actions and Route Handlers.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

// TODO(M1): add generated `Database` type generic: createServerClient<Database>(...)
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
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

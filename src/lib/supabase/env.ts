// Public Supabase env vars. Safe to import from client code.
// NEXT_PUBLIC_* vars must be referenced literally so Next.js inlines them
// into the client bundle. NEVER add the service-role key here — see admin.ts.

function missing(name: string): never {
  throw new Error(`Missing env var ${name} — see .env.example`);
}

export function getSupabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) missing("NEXT_PUBLIC_SUPABASE_URL");
  return value;
}

export function getSupabaseAnonKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!value) missing("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return value;
}

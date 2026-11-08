import "server-only";
// Profile of the signed-in user: email from the auth user, name from public.profiles.
import { getCurrentUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";

export type MyProfile = { id: string; name: string | null; email: string | null };

export class ProfilesQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "ProfilesQueryError";
    this.code = code;
  }
}

/** Current user's profile, or null if signed out. */
export async function getMyProfile(): Promise<MyProfile | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("name")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw new ProfilesQueryError("load profile", error.code);
  return { id: user.id, name: data?.name ?? null, email: user.email ?? null };
}

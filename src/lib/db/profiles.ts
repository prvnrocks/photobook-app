import "server-only";
// Profile of the signed-in user: email from the auth user, name from public.profiles.
// setEmailReminders uses the admin client (unsubscribe route has no session).
import { getCurrentUser } from "@/lib/auth/current-user";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

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

/**
 * Turns reminder emails (D-057: link-expiry and draft-deletion warnings) on or off for a user.
 * Admin client — used by the one-click unsubscribe route (token-verified, no session) and by the
 * settings action, which must pass the signed-in user's own id. Returns false when the user no
 * longer exists. Throws ProfilesQueryError (code only) on other failures.
 */
export async function setEmailReminders(userId: string, on: boolean): Promise<boolean> {
  if (!isUuid(userId) || typeof on !== "boolean") return false;
  const id = userId.toLowerCase();
  // Upsert: a profile row normally exists (on_auth_user_created), but never silently drop an
  // opt-out because it is missing. A deleted user → FK violation (23503) → false.
  const { data, error } = await createAdminClient()
    .from("profiles")
    .upsert({ id, email_reminders: on }, { onConflict: "id" })
    .select("id");
  if (error) {
    if (error.code === "23503") return false;
    throw new ProfilesQueryError("update email reminders", error.code);
  }
  return (data ?? []).length > 0;
}

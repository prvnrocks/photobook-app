"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteAccountCompletely } from "@/lib/account/delete-account";
import { getCurrentUser } from "@/lib/auth/current-user";
import { clearMemoryFromActiveRuns } from "@/lib/db/agent-runs";
import { deleteOwnMemory } from "@/lib/db/memory";
import { setEmailReminders } from "@/lib/db/profiles";
import { errorCodeOf } from "@/lib/http/json";
import {
  ACCOUNT_DELETED_HREF,
  isDeleteConfirmed,
  type DeleteAccountActionResult,
  type SetEmailRemindersResult,
} from "@/lib/settings/account";
import { createClient } from "@/lib/supabase/server";

export type ClearMemoryResult =
  | { ok: true; cleared: boolean }
  | { ok: false; error: "signed_out" | "failed" };

/**
 * Settings → "Forget what you learned" (D-032): deletes the signed-in user's user_memory row
 * under RLS. `cleared` is false when there was nothing to forget. Logs an error code only.
 */
export async function clearMemoryAction(): Promise<ClearMemoryResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "signed_out" };
  try {
    const cleared = await deleteOwnMemory();
    // Best effort (M4 review SF8): drop the memory snapshot from unfinished runs.
    // Failure never changes the result; logged as a code only.
    try {
      await clearMemoryFromActiveRuns(user.id);
    } catch (err) {
      console.error(`[settings] clear run memory failed (${errorCodeOf(err)})`);
    }
    revalidatePath("/settings");
    return { ok: true, cleared };
  } catch (err) {
    console.error(`[settings] clear memory failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

/**
 * Settings → "Email reminders" (D-057): sets profiles.email_reminders for the SIGNED-IN user only
 * (session id → setEmailReminders, shared with the unsubscribe route; upserts so an opt-out is never
 * lost to a missing profile row). Saves immediately; the client keeps its optimistic value on success.
 */
export async function setEmailRemindersAction(on: boolean): Promise<SetEmailRemindersResult> {
  if (typeof on !== "boolean") return { ok: false, error: "invalid" };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  try {
    const updated = await setEmailReminders(user.id, on);
    if (!updated) {
      console.error("[settings] set email reminders failed (no_row)");
      return { ok: false, error: "failed" };
    }
    revalidatePath("/settings");
    return { ok: true, on };
  } catch (err) {
    console.error(`[settings] set email reminders failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

/**
 * Settings → "Delete account" (D-060). Requires `confirm` === "DELETE". Deletes every book of the
 * user (paid ones too), their Storage files and the auth user — refused with
 * 'payment_in_progress' while an order is pending, 'payment_in_review' while an order is disputed /
 * needs_review (src/lib/account/delete-account.ts). On success
 * signs out and redirects to "/?account=deleted" (never returns).
 */
export async function deleteAccountAction(confirm: string): Promise<DeleteAccountActionResult> {
  if (!isDeleteConfirmed(confirm)) return { ok: false, error: "confirm" };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  const result = await deleteAccountCompletely(user.id);
  if (!result.ok) {
    const error =
      result.error === "payment_in_progress" || result.error === "payment_in_review" ? result.error : "failed";
    return { ok: false, error };
  }

  // The auth user is gone; clear the session cookies. The Auth API may answer 403/404 for the
  // deleted user — supabase-js still removes the local session, and we redirect regardless.
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch (err) {
    console.error(`[settings] sign out after delete failed (${errorCodeOf(err)})`);
  }
  redirect(ACCOUNT_DELETED_HREF);
}

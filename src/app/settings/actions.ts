"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { deleteOwnMemory } from "@/lib/db/memory";
import { errorCodeOf } from "@/lib/http/json";

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
    revalidatePath("/settings");
    return { ok: true, cleared };
  } catch (err) {
    console.error(`[settings] clear memory failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

import "server-only";
// Authorized entitlement grants (Task 9): the ONLY non-payment way to give a book full storybook
// generation. Server-only, service role, admin allow-list (ADMIN_USER_IDS) — there is no route,
// server action or client path that calls this; it is for support tooling / scripts run by an
// operator. A grant never sets books.is_paid, so it never unlocks the PDF, the watermark-free
// viewer or the permanent link (those stay with the Stripe webhook / comp_book).
//
// Nothing here logs ids or the reason text.

import { isAdminUser } from "@/lib/auth/is-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

export type GrantResult = { ok: true; status: "granted" | "already_granted" } | { ok: false; error: "not_admin" | "invalid" | "not_found" | "failed" };
export type RevokeResult = { ok: true; revoked: number } | { ok: false; error: "not_admin" | "invalid" | "failed" };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function validGrantReason(reason: unknown): reason is string {
  if (typeof reason !== "string") return false;
  const t = reason.trim();
  return t.length >= 1 && [...t].length <= 200 && !CONTROL.test(reason);
}

export type GrantDeps = { isAdmin?: (userId: string) => boolean; client?: () => ReturnType<typeof createAdminClient> };

export async function grantBookEntitlement(input: { bookId: string; adminUserId: string; reason: string }, deps: GrantDeps = {}): Promise<GrantResult> {
  if (!(deps.isAdmin ?? isAdminUser)(input.adminUserId)) return { ok: false, error: "not_admin" };
  if (!isUuid(input.bookId) || !validGrantReason(input.reason)) return { ok: false, error: "invalid" };
  const db = (deps.client ?? createAdminClient)();
  const book = await db.from("books").select("id").eq("id", input.bookId).maybeSingle();
  if (book.error) return { ok: false, error: "failed" };
  if (!book.data) return { ok: false, error: "not_found" };
  const { error } = await db.from("book_entitlements").insert({ book_id: input.bookId, reason: input.reason.trim(), granted_by: input.adminUserId });
  if (!error) return { ok: true, status: "granted" };
  if (error.code === "23505") return { ok: true, status: "already_granted" };
  return { ok: false, error: "failed" };
}

export async function revokeBookEntitlement(input: { bookId: string; adminUserId: string }, deps: GrantDeps = {}): Promise<RevokeResult> {
  if (!(deps.isAdmin ?? isAdminUser)(input.adminUserId)) return { ok: false, error: "not_admin" };
  if (!isUuid(input.bookId)) return { ok: false, error: "invalid" };
  const { data, error } = await (deps.client ?? createAdminClient)()
    .from("book_entitlements")
    .update({ revoked_at: new Date().toISOString() })
    .eq("book_id", input.bookId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, error: "failed" };
  return { ok: true, revoked: data?.length ?? 0 };
}

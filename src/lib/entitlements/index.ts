import "server-only";
// getBookEntitlement(bookId) — the ONE place storybook gating, preview caps, cost buckets and the
// PDF export gate ask "what may this book do?" (Task 9). Built on books.is_paid (set only by the
// Stripe webhook / comp_book) plus authorized grants (book_entitlements, migration 2900).
//
// Admin client: callers MUST have checked that the signed-in user owns the book (getMyBook under
// RLS) or hold a run row of it. Without migration 2900 the grant lookup fails "missing table" and
// is treated as no grant (is_paid alone decides). Nothing here logs ids.

import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";
import { resolveEntitlement, type BookEntitlement, type EntitlementFacts } from "./resolve";

export type { BookEntitlement, EntitlementSource, EntitlementTier } from "./resolve";
export { resolveEntitlement } from "./resolve";

export class EntitlementError extends Error {
  constructor(
    what: string,
    public readonly code: string | undefined,
  ) {
    super(`${what} failed${code ? ` (${code})` : ""}`);
    this.name = "EntitlementError";
  }
}

const missing = (code: string | undefined) => code === "42P01" || code === "PGRST205";

export type EntitlementDeps = { readFacts?: (bookId: string) => Promise<EntitlementFacts | null> };

/** Server facts of the book (is_paid, max_pages, paying order status, active grant), or null. */
export async function readEntitlementFacts(bookId: string): Promise<EntitlementFacts | null> {
  if (!isUuid(bookId)) return null;
  const admin = createAdminClient();
  const [book, grant] = await Promise.all([
    admin.from("books").select("id, is_paid, max_pages").eq("id", bookId).maybeSingle(),
    admin.from("book_entitlements").select("id").eq("book_id", bookId).is("revoked_at", null).limit(1),
  ]);
  if (book.error) throw new EntitlementError("read book entitlement", book.error.code);
  if (!book.data) return null;
  if (grant.error && !missing(grant.error.code)) throw new EntitlementError("read grant", grant.error.code);
  let orderStatus: string | null = null;
  if (book.data.is_paid) {
    const order = await admin.from("orders").select("status").eq("book_id", bookId).in("status", ["paid", "comped"]).order("created_at", { ascending: false }).limit(1);
    if (order.error) throw new EntitlementError("read paying order", order.error.code);
    orderStatus = order.data?.[0]?.status ?? null;
  }
  return { bookId, isPaid: book.data.is_paid === true, maxPages: book.data.max_pages, orderStatus, hasActiveGrant: !grant.error && (grant.data?.length ?? 0) > 0 };
}

/** The book's entitlement, or null when the book does not exist. Throws EntitlementError on a DB error. */
export async function getBookEntitlement(bookId: string, deps: EntitlementDeps = {}): Promise<BookEntitlement | null> {
  const facts = await (deps.readFacts ?? readEntitlementFacts)(bookId);
  return facts ? resolveEntitlement(facts) : null;
}

/** Tier only, failing safe: unknown / error → "preview" (never unlocks anything by accident). */
export async function getEntitlementTier(bookId: string, deps: EntitlementDeps = {}): Promise<"preview" | "full"> {
  try {
    return (await getBookEntitlement(bookId, deps))?.tier ?? "preview";
  } catch {
    return "preview";
  }
}

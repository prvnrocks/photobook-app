import "server-only";
// public.storybooks (migration 2200) — the book's memory context (Task 5).
//
// Admin client throughout: the table is owner-read-only under RLS and every write is server-side.
// Callers MUST have checked book ownership under RLS first (getMyBook); every query here is also
// filtered by book_id + user_id. The context is user data: never log it — codes only.

import { MemoryContextSchema } from "@/lib/storybook/schemas";
import type { MemoryContext } from "@/lib/storybook/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export class StorybooksQueryError extends Error {
  constructor(
    what: string,
    public readonly code: string | undefined,
  ) {
    super(`${what} failed${code ? ` (${code})` : ""}`);
    this.name = "StorybooksQueryError";
  }
}

/** Postgres "relation does not exist" / PostgREST "table not in schema cache": migration 2200 not applied. */
function isMissingTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

const MAX_REV = 100000; // = MemoryContextSchema.rev
const UNIQUE_VIOLATION = "23505";

/** What the caller decides; `rev` and `updatedAt` are set here. */
export type MemoryContextInput = Omit<MemoryContext, "rev" | "updatedAt">;

type Row = { context: Json; context_rev: number };

async function readRow(bookId: string, userId: string): Promise<Row | null> {
  const { data, error } = await createAdminClient()
    .from("storybooks")
    .select("context, context_rev")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new StorybooksQueryError("load memory context", error.code);
  return data;
}

function parseContext(value: Json): MemoryContext | null {
  const parsed = MemoryContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The stored memory context of the user's book. `null` when there is no row, the context is still
 * `{}`, it does not parse (an older shape), or the table does not exist yet.
 */
export async function getMemoryContext(bookId: string, userId: string): Promise<MemoryContext | null> {
  if (!isUuid(bookId) || !isUuid(userId)) return null;
  try {
    const row = await readRow(bookId, userId);
    return row ? parseContext(row.context) : null;
  } catch (err) {
    if (err instanceof StorybooksQueryError && isMissingTable(err.code)) return null;
    throw err;
  }
}

/**
 * Writes the memory context: inserts the storybooks row (status 'empty' by default) or updates
 * context + context_rev of the existing one (status and versions untouched). `rev` =
 * `context_rev` = previous + 1; `updatedAt` = now. Validated with MemoryContextSchema before the
 * write. The update is guarded by the previous context_rev (two saves at once: the loser retries
 * once on top of the winner's revision). Throws StorybooksQueryError (missing table included).
 */
export async function saveMemoryContext(bookId: string, userId: string, input: MemoryContextInput): Promise<MemoryContext> {
  if (!isUuid(bookId) || !isUuid(userId)) throw new StorybooksQueryError("save memory context", "bad_id");
  const admin = createAdminClient();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const row = await readRow(bookId, userId);
    const prevRev = Math.max(row?.context_rev ?? 0, row ? (parseContext(row.context)?.rev ?? 0) : 0);
    if (prevRev >= MAX_REV) throw new StorybooksQueryError("save memory context", "rev_limit");

    const parsed = MemoryContextSchema.safeParse({ ...input, rev: prevRev + 1, updatedAt: new Date().toISOString() });
    if (!parsed.success) throw new StorybooksQueryError("save memory context", "invalid_context");
    const next = parsed.data;
    const context = next as unknown as Json;

    if (row) {
      const { data, error } = await admin
        .from("storybooks")
        .update({ context, context_rev: next.rev })
        .eq("book_id", bookId)
        .eq("user_id", userId)
        .eq("context_rev", row.context_rev)
        .select("book_id");
      if (error) throw new StorybooksQueryError("save memory context", error.code);
      if (data && data.length > 0) return next;
    } else {
      const { error } = await admin.from("storybooks").insert({ book_id: bookId, user_id: userId, context, context_rev: next.rev });
      if (!error) return next;
      if (error.code !== UNIQUE_VIOLATION) throw new StorybooksQueryError("save memory context", error.code);
    }
  }
  throw new StorybooksQueryError("save memory context", "conflict");
}

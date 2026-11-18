import "server-only";
// public.storybooks (migration 2200) — the book's memory context (Task 5) and the story versions
// in public.storybook_versions (Task 6: getCurrentStorybook / appendStorybookVersion).
//
// Admin client throughout: the table is owner-read-only under RLS and every write is server-side.
// Callers MUST have checked book ownership under RLS first (getMyBook); every query here is also
// filtered by book_id + user_id. The context is user data: never log it — codes only.

import { MemoryContextSchema, StorybookSchema } from "@/lib/storybook/schemas";
import type { MemoryContext, Storybook } from "@/lib/storybook/types";
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

// ---------------------------------------------------------------------------- story versions (Task 6)

/**
 * The current story version of the user's book (storybooks.current_version → the matching
 * storybook_versions row, validated with StorybookSchema). `null` when the book has no version
 * yet, the stored content does not parse, or the tables do not exist.
 */
export async function getCurrentStorybook(bookId: string, userId: string): Promise<Storybook | null> {
  if (!isUuid(bookId) || !isUuid(userId)) return null;
  const admin = createAdminClient();
  const head = await admin.from("storybooks").select("current_version").eq("book_id", bookId).eq("user_id", userId).maybeSingle();
  if (head.error) {
    if (isMissingTable(head.error.code)) return null;
    throw new StorybooksQueryError("load storybook", head.error.code);
  }
  const version = head.data?.current_version ?? 0;
  if (version < 1) return null;
  const row = await admin.from("storybook_versions").select("content").eq("book_id", bookId).eq("user_id", userId).eq("version", version).maybeSingle();
  if (row.error) {
    if (isMissingTable(row.error.code)) return null;
    throw new StorybooksQueryError("load storybook version", row.error.code);
  }
  if (!row.data) return null;
  const parsed = StorybookSchema.safeParse(row.data.content);
  return parsed.success && parsed.data.bookId === bookId && parsed.data.version === version ? parsed.data : null;
}

export type AppendStorybookResult = "ok" | "conflict";

/**
 * Appends `storybook` as the next version of the user's book and makes it current. Optimistic:
 * `storybook.version` must be current_version + 1 at the moment of the write.
 *   1. the storybooks row is created if the book has none yet (status 'empty', version 0);
 *   2. the version row is inserted — UNIQUE (book_id, version) lets exactly one of two
 *      concurrent appends through, the other gets "conflict" and has written nothing;
 *   3. the pointer moves (current_version, status 'ready') guarded by the previous value; if
 *      that does not hit the row, the version row is removed again and the result is "conflict",
 *      so no version is ever left behind without being current.
 * The storybook is validated with StorybookSchema before anything is written.
 */
export async function appendStorybookVersion(storybook: Storybook, userId: string): Promise<AppendStorybookResult> {
  const parsed = StorybookSchema.safeParse(storybook);
  if (!parsed.success || !isUuid(userId)) throw new StorybooksQueryError("append storybook version", "invalid_storybook");
  const s = parsed.data;
  const admin = createAdminClient();
  const previous = s.version - 1;

  const head = await admin.from("storybooks").select("current_version").eq("book_id", s.bookId).eq("user_id", userId).maybeSingle();
  if (head.error) throw new StorybooksQueryError("append storybook version", head.error.code);
  if (!head.data) {
    const created = await admin.from("storybooks").insert({ book_id: s.bookId, user_id: userId });
    if (created.error && created.error.code !== UNIQUE_VIOLATION) throw new StorybooksQueryError("append storybook version", created.error.code);
    if (previous !== 0 && !created.error) return "conflict";
  } else if (head.data.current_version !== previous) return "conflict";

  const inserted = await admin.from("storybook_versions").insert({
    book_id: s.bookId,
    user_id: userId,
    version: s.version,
    parent_version: s.parentVersion,
    origin: s.origin,
    schema_version: s.v,
    content: s as unknown as Json,
    generator: s.generator as unknown as Json,
  });
  if (inserted.error) {
    if (inserted.error.code === UNIQUE_VIOLATION) return "conflict";
    throw new StorybooksQueryError("append storybook version", inserted.error.code);
  }

  const moved = await admin
    .from("storybooks")
    .update({ current_version: s.version, status: "ready" })
    .eq("book_id", s.bookId)
    .eq("user_id", userId)
    .eq("current_version", previous)
    .select("book_id");
  if (!moved.error && moved.data && moved.data.length > 0) return "ok";
  // the pointer did not move: take the version back so nothing is half-written
  await admin.from("storybook_versions").delete().eq("book_id", s.bookId).eq("user_id", userId).eq("version", s.version);
  if (moved.error) throw new StorybooksQueryError("append storybook version", moved.error.code);
  return "conflict";
}

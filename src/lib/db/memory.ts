import "server-only";
// user_memory queries (0600; Memory Keeper D-032).
//
// Privileges: authenticated may only SELECT / DELETE its own row (RLS
// user_memory_select_own / user_memory_delete_own); writes are server-side
// with the secret-key admin client. Owner-facing reads and "forget me" use the
// RLS client; the orchestrator / review action use the admin helpers after
// they have resolved the user themselves (never a client-supplied id).
//
// Privacy: prefs are user data. Nothing here logs, and errors carry only the
// operation and a code — never prefs content or ids. The shape of prefs is
// validated by callers with UserMemorySchema (src/lib/ai/schemas.ts); this
// module only enforces "JSON object, ≤ 8 KB" so the DB check never trips.
import { isEmptyMemory, sanitizeMemory } from "@/lib/ai/memory";
import type { CaptionLength } from "@/lib/ai/schemas";
import { getCurrentUser } from "@/lib/auth/current-user";
import type { CaptionLang, Tone } from "@/lib/book/options";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export type UserMemoryRow = { prefs: Json; updatedAt: string };

/** Mirrors user_memory_prefs_size (pg_column_size(prefs) <= 8192). */
export const USER_MEMORY_MAX_BYTES = 8192;

export type MemoryErrorCode = "invalid_id" | "invalid_prefs" | "too_large" | (string & {});

export class MemoryQueryError extends Error {
  readonly code: MemoryErrorCode | undefined;

  constructor(operation: string, code?: MemoryErrorCode) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "MemoryQueryError";
    this.code = code;
  }
}

const CHECK_VIOLATION = "23514";
// Well-formed JSON.stringify writes a lone UTF-16 surrogate as a `\udXXX`
// escape (paired surrogates stay literal), which Postgres rejects in jsonb.
// An odd number of backslashes before `u` = a real escape, not user text.
const LONE_SURROGATE_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/**
 * Serialized size check used before writing. Throws MemoryQueryError
 * 'invalid_prefs' (not a JSON object / not serialisable / lone surrogate) or
 * 'too_large' (> 8 KB as UTF-8 JSON). Exported for tests.
 */
export function assertMemoryWritable(prefs: unknown): void {
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
    throw new MemoryQueryError("save memory", "invalid_prefs");
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(prefs);
  } catch {
    throw new MemoryQueryError("save memory", "invalid_prefs");
  }
  if (typeof text !== "string" || LONE_SURROGATE_ESCAPE.test(text)) {
    throw new MemoryQueryError("save memory", "invalid_prefs");
  }
  if (new TextEncoder().encode(text).byteLength > USER_MEMORY_MAX_BYTES) {
    throw new MemoryQueryError("save memory", "too_large");
  }
}

function toRow(data: { prefs: Json; updated_at: string } | null): UserMemoryRow | null {
  return data ? { prefs: data.prefs, updatedAt: data.updated_at } : null;
}

/** Server-side read of a user's memory (admin client). Caller resolved `userId` itself. */
export async function getUserMemoryAdmin(userId: string): Promise<UserMemoryRow | null> {
  if (!isUuid(userId)) throw new MemoryQueryError("load memory", "invalid_id");
  const { data, error } = await createAdminClient()
    .from("user_memory")
    .select("prefs, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new MemoryQueryError("load memory", error.code);
  return toRow(data);
}

/** Signed-in user's own memory under RLS; null when signed out or nothing learned yet. */
export async function getOwnMemory(): Promise<UserMemoryRow | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_memory")
    .select("prefs, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new MemoryQueryError("load memory", error.code);
  return toRow(data);
}

/**
 * Creates or replaces a user's memory (admin client; clients have no write
 * privileges). Size/shape is checked before any request.
 */
export async function upsertUserMemory(userId: string, prefs: Json): Promise<void> {
  if (!isUuid(userId)) throw new MemoryQueryError("save memory", "invalid_id");
  assertMemoryWritable(prefs);
  const { error } = await createAdminClient()
    .from("user_memory")
    .upsert({ user_id: userId, prefs }, { onConflict: "user_id" });
  if (error) {
    // jsonb can be slightly larger than its text form — map the DB size check too.
    throw new MemoryQueryError("save memory", error.code === CHECK_VIOLATION ? "too_large" : error.code);
  }
}

/** "Forget what you learned": deletes the signed-in user's row under RLS. True if a row was removed. */
export async function deleteOwnMemory(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("user_memory")
    .delete({ count: "exact" })
    .eq("user_id", user.id);
  if (error) throw new MemoryQueryError("delete memory", error.code);
  return (count ?? 0) > 0;
}

/** What the Settings page and the new-book form may show — sanitized, enums + cleaned strings only. */
export type OwnMemoryView = {
  tone?: Tone;
  captionLength?: CaptionLength;
  language?: CaptionLang;
  knownNames: string[];
  avoid: string[];
  updatedAt: string;
};

/**
 * Signed-in user's memory for display (RLS read + sanitizeMemory). null when signed out or
 * nothing has been learned yet (no row, or a row that sanitizes to nothing usable). Throws
 * MemoryQueryError on a DB error — callers that only prefill treat that as null.
 */
export async function getOwnMemoryView(): Promise<OwnMemoryView | null> {
  const row = await getOwnMemory();
  if (!row) return null;
  const mem = sanitizeMemory(row.prefs);
  if (isEmptyMemory(mem)) return null;
  const view: OwnMemoryView = {
    knownNames: mem.knownNames ?? [],
    avoid: mem.avoid ?? [],
    updatedAt: row.updatedAt,
  };
  if (mem.tonePreference) view.tone = mem.tonePreference;
  if (mem.captionLength) view.captionLength = mem.captionLength;
  if (mem.language) view.language = mem.language;
  return view;
}

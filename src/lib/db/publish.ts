import "server-only";
// Owner publish queries (M6, D-039 / D-040; extends D-011 / D-036). Admin client throughout:
// published_doc / published_rev / last_published_at / slug / published_at / expires_at /
// password_hash are server-only columns (protect_book_columns). Every query is scoped by
// id AND user_id = ownerId; the caller MUST have resolved ownerId from the session and checked
// ownership under RLS (getMyBook) first.
//
// Errors carry codes only (PublishQueryError) — never doc text, titles or password material.

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export class PublishQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "PublishQueryError";
    this.code = code;
  }
}

/** What publish / publish-state need. `password_hash` itself is never returned. */
export type PublishRow = {
  id: string;
  title: string | null;
  doc: Json;
  doc_rev: number;
  max_pages: number;
  is_paid: boolean;
  slug: string | null;
  published_at: string | null;
  expires_at: string | null;
  published_rev: number | null;
  last_published_at: string | null;
  /** published_doc is not null (read as a JSON path; the snapshot itself is not loaded). */
  live: boolean;
  hasPassword: boolean;
};

const PUBLISH_COLUMNS =
  "id, title, doc, doc_rev, max_pages, is_paid, slug, published_at, expires_at, published_rev, last_published_at, live_version:published_doc->version, password_hash";

type RawPublishRow = Omit<PublishRow, "live" | "hasPassword"> & {
  live_version: unknown;
  password_hash: string | null;
};

/** The owner's book for publishing, or null (malformed ids / missing / not the owner's). */
export async function getPublishRow(bookId: string, ownerId: string): Promise<PublishRow | null> {
  if (!isUuid(bookId) || !isUuid(ownerId)) return null;
  const { data, error } = await createAdminClient()
    .from("books")
    .select(PUBLISH_COLUMNS)
    .eq("id", bookId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) throw new PublishQueryError("load publish state", error.code);
  if (!data) return null;
  const raw = data as unknown as RawPublishRow;
  return {
    id: raw.id,
    title: raw.title,
    doc: raw.doc,
    doc_rev: raw.doc_rev,
    max_pages: raw.max_pages,
    is_paid: raw.is_paid,
    slug: raw.slug,
    published_at: raw.published_at,
    expires_at: raw.expires_at,
    published_rev: raw.published_rev,
    last_published_at: raw.last_published_at,
    live: raw.live_version !== null && raw.live_version !== undefined,
    hasPassword: typeof raw.password_hash === "string" && raw.password_hash.length > 0,
  };
}

export type PublishSnapshotInput = {
  bookId: string;
  ownerId: string;
  /** Snapshot of the doc at `read.docRev` (toPublicDoc). */
  publishedDoc: Json;
  slug: string;
  /** published_at to write: the existing first-publish time, or now on first publish. */
  publishedAt: string;
  /** nextExpiry(...) — null for paid books. */
  expiresAt: string | null;
  now: string;
  /** Values the caller read and based its decisions on; the UPDATE only applies if unchanged. */
  read: {
    docRev: number;
    isPaid: boolean;
    slug: string | null;
    publishedAt: string | null;
    expiresAt: string | null;
  };
};

export type PublishSnapshotResult =
  | { ok: true }
  | { ok: false; reason: "conflict" | "slug_taken" };

/**
 * One UPDATE … WHERE id AND user_id AND doc_rev = read AND is_paid / slug / published_at /
 * expires_at = read. So: a save landing between read and write → conflict (client flushes
 * autosave and retries); a webhook flipping is_paid, or a concurrent first publish setting
 * slug / published_at / expires_at → conflict too, never an overwrite (D-039: expiry fixed at
 * first publish, slug never changes). published_rev = read.docRev (doc_rev itself is untouched:
 * books_set_doc_rev only bumps it when doc changes).
 * 23505 (books_slug_key — the only unique key this UPDATE can violate) → slug_taken.
 */
export async function publishSnapshot(input: PublishSnapshotInput): Promise<PublishSnapshotResult> {
  if (!isUuid(input.bookId) || !isUuid(input.ownerId)) return { ok: false, reason: "conflict" };
  const { read } = input;
  let q = createAdminClient()
    .from("books")
    .update({
      published_doc: input.publishedDoc,
      published_rev: read.docRev,
      last_published_at: input.now,
      published_at: input.publishedAt,
      expires_at: input.expiresAt,
      slug: input.slug,
    })
    .eq("id", input.bookId)
    .eq("user_id", input.ownerId)
    .eq("doc_rev", read.docRev)
    .eq("is_paid", read.isPaid);
  q = read.slug === null ? q.is("slug", null) : q.eq("slug", read.slug);
  q = read.publishedAt === null ? q.is("published_at", null) : q.eq("published_at", read.publishedAt);
  q = read.expiresAt === null ? q.is("expires_at", null) : q.eq("expires_at", read.expiresAt);

  const { data, error } = await q.select("id");
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "slug_taken" };
    throw new PublishQueryError("publish book", error.code);
  }
  return data.length === 1 ? { ok: true } : { ok: false, reason: "conflict" };
}

export type OwnerWriteResult = { ok: true; slug: string | null } | { ok: false; reason: "not_found" };

/**
 * Unpublish (D-039): published_doc = null only. slug, published_at, expires_at, published_rev
 * and last_published_at stay — the free-link clock doesn't pause and the slug never changes.
 */
export async function unpublishBook(bookId: string, ownerId: string): Promise<OwnerWriteResult> {
  if (!isUuid(bookId) || !isUuid(ownerId)) return { ok: false, reason: "not_found" };
  const { data, error } = await createAdminClient()
    .from("books")
    .update({ published_doc: null })
    .eq("id", bookId)
    .eq("user_id", ownerId)
    .select("slug");
  if (error) throw new PublishQueryError("unpublish book", error.code);
  return data.length === 1 ? { ok: true, slug: data[0].slug } : { ok: false, reason: "not_found" };
}

/** Sets (scrypt hash from hashPassword) or clears (null) books.password_hash. */
export async function setBookPasswordHash(
  bookId: string,
  ownerId: string,
  passwordHash: string | null,
): Promise<OwnerWriteResult> {
  if (!isUuid(bookId) || !isUuid(ownerId)) return { ok: false, reason: "not_found" };
  const { data, error } = await createAdminClient()
    .from("books")
    .update({ password_hash: passwordHash })
    .eq("id", bookId)
    .eq("user_id", ownerId)
    .select("slug");
  if (error) throw new PublishQueryError("set book password", error.code);
  return data.length === 1 ? { ok: true, slug: data[0].slug } : { ok: false, reason: "not_found" };
}

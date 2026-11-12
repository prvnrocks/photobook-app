"use server";

// Owner publish actions (M6, D-039 / D-040). Only the book id (and the password) come from the
// client; the doc, limits, paid status and expiry are read server-side. Results are stable codes;
// logs carry error codes only — never doc text, titles, slugs, ids or password material (D-027).

import { revalidatePath } from "next/cache";
import { learnFromBook } from "@/lib/ai/learn-from-book";
import { AUTH_UNAVAILABLE, getActionUser } from "@/lib/auth/action-user";
import { getSiteUrl } from "@/lib/auth/redirect";
import { validateBookDoc } from "@/lib/book/schema";
import { stripUnusableAiPhotoBackgrounds } from "@/lib/design/background-suggest";
import { getMyBook } from "@/lib/db/books";
import { listPlaceablePhotos } from "@/lib/db/photos";
import {
  getPublishRow,
  publishSnapshot,
  setBookPasswordHash,
  unpublishBook,
  type PublishRow,
} from "@/lib/db/publish";
import { errorCodeOf } from "@/lib/http/json";
import { hashPassword, validatePasswordInput } from "@/lib/publish/password";
import { getAccessSecret } from "@/lib/publish/access-cookie";
import { toPublicDoc } from "@/lib/publish/public-doc";
import { canPublish, isExpired, nextExpiry, type PublishBlockReason } from "@/lib/publish/rules";
import { makeSlug } from "@/lib/publish/slug";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

/** New-slug attempts before giving up on books_slug_key collisions (58^10 space: ~never > 1). */
const SLUG_ATTEMPTS = 5;

export type PublishErrorCode =
  | "signed_out"
  | "not_found"
  | PublishBlockReason // invalid_doc | empty | page_limit | expired
  | "conflict"
  | "failed";

export type PublishBookResult =
  | { ok: true; slug: string; url: string; expiresAt: string | null }
  | { ok: false; error: PublishErrorCode };

export type UnpublishBookResult = { ok: true } | { ok: false; error: "signed_out" | "not_found" | "failed" };

export type SetPasswordErrorCode =
  | "signed_out"
  | "not_found"
  | "invalid_password"
  | "too_short"
  | "too_long"
  | "invalid_chars"
  /** BOOK_ACCESS_SECRET is not configured: a password could never be unlocked, so none is set. */
  | "unavailable"
  | "failed";

export type SetBookPasswordResult = { ok: true; hasPassword: boolean } | { ok: false; error: SetPasswordErrorCode };

export type PublishState = {
  /** published_doc is not null (live at /b/[slug] unless expired). */
  published: boolean;
  slug: string | null;
  url: string | null;
  /** Live and the saved doc moved on since the snapshot → "Publish changes". */
  hasChanges: boolean;
  expiresAt: string | null;
  /** Free link past its 30 days (D-039) — republish blocked, "Upgrade to bring it back". */
  expired: boolean;
  isPaid: boolean;
  hasPassword: boolean;
  /** First publish time (null = never published). */
  publishedAt: string | null;
  lastPublishedAt: string | null;
  pageCount: number;
  maxPages: number;
  /** null = publishable by the cheap rules; otherwise why the Publish button is disabled. */
  canPublishReason: PublishBlockReason | null;
};

export type GetPublishStateResult = { ok: true; state: PublishState } | { ok: false; error: "signed_out" | "not_found" | "failed" };

type Owner = { userId: string; bookId: string };

/** Session user + RLS ownership check (getMyBook). */
async function resolveOwner(bookId: unknown, tag: string): Promise<Owner | { error: "signed_out" | "not_found" | "failed" }> {
  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { error: "failed" };
  if (!user) return { error: "signed_out" };
  if (typeof bookId !== "string" || !isUuid(bookId)) return { error: "not_found" };
  try {
    const mine = await getMyBook(bookId);
    if (!mine) return { error: "not_found" };
    return { userId: user.id, bookId: mine.id };
  } catch (err) {
    console.error(`[${tag}] load failed (${errorCodeOf(err)})`);
    return { error: "failed" };
  }
}

function publicUrl(slug: string): string {
  return `${getSiteUrl()}/b/${slug}`;
}

function revalidateBook(bookId: string, slug: string | null): void {
  revalidatePath("/dashboard");
  revalidatePath(`/books/${bookId}/publish`);
  if (slug) revalidatePath(`/b/${slug}`);
}

/**
 * Publish / "Publish changes" (D-039): snapshots the SAVED doc into books.published_doc.
 * Flush any pending autosave first; `conflict` means the doc (or paid status / first publish)
 * changed between read and write — flush again and retry. Errors: signed_out, not_found,
 * expired, invalid_doc (bad shape or a photo that isn't this book's), empty, page_limit,
 * conflict, failed. Memory learning afterwards is best effort and never fails the action.
 */
export async function publishBookAction(bookId: string): Promise<PublishBookResult> {
  const owner = await resolveOwner(bookId, "publish");
  if ("error" in owner) return { ok: false, error: owner.error };

  try {
    const siteUrl = getSiteUrl(); // fail before writing if the deploy lacks NEXT_PUBLIC_APP_URL
    const row = await getPublishRow(owner.bookId, owner.userId);
    if (!row) return { ok: false, error: "not_found" };

    const now = new Date();
    const check = canPublish({
      doc: row.doc,
      maxPages: row.max_pages,
      isPaid: row.is_paid,
      expiresAt: row.expires_at,
      now,
    });
    if (!check.ok) return { ok: false, error: check.reason };

    const photos = await listPlaceablePhotos(owner.bookId);
    // D-062 defence in depth (M10c review S1): an AI photo background never publishes a photo that
    // isn't kept (the review drop prunes the draft too, best effort). User picks are untouched.
    const kept = new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
    const doc = stripUnusableAiPhotoBackgrounds(check.doc, (id) => kept.has(id)).doc;
    const issues = validateBookDoc(doc, {
      photoIds: new Set(photos.map((p) => p.id)),
      maxPages: row.max_pages,
    });
    if (issues.length > 0) return { ok: false, error: "invalid_doc" };

    const nowIso = now.toISOString();
    // Keep the stored strings verbatim (no ms round-trip): expiry fixed at first publish.
    const expiresAt = row.is_paid
      ? null
      : (row.expires_at ?? nextExpiry({ isPaid: false, existingExpiresAt: null, now }));
    const publishedAt = row.published_at ?? nowIso;
    // caption_lang is frozen into the snapshot so the viewer never reads the live column (D-039).
    const captionLang = row.caption_lang === "ar" ? "ar" : "en";
    const publishedDoc = toPublicDoc(doc, { captionLang }) as unknown as Json;
    const read = {
      docRev: row.doc_rev,
      isPaid: row.is_paid,
      slug: row.slug,
      publishedAt: row.published_at,
      expiresAt: row.expires_at,
    };

    let slug: string | null = null;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const candidate = row.slug ?? makeSlug(row.title ?? doc.cover.title);
      const res = await publishSnapshot({
        bookId: owner.bookId,
        ownerId: owner.userId,
        publishedDoc,
        slug: candidate,
        publishedAt,
        expiresAt,
        now: nowIso,
        read,
      });
      if (res.ok) {
        slug = candidate;
        break;
      }
      if (res.reason === "conflict") return { ok: false, error: "conflict" };
      // slug_taken: an existing slug can't collide with itself — something else is wrong.
      if (row.slug !== null) {
        console.error("[publish] unexpected slug collision");
        return { ok: false, error: "failed" };
      }
    }
    if (slug === null) {
      console.error("[publish] slug attempts exhausted");
      return { ok: false, error: "failed" };
    }

    try {
      await learnFromBook(owner.userId, owner.bookId, "publish");
    } catch (err) {
      console.error(`[publish] memory update failed (${errorCodeOf(err)})`);
    }
    revalidateBook(owner.bookId, slug);
    return { ok: true, slug, url: `${siteUrl}/b/${slug}`, expiresAt };
  } catch (err) {
    console.error(`[publish] failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

/** Unpublish: the link stops working; slug / first publish / expiry stay (D-039). Idempotent. */
export async function unpublishBookAction(bookId: string): Promise<UnpublishBookResult> {
  const owner = await resolveOwner(bookId, "unpublish");
  if ("error" in owner) return { ok: false, error: owner.error };
  try {
    const res = await unpublishBook(owner.bookId, owner.userId);
    if (!res.ok) return { ok: false, error: "not_found" };
    revalidateBook(owner.bookId, res.slug);
    return { ok: true };
  } catch (err) {
    console.error(`[unpublish] failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

/**
 * Sets (4–64 code points, NFC, scrypt) or removes (`null`) the book password (D-040). Works for
 * unpublished books too. Changing it invalidates existing viewer access cookies (fingerprint).
 */
export async function setBookPasswordAction(bookId: string, password: string | null): Promise<SetBookPasswordResult> {
  const owner = await resolveOwner(bookId, "book-password");
  if ("error" in owner) return { ok: false, error: owner.error };

  let hash: string | null = null;
  if (password !== null) {
    // Without the access secret no viewer could ever unlock the book — refuse before hashing.
    // (Removing a password with `null` still works.)
    if (!getAccessSecret()) return { ok: false, error: "unavailable" };
    const v = validatePasswordInput(password);
    if (!v.ok) return { ok: false, error: v.reason === "not_string" ? "invalid_password" : v.reason };
    try {
      hash = await hashPassword(v.password);
    } catch (err) {
      console.error(`[book-password] hash failed (${errorCodeOf(err)})`);
      return { ok: false, error: "failed" };
    }
  }

  try {
    const res = await setBookPasswordHash(owner.bookId, owner.userId, hash);
    if (!res.ok) return { ok: false, error: "not_found" };
    revalidateBook(owner.bookId, res.slug);
    return { ok: true, hasPassword: hash !== null };
  } catch (err) {
    console.error(`[book-password] failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

function toState(row: PublishRow, now: Date): PublishState {
  const check = canPublish({
    doc: row.doc,
    maxPages: row.max_pages,
    isPaid: row.is_paid,
    expiresAt: row.expires_at,
    now,
  });
  const pages = (row.doc as { pages?: unknown } | null)?.pages;
  return {
    published: row.live,
    slug: row.slug,
    url: row.slug ? publicUrl(row.slug) : null,
    hasChanges: row.live && row.published_rev !== null && row.doc_rev > row.published_rev,
    expiresAt: row.expires_at,
    expired: isExpired({ isPaid: row.is_paid, expiresAt: row.expires_at, now }),
    isPaid: row.is_paid,
    hasPassword: row.hasPassword,
    publishedAt: row.published_at,
    lastPublishedAt: row.last_published_at,
    pageCount: Array.isArray(pages) ? pages.length : 0,
    maxPages: row.max_pages,
    canPublishReason: check.ok ? null : check.reason,
  };
}

/**
 * Publish screen state (T8). canPublishReason covers the cheap rules (expired, invalid_doc,
 * empty, page_limit); photo ownership is re-checked by publishBookAction.
 */
export async function getPublishState(bookId: string): Promise<GetPublishStateResult> {
  const owner = await resolveOwner(bookId, "publish-state");
  if ("error" in owner) return { ok: false, error: owner.error };
  try {
    const row = await getPublishRow(owner.bookId, owner.userId);
    if (!row) return { ok: false, error: "not_found" };
    return { ok: true, state: toState(row, new Date()) };
  } catch (err) {
    console.error(`[publish-state] failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

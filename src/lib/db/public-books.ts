import "server-only";
// Public reader for /b/[slug] (M6, D-039/D-040) + OG data + unlock lookups.
//
// Anonymous viewers have no Supabase grants on books/photos/storage, so everything here uses the
// admin (secret-key) client and does its own scoping:
//   * the slug is validated (isValidSlug) before any query;
//   * get_published_book (service_role only) returns the snapshot only when live, not expired and
//     not password-protected; a password book's snapshot is read separately and only after a valid
//     access cookie (HMAC bound to the current password hash);
//   * photo URLs are signed only for ids the public snapshot shows, that belong to THAT book and
//     are upload_state 'ready' — one createSignedUrls call, web copies only, 6 h TTL.
//
// Privacy (CLAUDE.md, D-027): never selects user_id (except isViewerOwner, which returns a
// boolean), original_path, thumb_path, lat/lng, taken_at, place, ai, camera or meta. The DTO is
// built field by field; the internal bookId is returned beside it, never inside it.
//
// Errors carry only the operation and a Postgres/Storage code.
import { APP_NAME } from "@/lib/brand";
import type { CaptionLang } from "@/lib/book/options";
import type { RenderPhoto } from "@/lib/book/render";
import { PHOTOS_BUCKET } from "@/lib/db/photos";
import { verifyAccess } from "@/lib/publish/access-cookie";
import { passwordFingerprint } from "@/lib/publish/password";
import { parsePublicDoc, publicPhotoIds, type PublicBookDoc } from "@/lib/publish/public-doc";
import { isValidSlug } from "@/lib/publish/slug";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

/** TTL of viewer / OG image URLs. */
export const VIEWER_URL_TTL_SECONDS = 6 * 60 * 60;

/** Ids per PostgREST `in` filter (keeps request URLs short; same as photos.ts). */
const ID_CHUNK = 100;

export class PublicBooksQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "PublicBooksQueryError";
    this.code = code;
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * get_published_book row with corrected nullability (gen types marks RETURNS TABLE columns
 * non-null; lessons 2026-11-08).
 */
export type PublishedBookRow = {
  id: string;
  slug: string;
  title: string | null;
  caption_lang: string | null;
  is_paid: boolean;
  page_count: number | null;
  published_rev: number | null;
  published_at: string | null;
  expires_at: string | null;
  is_expired: boolean;
  has_password: boolean;
  doc: unknown;
};

/** Live book by slug via get_published_book, or null. Call only with a validated slug. */
export async function getPublishedBookRow(slug: string, admin: AdminClient = createAdminClient()): Promise<PublishedBookRow | null> {
  const { data, error } = await admin.rpc("get_published_book", { p_slug: slug });
  if (error) throw new PublicBooksQueryError("load published book", error.code);
  const rows = (data ?? []) as unknown as PublishedBookRow[];
  const row = rows[0];
  if (!row || !isUuid(row.id)) return null;
  return row;
}

export type ViewerState = "ok" | "expired" | "locked" | "not_found" | "unavailable";

/**
 * Client-safe viewer payload. `title` is null unless state is "ok" (password / expired books show
 * no title, D-040); for "ok" it comes from the SNAPSHOT only (cover title, else APP_NAME) — never
 * the live books.title (D-039). `captionLang` likewise comes from the snapshot when it has one
 * (older snapshots fall back to the live column). `doc` + `photos` are filled only for "ok". "unavailable" = live book whose
 * snapshot fails the strict public schema (render an "unavailable" message, never the raw doc).
 */
export type ViewerBook = {
  state: ViewerState;
  title: string | null;
  captionLang: CaptionLang;
  isPaid: boolean;
  /** Pages in the snapshot; null unless "ok". */
  pageCount: number | null;
  publishedRev: number | null;
  /** Free-link expiry (ISO); null for paid / unknown. */
  expiresAt: string | null;
  hasPassword: boolean;
  doc: PublicBookDoc | null;
  /** RenderPhotos-compatible map {photoId: {url, width, height}} (signed web copies). */
  photos: Record<string, RenderPhoto>;
};

/** Internal result: `bookId` is for server-side use only (owner CTA, OG) — never send it. */
export type ViewerBookResult = { bookId: string | null; book: ViewerBook };

function captionLangOf(v: string | null | undefined): CaptionLang {
  return v === "ar" ? "ar" : "en";
}

/** Viewer title from the published snapshot only (D-039): cover title, else the app name. */
export function snapshotTitle(doc: PublicBookDoc): string {
  return doc.cover.title.trim() || APP_NAME;
}

/** Caption language frozen in the snapshot; live column only for snapshots published before it. */
function snapshotCaptionLang(doc: PublicBookDoc, row: PublishedBookRow): CaptionLang {
  return doc.captionLang ?? captionLangOf(row.caption_lang);
}

function emptyBook(state: ViewerState, row: PublishedBookRow | null): ViewerBook {
  return {
    state,
    title: null,
    captionLang: captionLangOf(row?.caption_lang),
    isPaid: row?.is_paid === true,
    pageCount: null,
    publishedRev: row?.published_rev ?? null,
    expiresAt: row?.is_paid ? null : (row?.expires_at ?? null),
    hasPassword: row?.has_password === true,
    doc: null,
    photos: {},
  };
}

const NOT_FOUND: ViewerBookResult = { bookId: null, book: emptyBook("not_found", null) };

function storageCode(err: unknown): string {
  if (err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "string") {
    return err.statusCode;
  }
  return "storage";
}

function positiveInt(n: unknown): number | null {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

type PhotoRow = { id: string; web_path: string | null; width: number | null; height: number | null };

/**
 * Signed web URLs for `ids` that belong to `bookId` and are ready. ONE createSignedUrls call.
 * Ids that are malformed, foreign, unfinished or without a web copy are simply absent.
 */
export async function signPublicPhotos(
  admin: AdminClient,
  bookId: string,
  ids: readonly string[],
): Promise<Record<string, RenderPhoto>> {
  const wanted = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return {};

  const rows: PhotoRow[] = [];
  for (let i = 0; i < wanted.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from("photos")
      .select("id, web_path, width, height")
      .eq("book_id", bookId)
      .eq("upload_state", "ready")
      .in("id", wanted.slice(i, i + ID_CHUNK));
    if (error) throw new PublicBooksQueryError("list public photos", error.code);
    rows.push(...((data ?? []) as PhotoRow[]));
  }

  const wantedSet = new Set(wanted);
  const usable = rows.filter((r) => wantedSet.has(r.id.toLowerCase()) && typeof r.web_path === "string" && r.web_path);
  if (usable.length === 0) return {};

  const paths = [...new Set(usable.map((r) => r.web_path as string))];
  const { data, error } = await admin.storage.from(PHOTOS_BUCKET).createSignedUrls(paths, VIEWER_URL_TTL_SECONDS);
  if (error) throw new PublicBooksQueryError("sign public photos", storageCode(error));
  const urls = new Map<string, string>();
  for (const s of data ?? []) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);

  const out: Record<string, RenderPhoto> = {};
  for (const r of usable) {
    const url = urls.get(r.web_path as string);
    if (url) out[r.id] = { url, width: positiveInt(r.width), height: positiveInt(r.height) };
  }
  return out;
}

/** password_hash + published_doc of a live book (admin; both stay server-side). */
async function loadProtected(
  admin: AdminClient,
  bookId: string,
  slug: string,
): Promise<{ passwordHash: string | null; publishedDoc: unknown } | null> {
  const { data, error } = await admin
    .from("books")
    .select("password_hash, published_doc")
    .eq("id", bookId)
    .eq("slug", slug)
    .not("published_doc", "is", null)
    .maybeSingle();
  if (error) throw new PublicBooksQueryError("load protected book", error.code);
  if (!data) return null;
  return { passwordHash: data.password_hash ?? null, publishedDoc: data.published_doc };
}

export type ViewerOptions = {
  /** Raw value of the cookie accessCookieName(slug), if the request has one. */
  accessCookie?: string | null;
  /** Clock override for tests (epoch ms). */
  now?: number;
};

/** Everything /b/[slug] renders. Unknown / malformed slug → not_found (no query for malformed). */
export async function getViewerBook(slug: string, opts: ViewerOptions = {}): Promise<ViewerBookResult> {
  if (!isValidSlug(slug)) return NOT_FOUND;
  const admin = createAdminClient();
  const row = await getPublishedBookRow(slug, admin);
  if (!row) return NOT_FOUND;
  const bookId = row.id;

  if (row.is_expired) return { bookId, book: emptyBook("expired", row) };

  let rawDoc: unknown = row.doc;
  if (row.has_password) {
    const cookie = opts.accessCookie;
    if (typeof cookie !== "string" || !cookie) return { bookId, book: emptyBook("locked", row) };
    const prot = await loadProtected(admin, bookId, slug);
    if (!prot) return NOT_FOUND;
    if (prot.passwordHash !== null) {
      const ok = verifyAccess(cookie, bookId, passwordFingerprint(prot.passwordHash), opts.now ?? Date.now());
      if (!ok) return { bookId, book: emptyBook("locked", row) };
    }
    rawDoc = prot.publishedDoc;
  }

  const parsed = parsePublicDoc(rawDoc);
  if (!parsed.ok) return { bookId, book: emptyBook("unavailable", row) };
  const doc = parsed.doc;
  const photos = await signPublicPhotos(admin, bookId, publicPhotoIds(doc));

  return {
    bookId,
    book: {
      ...emptyBook("ok", row),
      title: snapshotTitle(doc),
      captionLang: snapshotCaptionLang(doc, row),
      pageCount: doc.pages.length,
      doc,
      photos,
    },
  };
}

export type OgData = {
  state: ViewerState;
  /** Null unless "ok" and no password (D-040). Snapshot cover title only (D-039); null when the
   * cover title is empty — buildBookMetadata then uses APP_NAME. */
  title: string | null;
  /** Signed web URL of the cover (or first) photo; null unless "ok" and no password. */
  coverUrl: string | null;
  isPaid: boolean;
  publishedRev: number | null;
  hasPassword: boolean;
  captionLang: CaptionLang;
};

/** Data for OG images / metadata. Password books: state "locked", no title/cover, no doc read. */
export async function getOgData(slug: string): Promise<OgData> {
  const base = (state: ViewerState, row: PublishedBookRow | null): OgData => ({
    state,
    title: null,
    coverUrl: null,
    isPaid: row?.is_paid === true,
    publishedRev: row?.published_rev ?? null,
    hasPassword: row?.has_password === true,
    captionLang: captionLangOf(row?.caption_lang),
  });
  if (!isValidSlug(slug)) return base("not_found", null);
  const admin = createAdminClient();
  const row = await getPublishedBookRow(slug, admin);
  if (!row) return base("not_found", null);
  if (row.is_expired) return base("expired", row);
  if (row.has_password) return base("locked", row);

  const parsed = parsePublicDoc(row.doc);
  if (!parsed.ok) return base("unavailable", row);
  const doc = parsed.doc;
  const firstId = publicPhotoIds(doc)[0];
  let coverUrl: string | null = null;
  if (firstId) {
    const signed = await signPublicPhotos(admin, row.id, [firstId]);
    coverUrl = signed[firstId.toLowerCase()]?.url ?? signed[firstId]?.url ?? null;
  }
  // Snapshot only (D-039): never the live books.title / caption_lang.
  const coverTitle = doc.cover.title.trim();
  return { ...base("ok", row), title: coverTitle || null, coverUrl, captionLang: snapshotCaptionLang(doc, row) };
}

/** True when the signed-in user owns the book (for the expired page's "Upgrade" CTA). Never throws. */
export async function isViewerOwner(bookId: string): Promise<boolean> {
  if (!isUuid(bookId)) return false;
  try {
    const supabase = await createClient();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (authError || !userId) return false;
    const { data, error } = await createAdminClient().from("books").select("user_id").eq("id", bookId).maybeSingle();
    if (error || !data) return false;
    return data.user_id === userId;
  } catch {
    return false;
  }
}

/** Unlock target: a live, unexpired, password-protected book. Call only with a validated slug. */
export async function getUnlockTarget(slug: string): Promise<{ bookId: string; passwordHash: string } | null> {
  const admin = createAdminClient();
  const row = await getPublishedBookRow(slug, admin);
  if (!row || row.is_expired || !row.has_password) return null;
  const prot = await loadProtected(admin, row.id, slug);
  if (!prot || prot.passwordHash === null) return null;
  return { bookId: row.id, passwordHash: prot.passwordHash };
}

/** PostgREST "function not found" / Postgres undefined_function: migration 1100 not applied yet. */
const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/**
 * clear_unlock_attempt (migration 1100): after a SUCCESSFUL verify, delete the attempt row
 * try_book_unlock just recorded so only failures count toward the limits. Returns "cleared" /
 * "none", or "missing" when the RPC doesn't exist yet (deploy before 1100 — ignored). Other
 * errors throw PublicBooksQueryError (the caller treats them as best effort).
 */
export async function clearUnlockAttempt(bookId: string, ipHash: string): Promise<"cleared" | "none" | "missing"> {
  const { data, error } = await createAdminClient().rpc("clear_unlock_attempt", { p_book: bookId, p_ip_hash: ipHash });
  if (error) {
    if (error.code && MISSING_FUNCTION_CODES.has(error.code)) return "missing";
    throw new PublicBooksQueryError("clear unlock attempt", error.code);
  }
  return data === true ? "cleared" : "none";
}

/** try_book_unlock: atomic check + record of one attempt. false = rate limited. */
export async function recordUnlockAttempt(
  bookId: string,
  ipHash: string,
  limits: { ipLimit: number; bookLimit: number; windowSeconds: number },
): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("try_book_unlock", {
    p_book: bookId,
    p_ip_hash: ipHash,
    p_ip_limit: limits.ipLimit,
    p_book_limit: limits.bookLimit,
    p_window_s: limits.windowSeconds,
  });
  if (error) throw new PublicBooksQueryError("record unlock attempt", error.code);
  return data === true;
}

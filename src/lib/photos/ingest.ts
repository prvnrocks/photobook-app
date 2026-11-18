import "server-only";
// Server-side photo ingestion: verify what the browser uploaded, make the AI copy safe, record
// the result once.
//
//   for each READY photo of the book that has no photo_ingest row for its current fingerprint:
//     1. original: read the first 256 KiB + real size (Range request) → checkOriginal against the
//        row (type by magic bytes, size, pixel dimensions). The original is never modified,
//        re-encoded or moved.
//     2. AI copy (512 px thumb): download (≤ 1 MB) → prepareAiCopy (JPEG, ≤ 512 px, metadata
//        stripped). If metadata had to be stripped, the stored copy is replaced with the clean one.
//     3. save 'verified' (+ SHA-256 of the AI copy) or 'rejected' (+ reason code).
//
// Idempotent: a photo with a row for its fingerprint is skipped without any download. Retry-safe:
// a transient failure (timeout, 5xx) writes nothing, so the next run tries again; after
// MAX_ATTEMPTS failed tries the photo is left for a later manual look instead of looping.
// Bounded: MAX_PER_RUN photos, CONCURRENCY parallel, BUDGET_MS wall clock — the rest is picked
// up by the next finalize call. No temporary files: everything is in memory and ≤ 1.3 MB/photo.
// Privacy: returns counts only; never logs paths, ids, bytes or metadata.

import { createHash } from "node:crypto";
import {
  downloadAiCopy,
  listIngestStates,
  listPhotosForIngest,
  readOriginalHead,
  replaceAiCopy,
  saveIngestOutcome,
  type IngestOutcome,
  type IngestPhotoRow,
  type IngestStateRow,
} from "@/lib/db/photo-ingest";
import { checkOriginal, prepareAiCopy } from "./ingest-verify";

export const INGEST_MAX_PER_RUN = 60;
export const INGEST_CONCURRENCY = 6;
export const INGEST_BUDGET_MS = 12_000;

export type IngestDb = {
  listPhotos(bookId: string, userId: string): Promise<IngestPhotoRow[]>;
  listStates(bookId: string, userId: string): Promise<IngestStateRow[] | null>;
  readOriginalHead(path: string): Promise<{ head: Uint8Array; totalBytes: number } | null>;
  downloadAiCopy(path: string): Promise<Uint8Array | "too_large" | null>;
  replaceAiCopy(path: string, bytes: Uint8Array): Promise<void>;
  save(key: { photoId: string; bookId: string; userId: string; fingerprint: string; attempts: number }, outcome: IngestOutcome): Promise<void>;
};

const realDb: IngestDb = {
  listPhotos: listPhotosForIngest,
  listStates: listIngestStates,
  readOriginalHead,
  downloadAiCopy,
  replaceAiCopy,
  save: saveIngestOutcome,
};

export type IngestResult = {
  /** Ready photos of the book. */
  photos: number;
  verified: number;
  rejected: number;
  /** Already had a row for their fingerprint (no work done). */
  skipped: number;
  /** Not checked in this run (cap / budget / transient failure) — a later run picks them up. */
  pending: number;
  /** AI copies the server had to strip metadata from. */
  sanitized: number;
  /** False when migration 2300 is not applied: nothing was checked. */
  available: boolean;
};

export type IngestDeps = { db?: IngestDb; now?: () => number; maxPerRun?: number; budgetMs?: number };

/** The path must be exactly the caller's own object: {user}/{book}/{photo}-… (defence in depth on top of the DB path CHECKs). */
function ownPath(path: string | null, userId: string, bookId: string, photoId: string, kind: "original" | "thumb"): path is string {
  return typeof path === "string" && path.startsWith(`${userId}/${bookId}/${photoId}-${kind}.`) && !path.includes("..");
}

async function ingestOne(db: IngestDb, p: IngestPhotoRow, userId: string, bookId: string): Promise<IngestOutcome> {
  if (!ownPath(p.original_path, userId, bookId, p.id, "original")) return { state: "rejected", reason: "original_missing" };
  if (!ownPath(p.thumb_path, userId, bookId, p.id, "thumb")) return { state: "rejected", reason: "ai_copy_missing" };

  const original = await db.readOriginalHead(p.original_path);
  if (!original) return { state: "rejected", reason: "original_missing" };
  const check = checkOriginal(original.head, original.totalBytes, { mime: p.original_mime, bytes: p.original_bytes, width: p.width, height: p.height });
  if (!check.ok) return { state: "rejected", reason: check.reason };

  const raw = await db.downloadAiCopy(p.thumb_path);
  if (raw === "too_large") return { state: "rejected", reason: "ai_copy_too_large" };
  const copy = prepareAiCopy(raw);
  if (!copy.ok) return { state: "rejected", reason: copy.reason };
  if (copy.sanitized) await db.replaceAiCopy(p.thumb_path, copy.bytes);

  return {
    state: "verified",
    originalFormat: check.format,
    originalBytes: check.bytes,
    aiCopySha256: createHash("sha256").update(copy.bytes).digest("hex"),
    aiCopyBytes: copy.bytes.length,
    aiCopySanitized: copy.sanitized,
  };
}

/** A photo that keeps failing transiently is not retried forever. */
export const INGEST_MAX_ATTEMPTS = 5;

/**
 * Verifies the not-yet-verified ready photos of `bookId`. The caller MUST have proved that
 * `userId` owns the book (getMyBook under RLS). Never throws for a single photo.
 */
export async function ingestBookPhotos(bookId: string, userId: string, deps: IngestDeps = {}): Promise<IngestResult> {
  const db = deps.db ?? realDb;
  const now = deps.now ?? Date.now;
  const maxPerRun = deps.maxPerRun ?? INGEST_MAX_PER_RUN;
  const deadline = now() + (deps.budgetMs ?? INGEST_BUDGET_MS);

  const states = await db.listStates(bookId, userId);
  const photos = await db.listPhotos(bookId, userId);
  const result: IngestResult = { photos: photos.length, verified: 0, rejected: 0, skipped: 0, pending: 0, sanitized: 0, available: states !== null };
  if (states === null) {
    result.pending = photos.length;
    return result;
  }

  const byPhoto = new Map(states.map((s) => [s.photo_id, s]));
  const todo: IngestPhotoRow[] = [];
  for (const p of photos) {
    const s = byPhoto.get(p.id);
    if (s && s.fingerprint === p.fingerprint) result.skipped++;
    else todo.push(p);
  }
  const batch = todo.slice(0, Math.max(0, maxPerRun));
  result.pending = todo.length - batch.length;

  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const p = batch[next++]!;
      if (now() >= deadline) {
        result.pending++;
        continue;
      }
      try {
        const outcome = await ingestOne(db, p, userId, bookId);
        const attempts = (byPhoto.get(p.id)?.attempts ?? 0) + 1;
        await db.save({ photoId: p.id, bookId, userId, fingerprint: p.fingerprint, attempts }, outcome);
        if (outcome.state === "verified") {
          result.verified++;
          if (outcome.aiCopySanitized) result.sanitized++;
        } else result.rejected++;
      } catch {
        // transient (timeout / 5xx / write error): no row → retried by the next run
        result.pending++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INGEST_CONCURRENCY, batch.length) }, worker));
  return result;
}

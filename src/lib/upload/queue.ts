// Resumable photo upload queue (D-013, D-014). Pure orchestration: every side
// effect (processing, DB, storage, sleep) is injected, so this runs in node
// tests. No React, no Supabase import — see supabase-adapters.ts for the
// browser wiring.
//
// Flow per selected file:
//   add()   fingerprint (cheap head+tail hash, sequential) → classify:
//           already ready → skipped('already_uploaded')
//           pending row   → retried with its existing id
//           seen earlier in this queue → skipped('duplicate_in_selection')
//             (a photo that FAILED earlier — read/process/insert/upload — is
//             forgotten again, so re-selecting it retries it; an upload_failed
//             photo keeps its pending row id. Rejected photos stay skipped.)
//           over the per-book cap → skipped('limit')
//           else → queued as new
//   run     process (strictly one at a time) → insert pending row (new photos
//           only) → upload original/web/thumb (3 in parallel) → markReady.
//
// Design choice — rejected files never get a row: a photo is PROCESSED FIRST
// and its pending row is inserted only once processing succeeded, one row per
// insert. So `pending` rows exist only for genuinely interrupted uploads
// (crash / tab closed / network gave up between insert and markReady), which is
// exactly what resume and "remove unfinished" are for. Batching inserts by 10
// would need either 10 processed photos in memory or rows inserted before
// processing (orphans on reject), so we trade ≤150 small inserts for that.
//
// Memory bound: while photo N uploads, photo N+1 may be processed; N+1 then
// waits until N's uploads finished. At most one processed photo waits and one
// uploads at any time; uploads in flight ≤ 3.
//
// Never logs anything. Events carry counts, reasons and opaque keys only — no
// file names or photo metadata.
import { limitsFor } from "@/lib/ai/limits";
import { fingerprint as defaultFingerprint } from "@/lib/image/fingerprint";
import type { ProcessedPhoto } from "@/lib/image/process-photo";
import { PhotoRejectError, type PhotoRejectReason } from "@/lib/image/resize";
import { isUuid } from "@/lib/uuid";
import { mapUploadDbError, type DbErrorLike } from "./errors";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DbError = DbErrorLike;
export type UploadState = "pending" | "ready";

export interface ExistingPhoto {
  id: string;
  fingerprint: string;
  upload_state: UploadState;
}

export interface PendingRow {
  user_id: string;
  book_id: string;
  fingerprint: string;
  upload_state: "pending";
}

export interface ReadyPatch {
  original_path: string;
  web_path: string;
  thumb_path: string;
  width: number;
  height: number;
  taken_at: string;
  date_source: "exif" | "file";
  lat: number | null;
  lng: number | null;
  camera: string | null;
  phash: string;
  blur_score: number;
  original_bytes: number;
  original_mime: "image/jpeg" | "image/png" | "image/webp";
  upload_state: "ready";
}

export interface StorageUploadError {
  message: string;
  statusCode?: string;
  status?: number;
}

/** markReady error code meaning "update matched no row" (row deleted meanwhile). Not retried. */
export const ROW_MISSING_CODE = "row_missing";

export interface UploadQueueDeps {
  userId: string;
  bookId: string;
  isPaid: boolean;
  /** From listUploadState on page load (all rows of the book, pending + ready). */
  existing: ExistingPhoto[];
  process: (file: File) => Promise<ProcessedPhoto>;
  /** Cheap pre-pass; defaults to src/lib/image/fingerprint.ts (same value processPhoto computes). */
  fingerprintOnly?: (file: File) => Promise<string>;
  db: {
    insertPending(
      rows: PendingRow[],
    ): Promise<{ data: { id: string; fingerprint: string }[] | null; error: DbError | null }>;
    markReady(id: string, patch: ReadyPatch): Promise<{ error: DbError | null }>;
    findByFingerprints(fps: string[]): Promise<ExistingPhoto[]>;
  };
  storage: {
    /** Must upsert (retries / resumed photos overwrite their own objects). */
    upload(path: string, blob: Blob, contentType: string): Promise<{ error: StorageUploadError | null }>;
  };
  onEvent: (e: QueueEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type SkipReason = "already_uploaded" | "duplicate_in_selection" | "limit" | PhotoRejectReason;
export type FailReason = "read_failed" | "process_failed" | "insert_failed" | "upload_failed" | "not_allowed";

export interface QueueProgress {
  type: "progress";
  /** Files that reached a final state (uploaded + failed + skipped + retried). Never decreases. */
  done: number;
  /** Files handed to add() so far. Grows when more files are added. */
  total: number;
  uploaded: number;
  /** Failures not (yet) superseded by a re-selection of the same photo. May decrease. */
  failed: number;
  skipped: number;
  /** Earlier failures whose photo was selected again (counted again under its new key). */
  retried: number;
}

/** `key` = 0-based position of the file across all add() calls, in selection order. */
export type QueuePhotoEvent =
  | { type: "photo"; key: number; status: "uploaded"; photoId: string }
  | { type: "photo"; key: number; status: "failed"; reason: FailReason }
  | { type: "photo"; key: number; status: "skipped"; reason: SkipReason };

export interface QueueSummary {
  total: number;
  uploaded: number;
  /** Photos that failed and were not selected again afterwards. */
  failed: number;
  skipped: number;
  /** Failed attempts superseded by a re-selection (that attempt is counted under its own key). */
  retried: number;
  skippedBy: Partial<Record<SkipReason, number>>;
  failedBy: Partial<Record<FailReason, number>>;
  /** Files never attempted because of cancel() or a fatal error (total − done). */
  notStarted: number;
  /** Set when the per-book cap was hit (browser check or DB trigger). */
  limit: number | null;
  cancelled: boolean;
  /** 'not_allowed' = RLS/grants refused us (signed out, not the owner): queue stopped. */
  fatal: "not_allowed" | null;
  /** Rows of this book still `pending` as far as this queue knows → offer "remove unfinished". */
  pendingLeft: number;
}

export type QueueEvent =
  | QueueProgress
  | QueuePhotoEvent
  | { type: "limit"; limit: number; skipped: number }
  | { type: "finished"; summary: QueueSummary };

export interface UploadQueue {
  add(files: File[]): void;
  start(): Promise<QueueSummary>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

/** Attempts per upload / insert / markReady. */
export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2, 3 (and 4, should MAX_ATTEMPTS grow). */
export const BACKOFF_MS = [500, 1500, 4000] as const;

export interface PhotoPaths {
  original: string;
  web: string;
  thumb: string;
}

/** Storage object paths; prefix `{userId}/{bookId}/` is required by the photos_*_path_owner CHECKs. */
export function photoPaths(
  userId: string,
  bookId: string,
  photoId: string,
  originalExt: "jpg" | "png" | "webp",
): PhotoPaths {
  const base = `${userId}/${bookId}/${photoId}`;
  return { original: `${base}-original.${originalExt}`, web: `${base}-web.jpg`, thumb: `${base}-thumb.jpg` };
}

export function readyPatch(paths: PhotoPaths, p: ProcessedPhoto): ReadyPatch {
  return {
    original_path: paths.original,
    web_path: paths.web,
    thumb_path: paths.thumb,
    width: p.width,
    height: p.height,
    taken_at: p.meta.takenAt,
    date_source: p.meta.dateSource,
    lat: p.meta.lat,
    lng: p.meta.lng,
    camera: p.meta.camera,
    phash: p.phash,
    blur_score: p.blurScore,
    original_bytes: p.original.bytes,
    original_mime: p.original.mime,
    upload_state: "ready",
    // place deliberately absent: set server-side by finalize (D-015/D-017).
  };
}

/** 4xx other than 408/429 won't get better by retrying. */
function storageRetryable(e: StorageUploadError): boolean {
  const code = Number.parseInt(e.statusCode ?? "", 10);
  const status = Number.isFinite(code) ? code : (e.status ?? NaN);
  if (!Number.isFinite(status)) return true;
  if (status === 408 || status === 429) return true;
  return !(status >= 400 && status < 500);
}

type Attempt<T, K = never> = { ok: true; value: T } | { ok: false; retryable: boolean; kind?: K };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Item {
  key: number;
  file: File;
  fp: string;
  /** Existing pending row id (resume) — no insert needed. */
  id?: string;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export function createUploadQueue(deps: UploadQueueDeps): UploadQueue {
  const { userId, bookId, db, storage, onEvent } = deps;
  if (!isUuid(userId) || !isUuid(bookId)) throw new RangeError("createUploadQueue: userId/bookId must be UUIDs");
  const sleep = deps.sleep ?? realSleep;
  const fingerprintOf = deps.fingerprintOnly ?? ((f: File) => defaultFingerprint(f));
  const maxPhotos = limitsFor(deps.isPaid).maxUploadPhotos;

  // Server-known state (kept current as we go).
  const readyFps = new Set<string>();
  const pendingByFp = new Map<string, string>();
  for (const row of deps.existing) {
    if (row.upload_state === "ready") readyFps.add(row.fingerprint);
    else pendingByFp.set(row.fingerprint, row.id);
  }
  const pendingIds = new Set(pendingByFp.values());
  /** Rows in the book as the cap trigger counts them (pending + ready), incl. ones we will insert. */
  let rowsCounted = deps.existing.length;

  const seenFps = new Set<string>();
  const items: Item[] = [];
  let nextKey = 0;
  let pendingAdds = 0;
  let addChain: Promise<void> = Promise.resolve();

  let total = 0;
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;
  let retried = 0;
  /** Fingerprint → reason of its latest failure, until it is selected again. */
  const failedFps = new Map<string, FailReason>();
  const skippedBy: Partial<Record<SkipReason, number>> = {};
  const failedBy: Partial<Record<FailReason, number>> = {};
  let limit: number | null = null;
  let dbLimitHit = false;
  let fatal: "not_allowed" | null = null;
  let paused = false;
  let cancelled = false;
  let running: Promise<QueueSummary> | null = null;

  // --- wake signal (pause/resume, new items, cancel) ---
  let waiters: (() => void)[] = [];
  const wait = () => new Promise<void>((r) => waiters.push(r));
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };

  // --- events ---
  const emit = (e: QueueEvent) => {
    try {
      onEvent(e);
    } catch {
      // a UI handler bug must not break the queue
    }
  };
  const progress = () =>
    emit({ type: "progress", done: uploaded + failed + skipped + retried, total, uploaded, failed, skipped, retried });
  const skip = (key: number, reason: SkipReason) => {
    skipped += 1;
    skippedBy[reason] = (skippedBy[reason] ?? 0) + 1;
    emit({ type: "photo", key, status: "skipped", reason });
    progress();
  };
  /**
   * `fp` = the photo's fingerprint when known. Failed photos are forgotten by the
   * in-session duplicate check so a later add() of the same file retries it
   * (S1). not_allowed is fatal, so nothing is retried after it anyway.
   */
  const fail = (key: number, reason: FailReason, fp?: string) => {
    if (fp !== undefined && reason !== "not_allowed") {
      seenFps.delete(fp);
      failedFps.set(fp, reason);
    }
    failed += 1;
    failedBy[reason] = (failedBy[reason] ?? 0) + 1;
    emit({ type: "photo", key, status: "failed", reason });
    progress();
  };

  const stopped = () => cancelled || fatal !== null;

  async function retry<T, K>(attempt: () => Promise<Attempt<T, K>>): Promise<Attempt<T, K>> {
    let last: Attempt<T, K> = { ok: false, retryable: true };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (i > 0) await sleep(BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)]);
      try {
        last = await attempt();
      } catch {
        last = { ok: false, retryable: true };
      }
      if (last.ok || !last.retryable) return last;
    }
    return last;
  }

  // --- classification (add) ---
  async function classify(batch: { key: number; file: File }[]) {
    let limitSkips = 0;
    // Within one selection, identical files stay skipped even if the first copy
    // already failed (and was forgotten by seenFps) before we got here.
    const batchFps = new Set<string>();
    for (const { key, file } of batch) {
      if (stopped()) break; // remaining stay "not started"
      let fp: string;
      try {
        fp = await fingerprintOf(file);
      } catch {
        fail(key, "read_failed");
        continue;
      }
      if (seenFps.has(fp) || batchFps.has(fp)) {
        skip(key, "duplicate_in_selection");
        continue;
      }
      seenFps.add(fp);
      batchFps.add(fp);
      const earlier = failedFps.get(fp);
      if (earlier !== undefined) {
        // Selected again after failing: that failure is superseded by this attempt.
        failedFps.delete(fp);
        failed -= 1;
        failedBy[earlier] = (failedBy[earlier] ?? 1) - 1;
        if (failedBy[earlier] === 0) delete failedBy[earlier];
        retried += 1;
      }
      if (readyFps.has(fp)) {
        skip(key, "already_uploaded");
        continue;
      }
      const pendingId = pendingByFp.get(fp);
      if (pendingId) {
        items.push({ key, file, fp, id: pendingId });
      } else if (dbLimitHit || rowsCounted >= maxPhotos) {
        limit = dbLimitHit && limit !== null ? limit : maxPhotos;
        limitSkips += 1;
        skip(key, "limit");
        continue;
      } else {
        rowsCounted += 1;
        items.push({ key, file, fp });
      }
      wake();
    }
    if (limitSkips > 0) emit({ type: "limit", limit: limit ?? maxPhotos, skipped: limitSkips });
  }

  // --- DB limit reached mid-run (e.g. another tab): skip every new item left ---
  function onDbLimit(n: number, currentKey: number) {
    dbLimitHit = true;
    limit = n;
    // The cap is authoritative now; our optimistic count is irrelevant from here on.
    const dropped = items.filter((it) => it.id === undefined);
    const keep = items.filter((it) => it.id !== undefined);
    items.length = 0;
    items.push(...keep);
    skip(currentKey, "limit");
    for (const it of dropped) skip(it.key, "limit");
    emit({ type: "limit", limit: n, skipped: dropped.length + 1 });
  }

  type InsertResult =
    | { kind: "id"; id: string }
    | { kind: "already_uploaded" }
    | { kind: "limit"; limit: number }
    | { kind: "not_allowed" }
    | { kind: "failed" };

  async function insertRow(fp: string): Promise<InsertResult> {
    const res = await retry<InsertResult, never>(async () => {
      const { data, error } = await db.insertPending([
        { user_id: userId, book_id: bookId, fingerprint: fp, upload_state: "pending" },
      ]);
      if (error) {
        const mapped = mapUploadDbError(error);
        switch (mapped.kind) {
          case "photo_limit_reached":
            return { ok: true, value: { kind: "limit", limit: mapped.limit } };
          case "not_allowed":
            return { ok: true, value: { kind: "not_allowed" } };
          case "duplicate": {
            // Same file already in the book (another tab, or an earlier attempt whose
            // response got lost). Reuse that row.
            const rows = await db.findByFingerprints([fp]);
            const row = rows.find((r) => r.fingerprint === fp);
            if (!row) return { ok: false, retryable: true };
            if (row.upload_state === "ready") return { ok: true, value: { kind: "already_uploaded" } };
            return { ok: true, value: { kind: "id", id: row.id } };
          }
          default:
            return { ok: false, retryable: true };
        }
      }
      const row = data?.find((r) => r.fingerprint === fp) ?? data?.[0];
      if (!row || !isUuid(row.id)) return { ok: false, retryable: true };
      return { ok: true, value: { kind: "id", id: row.id } };
    });
    return res.ok ? res.value : { kind: "failed" };
  }

  async function uploadOne(path: string, blob: Blob, contentType: string): Promise<boolean> {
    const res = await retry<true, never>(async () => {
      const { error } = await storage.upload(path, blob, contentType);
      if (!error) return { ok: true, value: true };
      return { ok: false, retryable: storageRetryable(error) };
    });
    return res.ok;
  }

  /** Insert (if new) → 3 uploads → markReady. Never throws. */
  async function uploadPhoto(item: Item, p: ProcessedPhoto): Promise<void> {
    let id = item.id;
    if (id === undefined) {
      const ins = await insertRow(item.fp);
      switch (ins.kind) {
        case "limit":
          onDbLimit(ins.limit, item.key);
          return;
        case "not_allowed":
          fatal = "not_allowed";
          fail(item.key, "not_allowed");
          wake();
          return;
        case "already_uploaded":
          readyFps.add(item.fp);
          rowsCounted -= 1; // we counted a new row that turned out to exist already
          skip(item.key, "already_uploaded");
          return;
        case "failed":
          rowsCounted -= 1;
          fail(item.key, "insert_failed", item.fp);
          return;
        case "id":
          id = ins.id;
          pendingIds.add(id);
          pendingByFp.set(item.fp, id);
      }
    }
    const photoId = id;

    const paths = photoPaths(userId, bookId, photoId, p.original.ext);
    const results = await Promise.all([
      uploadOne(paths.original, p.original.blob, p.original.mime),
      uploadOne(paths.web, p.web.blob, "image/jpeg"),
      uploadOne(paths.thumb, p.thumb.blob, "image/jpeg"),
    ]);
    if (results.includes(false)) {
      // Row stays pending (pendingByFp keeps its id): a re-add in this session or a
      // later resume retries it under the same id.
      fail(item.key, "upload_failed", item.fp);
      return;
    }

    const patch = readyPatch(paths, p);
    let notAllowed = false;
    let rowMissing = false;
    const marked = await retry<true, never>(async () => {
      const { error } = await db.markReady(photoId, patch);
      if (!error) return { ok: true, value: true };
      if (error.code === ROW_MISSING_CODE) {
        rowMissing = true;
        return { ok: false, retryable: false };
      }
      if (mapUploadDbError(error).kind === "not_allowed") {
        notAllowed = true;
        return { ok: false, retryable: false };
      }
      return { ok: false, retryable: true };
    });
    if (!marked.ok) {
      if (notAllowed) {
        fatal = "not_allowed";
        fail(item.key, "not_allowed");
        wake();
      } else {
        if (rowMissing) {
          // Deleted meanwhile ("remove unfinished" elsewhere): a re-add inserts a fresh row.
          pendingIds.delete(photoId);
          pendingByFp.delete(item.fp);
          rowsCounted -= 1;
        }
        fail(item.key, "upload_failed", item.fp);
      }
      return;
    }

    pendingIds.delete(photoId);
    pendingByFp.delete(item.fp);
    readyFps.add(item.fp);
    uploaded += 1;
    emit({ type: "photo", key: item.key, status: "uploaded", photoId });
    progress();
  }

  function summary(): QueueSummary {
    const done = uploaded + failed + skipped + retried;
    return {
      total,
      uploaded,
      failed,
      skipped,
      retried,
      skippedBy: { ...skippedBy },
      failedBy: { ...failedBy },
      notStarted: Math.max(0, total - done),
      limit,
      cancelled,
      fatal,
      pendingLeft: pendingIds.size,
    };
  }

  async function run(): Promise<QueueSummary> {
    let prevJob: Promise<void> = Promise.resolve();
    for (;;) {
      while (paused && !stopped()) await wait();
      if (stopped()) break;

      const item = items.shift();
      if (!item) {
        if (pendingAdds > 0) {
          await wait(); // fingerprinting still running; woken on enqueue / batch end
          continue;
        }
        break;
      }
      if (item.id === undefined && dbLimitHit) {
        skip(item.key, "limit");
        continue;
      }

      let processed: ProcessedPhoto;
      try {
        processed = await deps.process(item.file);
      } catch (e) {
        if (item.id === undefined) rowsCounted -= 1; // never inserted → frees its slot
        if (e instanceof PhotoRejectError) skip(item.key, e.reason);
        else fail(item.key, "process_failed", item.fp);
        continue;
      }

      // Bound memory: start this photo's uploads only after the previous photo's finished.
      await prevJob;
      if (fatal) {
        // Cannot write any more; this processed photo is dropped un-attempted.
        break;
      }
      if (item.id === undefined && dbLimitHit) {
        // The cap was hit while this photo was being processed — don't try to insert.
        skip(item.key, "limit");
        continue;
      }
      prevJob = uploadPhoto(item, processed).catch(() => fail(item.key, "upload_failed", item.fp));
    }
    await prevJob;
    const s = summary();
    emit({ type: "finished", summary: s });
    return s;
  }

  return {
    add(files: File[]) {
      if (files.length === 0) return;
      const batch = files.map((file) => ({ key: nextKey++, file }));
      total += batch.length;
      pendingAdds += 1;
      progress();
      addChain = addChain
        .then(() => classify(batch))
        .catch(() => undefined)
        .finally(() => {
          pendingAdds -= 1;
          wake();
        });
    },
    start() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      wake();
    },
    cancel() {
      cancelled = true;
      wake();
    },
  };
}

import { describe, expect, it } from "vitest";
import type { ProcessedPhoto } from "@/lib/image/process-photo";
import { PhotoRejectError, type PhotoRejectReason } from "@/lib/image/resize";
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  ROW_MISSING_CODE,
  createUploadQueue,
  photoPaths,
  type DbError,
  type ExistingPhoto,
  type PendingRow,
  type QueueEvent,
  type QueueSummary,
  type ReadyPatch,
  type UploadQueueDeps,
} from "@/lib/upload/queue";

const USER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const tick = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));
const fpOf = (tag: string) => `s1:${tag}|`.padEnd(19, "_");

/** Files are tagged by name; the fake fingerprint is derived from the name. */
function file(tag: string, type = "image/jpeg"): File {
  return new File([new Uint8Array([1, 2, 3])], tag, { type });
}
const files = (n: number, prefix = "f") => Array.from({ length: n }, (_, i) => file(`${prefix}${i}`));

function processed(f: File): ProcessedPhoto {
  const isPng = f.type === "image/png";
  return {
    meta: {
      takenAt: "2026-11-01T10:00:00.000Z",
      takenAtLocal: "2026-11-01T14:00:00",
      dateSource: "exif",
      lat: 24.45,
      lng: 54.38,
      camera: "Test Cam",
      orientation: 1,
    },
    fingerprint: fpOf(f.name),
    width: 4000,
    height: 3000,
    phash: "0123456789abcdef",
    blurScore: 123.5,
    original: {
      blob: new Blob(["o"]),
      mime: isPng ? "image/png" : "image/jpeg",
      bytes: 1234,
      ext: isPng ? "png" : "jpg",
    },
    web: { blob: new Blob(["w"]), ext: "jpg", width: 1600, height: 1200 },
    thumb: { blob: new Blob(["t"]), ext: "jpg", width: 512, height: 384 },
  };
}

interface Row {
  id: string;
  user_id: string;
  book_id: string;
  fingerprint: string;
  upload_state: "pending" | "ready";
  patch?: ReadyPatch;
}

interface Harness {
  deps: UploadQueueDeps;
  events: QueueEvent[];
  rows: Map<string, Row>;
  inserts: PendingRow[][];
  markCalls: { id: string; patch: ReadyPatch }[];
  uploads: { path: string; contentType: string }[];
  sleeps: number[];
  processCalls: string[];
  stats: { maxUploads: number; maxProcessing: number; maxHeld: number; maxWaiting: number };
  /** Hooks for fault injection. */
  faults: {
    upload?: (path: string, attempt: number) => { message: string; statusCode?: string } | null;
    markReady?: (id: string, attempt: number) => DbError | null;
    insert?: (call: number) => DbError | null;
    reject?: (tag: string) => PhotoRejectReason | null;
  };
  /** Extra rows the "DB" counts toward the cap (another tab). */
  cap: { limit: number };
}

function harness(opts: { existing?: ExistingPhoto[]; isPaid?: boolean } = {}): Harness {
  const existing = opts.existing ?? [];
  const rows = new Map<string, Row>();
  for (const e of existing) rows.set(e.id, { ...e, user_id: USER, book_id: BOOK });

  const h: Harness = {
    deps: undefined as unknown as UploadQueueDeps,
    events: [],
    rows,
    inserts: [],
    markCalls: [],
    uploads: [],
    sleeps: [],
    processCalls: [],
    stats: { maxUploads: 0, maxProcessing: 0, maxHeld: 0, maxWaiting: 0 },
    faults: {},
    cap: { limit: opts.isPaid ? 500 : 150 },
  };

  let uploadsInFlight = 0;
  let processing = 0;
  // Per photo: processed and not yet fully uploaded / processed and no upload started.
  const held = new Set<string>();
  const waiting = new Set<string>();
  const remainingUploads = new Map<string, number>(); // photo id -> uploads not finished
  const uploadAttempts = new Map<string, number>();
  const markAttempts = new Map<string, number>();
  let insertCalls = 0;

  const track = () => {
    h.stats.maxHeld = Math.max(h.stats.maxHeld, held.size);
    h.stats.maxWaiting = Math.max(h.stats.maxWaiting, waiting.size);
  };

  h.deps = {
    userId: USER,
    bookId: BOOK,
    isPaid: opts.isPaid ?? false,
    existing,
    fingerprintOnly: async (f) => fpOf(f.name),
    process: async (f) => {
      h.processCalls.push(f.name);
      processing += 1;
      h.stats.maxProcessing = Math.max(h.stats.maxProcessing, processing);
      await tick();
      processing -= 1;
      const reason = h.faults.reject?.(f.name) ?? null;
      if (reason) throw new PhotoRejectError(reason);
      const fp = fpOf(f.name);
      held.add(fp);
      waiting.add(fp);
      track();
      return processed(f);
    },
    db: {
      async insertPending(batch) {
        insertCalls += 1;
        h.inserts.push(batch);
        await tick();
        const err = h.faults.insert?.(insertCalls) ?? null;
        if (err) return { data: null, error: err };
        for (const r of batch) {
          if ([...rows.values()].some((x) => x.fingerprint === r.fingerprint)) {
            return {
              data: null,
              error: { code: "23505", message: 'duplicate key value violates unique constraint "photos_book_fingerprint_key"' },
            };
          }
          if (rows.size >= h.cap.limit) {
            return { data: null, error: { code: "P0001", message: "photo_limit_reached", hint: String(h.cap.limit) } };
          }
        }
        const out = batch.map((r) => {
          const id = crypto.randomUUID();
          rows.set(id, { id, ...r });
          return { id, fingerprint: r.fingerprint };
        });
        return { data: out, error: null };
      },
      async markReady(id, patch) {
        h.markCalls.push({ id, patch });
        const n = (markAttempts.get(id) ?? 0) + 1;
        markAttempts.set(id, n);
        await tick();
        const err = h.faults.markReady?.(id, n) ?? null;
        if (err) return { error: err };
        const row = rows.get(id);
        if (!row) return { error: { code: ROW_MISSING_CODE } };
        row.upload_state = "ready";
        row.patch = patch;
        held.delete(row.fingerprint);
        return { error: null };
      },
      async findByFingerprints(fps) {
        return [...rows.values()]
          .filter((r) => fps.includes(r.fingerprint))
          .map((r) => ({ id: r.id, fingerprint: r.fingerprint, upload_state: r.upload_state }));
      },
    },
    storage: {
      async upload(path, _blob, contentType) {
        const id = /\/([0-9a-f-]{36})-/.exec(path)?.[1] ?? "";
        const fp = rows.get(id)?.fingerprint;
        if (fp) {
          waiting.delete(fp);
          if (!remainingUploads.has(id)) remainingUploads.set(id, 3);
        }
        uploadsInFlight += 1;
        h.stats.maxUploads = Math.max(h.stats.maxUploads, uploadsInFlight);
        const n = (uploadAttempts.get(path) ?? 0) + 1;
        uploadAttempts.set(path, n);
        await tick(2);
        uploadsInFlight -= 1;
        const err = h.faults.upload?.(path, n) ?? null;
        if (err) {
          // a failing photo releases its memory once the queue gives up on it
          if (n >= MAX_ATTEMPTS && fp) held.delete(fp);
          return { error: err };
        }
        h.uploads.push({ path, contentType });
        return { error: null };
      },
    },
    onEvent: (e) => h.events.push(e),
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
  };
  return h;
}

async function run(h: Harness, selected: File[]): Promise<QueueSummary> {
  const q = createUploadQueue(h.deps);
  q.add(selected);
  return q.start();
}

const photoEvents = (h: Harness) =>
  h.events.filter((e): e is Extract<QueueEvent, { type: "photo" }> => e.type === "photo");

describe("createUploadQueue", () => {
  it("rejects non-UUID user/book ids (paths must match the owner CHECK)", () => {
    const h = harness();
    expect(() => createUploadQueue({ ...h.deps, userId: "../x" })).toThrow(RangeError);
  });

  it("uploads new photos: one insert per photo, 3 files, markReady with the full patch", async () => {
    const h = harness();
    const s = await run(h, [file("a"), file("b", "image/png")]);
    expect(s).toMatchObject({ total: 2, uploaded: 2, failed: 0, skipped: 0, notStarted: 0, pendingLeft: 0 });
    expect(h.inserts).toHaveLength(2);
    expect(h.inserts[0]).toEqual([{ user_id: USER, book_id: BOOK, fingerprint: fpOf("a"), upload_state: "pending" }]);
    expect(h.uploads).toHaveLength(6);
    expect([...h.rows.values()].every((r) => r.upload_state === "ready")).toBe(true);

    const png = [...h.rows.values()].find((r) => r.fingerprint === fpOf("b"))!;
    expect(png.patch).toEqual({
      original_path: `${USER}/${BOOK}/${png.id}-original.png`,
      web_path: `${USER}/${BOOK}/${png.id}-web.jpg`,
      thumb_path: `${USER}/${BOOK}/${png.id}-thumb.jpg`,
      width: 4000,
      height: 3000,
      taken_at: "2026-11-01T10:00:00.000Z",
      date_source: "exif",
      lat: 24.45,
      lng: 54.38,
      camera: "Test Cam",
      phash: "0123456789abcdef",
      blur_score: 123.5,
      original_bytes: 1234,
      original_mime: "image/png",
      upload_state: "ready",
    });
    expect(png.patch).not.toHaveProperty("place");
    const types = Object.fromEntries(h.uploads.map((u) => [u.path.split("-").pop(), u.contentType]));
    expect(types).toEqual({ "original.png": "image/png", "web.jpg": "image/jpeg", "thumb.jpg": "image/jpeg", "original.jpg": "image/jpeg" });
    expect(h.events.at(-1)).toEqual({ type: "finished", summary: s });
  });

  it("paths match the 0300 photos_*_path_owner CHECK (user_id/book_id/ prefix) and the id", async () => {
    const h = harness();
    await run(h, files(3));
    const re = new RegExp(`^${USER}/${BOOK}/${UUID}-(original\\.(jpg|png|webp)|web\\.jpg|thumb\\.jpg)$`);
    for (const u of h.uploads) {
      expect(u.path).toMatch(re);
      expect(u.path.startsWith(`${USER}/${BOOK}/`)).toBe(true); // LIKE user_id || '/' || book_id || '/%'
    }
    for (const r of h.rows.values()) {
      for (const p of [r.patch!.original_path, r.patch!.web_path, r.patch!.thumb_path]) {
        expect(p.startsWith(`${USER}/${BOOK}/${r.id}-`)).toBe(true);
      }
    }
    expect(photoPaths(USER, BOOK, "abc", "webp").original).toBe(`${USER}/${BOOK}/abc-original.webp`);
  });

  it("resumes after a crash: ready skipped, pending retried with its id, no duplicate inserts/uploads", async () => {
    const readyId = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    const h = harness({
      existing: [
        { id: readyId, fingerprint: fpOf("done"), upload_state: "ready" },
        { id: pendingId, fingerprint: fpOf("half"), upload_state: "pending" },
      ],
    });
    const s = await run(h, [file("done"), file("half"), file("new")]);

    expect(s).toMatchObject({ total: 3, uploaded: 2, skipped: 1, skippedBy: { already_uploaded: 1 }, pendingLeft: 0 });
    expect(h.processCalls).toEqual(["half", "new"]); // ready one never processed
    expect(h.inserts.flat().map((r) => r.fingerprint)).toEqual([fpOf("new")]);
    expect(h.uploads.filter((u) => u.path.includes(readyId))).toHaveLength(0);
    expect(h.uploads.filter((u) => u.path.includes(pendingId))).toHaveLength(3);
    expect(h.uploads).toHaveLength(6);
    expect(new Set(h.uploads.map((u) => u.path)).size).toBe(6);
    expect(h.rows.size).toBe(3);
    expect(h.rows.get(pendingId)!.upload_state).toBe("ready");
  });

  it("reports pending rows the user did not re-select (pendingLeft)", async () => {
    const h = harness({ existing: [{ id: crypto.randomUUID(), fingerprint: fpOf("lost"), upload_state: "pending" }] });
    const s = await run(h, [file("x")]);
    expect(s.pendingLeft).toBe(1);
  });

  it("keeps only the first of identical files within a selection", async () => {
    const h = harness();
    // Default fingerprint (content-based): same bytes under different names are the same photo.
    const deps: UploadQueueDeps = { ...h.deps, fingerprintOnly: undefined };
    const same = new Uint8Array(64).fill(7);
    const q = createUploadQueue(deps);
    q.add([new File([same], "a.jpg"), new File([same], "copy.jpg"), new File([new Uint8Array(64)], "b.jpg")]);
    const s = await q.start();
    expect(s).toMatchObject({ uploaded: 2, skipped: 1, skippedBy: { duplicate_in_selection: 1 } });
    expect(h.processCalls).toEqual(["a.jpg", "b.jpg"]);
    expect(photoEvents(h).find((e) => e.status === "skipped")).toEqual({
      type: "photo",
      key: 1,
      status: "skipped",
      reason: "duplicate_in_selection",
    });
  });

  it("an upload failing 3 times marks the photo failed and the queue continues", async () => {
    const h = harness();
    const firstRowId = () => [...h.rows.keys()][0];
    h.faults.upload = (path) =>
      path === `${USER}/${BOOK}/${firstRowId()}-web.jpg` ? { message: "network", statusCode: "500" } : null;
    const s = await run(h, files(3));
    const firstId = firstRowId();
    expect(s).toMatchObject({ uploaded: 2, failed: 1, failedBy: { upload_failed: 1 }, pendingLeft: 1 });
    const webAttempts = h.uploads.filter((u) => u.path === `${USER}/${BOOK}/${firstId}-web.jpg`);
    expect(webAttempts).toHaveLength(0);
    expect(h.sleeps).toEqual([BACKOFF_MS[0], BACKOFF_MS[1]]); // 3 attempts = 2 waits
    expect(h.rows.get(firstId!)!.upload_state).toBe("pending");
    expect(h.markCalls.map((m) => m.id)).not.toContain(firstId);
    expect(photoEvents(h).map((e) => e.status)).toEqual(["failed", "uploaded", "uploaded"]);
  });

  it("does not retry storage 4xx (except 408/429)", async () => {
    const h = harness();
    h.faults.upload = (path) => (path.endsWith("-thumb.jpg") ? { message: "too big", statusCode: "413" } : null);
    const s = await run(h, files(1));
    expect(s.failedBy).toEqual({ upload_failed: 1 });
    expect(h.sleeps).toEqual([]);
  });

  it("retries markReady and succeeds on the 3rd attempt", async () => {
    const h = harness();
    h.faults.markReady = (_id, n) => (n < 3 ? { code: "08006", message: "connection failure" } : null);
    const s = await run(h, files(1));
    expect(s).toMatchObject({ uploaded: 1, failed: 0 });
    expect(h.markCalls).toHaveLength(3);
    expect(h.sleeps).toEqual([500, 1500]);
    expect(h.uploads).toHaveLength(3); // uploads not repeated
  });

  it("markReady failing 3 times → failed; missing row → failed without retry", async () => {
    const h = harness();
    h.faults.markReady = () => ({ code: "08006" });
    expect(await run(h, files(1))).toMatchObject({ failed: 1, failedBy: { upload_failed: 1 }, pendingLeft: 1 });
    expect(h.markCalls).toHaveLength(3);

    const h2 = harness();
    h2.faults.markReady = () => ({ code: ROW_MISSING_CODE });
    expect(await run(h2, files(1))).toMatchObject({ failed: 1 });
    expect(h2.markCalls).toHaveLength(1);
  });

  describe("failed photos can be re-selected in the same session (S1)", () => {
    it("upload_failed → re-add → retried with the same row id", async () => {
      const h = harness();
      let broken = true;
      h.faults.upload = (path) => (broken && path.endsWith("-web.jpg") ? { message: "network", statusCode: "500" } : null);
      const q = createUploadQueue(h.deps);
      q.add([file("a")]);
      expect(await q.start()).toMatchObject({ failedBy: { upload_failed: 1 }, pendingLeft: 1 });
      const [rowId] = [...h.rows.keys()];
      expect(h.rows.get(rowId)!.upload_state).toBe("pending");

      broken = false;
      q.add([file("a")]);
      const s = await q.start();
      // The first attempt is superseded: no "couldn't be uploaded" left in the summary.
      expect(s).toMatchObject({ total: 2, uploaded: 1, failed: 0, retried: 1, notStarted: 0, pendingLeft: 0 });
      expect(s.failedBy).toEqual({});
      expect(s.skippedBy).toEqual({});
      expect(h.inserts).toHaveLength(1); // no second row
      expect(h.rows.size).toBe(1);
      expect(h.rows.get(rowId)!.upload_state).toBe("ready");
      expect(photoEvents(h).at(-1)).toEqual({ type: "photo", key: 1, status: "uploaded", photoId: rowId });
    });

    it("insert_failed and process_failed → re-add → retried (new row)", async () => {
      const h = harness();
      h.faults.insert = (n) => (n <= MAX_ATTEMPTS ? { code: "08006" } : null);
      let oom = true;
      const base = h.deps.process;
      const q = createUploadQueue({
        ...h.deps,
        process: (f) => (oom && f.name === "b" ? Promise.reject(new Error("oom")) : base(f)),
      });
      q.add([file("a"), file("b")]);
      expect(await q.start()).toMatchObject({ failedBy: { insert_failed: 1, process_failed: 1 } });
      oom = false;
      q.add([file("a"), file("b")]);
      const s = await q.start();
      expect(s).toMatchObject({ total: 4, uploaded: 2, skipped: 0, failed: 0, retried: 2, notStarted: 0 });
      expect([...h.rows.values()].map((r) => r.upload_state)).toEqual(["ready", "ready"]);
    });

    it("read_failed → re-add → retried", async () => {
      const h = harness();
      let unreadable = true;
      const q = createUploadQueue({
        ...h.deps,
        fingerprintOnly: async (f) => {
          if (unreadable) throw new Error("NotReadableError");
          return fpOf(f.name);
        },
      });
      q.add([file("a")]);
      expect(await q.start()).toMatchObject({ failedBy: { read_failed: 1 } });
      unreadable = false;
      q.add([file("a")]);
      expect(await q.start()).toMatchObject({ uploaded: 1 });
    });

    it("missing row on markReady → re-add inserts a fresh row", async () => {
      const h = harness();
      let gone = true;
      h.faults.markReady = (id) => {
        if (!gone) return null;
        gone = false;
        h.rows.delete(id); // "remove unfinished" in another tab
        return { code: ROW_MISSING_CODE };
      };
      const q = createUploadQueue(h.deps);
      q.add([file("a")]);
      expect(await q.start()).toMatchObject({ failed: 1, pendingLeft: 0 });
      q.add([file("a")]);
      expect(await q.start()).toMatchObject({ uploaded: 1, pendingLeft: 0 });
      expect(h.inserts).toHaveLength(2);
      expect(h.rows.size).toBe(1);
    });

    it("rejected photos stay skipped on re-add", async () => {
      const h = harness();
      h.faults.reject = (t) => (t === "tiny" ? "too_small" : null);
      const q = createUploadQueue(h.deps);
      q.add([file("tiny")]);
      await q.start();
      q.add([file("tiny")]);
      const s = await q.start();
      expect(s.skippedBy).toEqual({ too_small: 1, duplicate_in_selection: 1 });
      expect(h.processCalls).toEqual(["tiny"]);
    });

    it("still no duplicate within one selection, even when the first copy failed", async () => {
      const h = harness();
      const same = new Uint8Array(64).fill(9);
      const base = h.deps.process;
      const q = createUploadQueue({
        ...h.deps,
        fingerprintOnly: undefined, // content-based: both copies share a fingerprint
        process: (f) => (f.name === "a.jpg" ? Promise.reject(new Error("oom")) : base(f)),
      });
      // Many files between the copies so the first copy fails before the second is classified.
      q.add([new File([same], "a.jpg"), ...Array.from({ length: 5 }, (_, i) => new File([new Uint8Array(64).fill(i)], `x${i}.jpg`)), new File([same], "copy.jpg")]);
      const s = await q.start();
      expect(s.skippedBy).toEqual({ duplicate_in_selection: 1 });
      expect(h.processCalls).not.toContain("copy.jpg");
    });
  });

  it("160 photos on a free empty book → 150 queued, 10 skipped('limit')", async () => {
    const h = harness();
    const s = await run(h, files(160));
    expect(s).toMatchObject({ total: 160, uploaded: 150, skipped: 10, skippedBy: { limit: 10 }, limit: 150 });
    expect(h.events.filter((e) => e.type === "limit")).toEqual([{ type: "limit", limit: 150, skipped: 10 }]);
    expect(h.processCalls).toHaveLength(150);
    expect(h.rows.size).toBe(150);
    expect(h.processCalls).not.toContain("f150");
  });

  it("cap counts existing rows incl. pending; pending retries never hit the browser cap", async () => {
    const existing: ExistingPhoto[] = Array.from({ length: 498 }, (_, i) => ({
      id: crypto.randomUUID(),
      fingerprint: fpOf(`old${i}`),
      upload_state: i === 0 ? "pending" : "ready",
    }));
    const h = harness({ existing, isPaid: true });
    const s = await run(h, [file("old0"), ...files(5)]);
    expect(s).toMatchObject({ uploaded: 3, skippedBy: { limit: 3 } }); // old0 + 2 new
  });

  it("photo_limit_reached from the DB mid-run (another tab) stops adding cleanly", async () => {
    const pendingId = crypto.randomUUID();
    const h = harness({ existing: [{ id: pendingId, fingerprint: fpOf("p"), upload_state: "pending" }] });
    // Another tab filled the book: the DB only has room for 3 rows in total.
    h.cap.limit = 3;
    const s = await run(h, [...files(5), file("p")]);
    expect(s).toMatchObject({ uploaded: 3, skipped: 3, skippedBy: { limit: 3 }, limit: 3, failed: 0, notStarted: 0 });
    expect(h.rows.get(pendingId)!.upload_state).toBe("ready"); // pending retry still finished
    const limitEvents = h.events.filter((e) => e.type === "limit");
    expect(limitEvents).toHaveLength(1);
    expect(limitEvents[0]).toMatchObject({ type: "limit", limit: 3 });
    expect(h.inserts).toHaveLength(3); // f0, f1, then f2 hits the cap; f3, f4 never tried
    expect(h.processCalls).not.toContain("f4");
  });

  it("PhotoRejectError → skipped with its reason, no row inserted", async () => {
    const h = harness();
    h.faults.reject = (tag) => (tag === "f1" ? "too_small" : null);
    const s = await run(h, files(3));
    expect(s).toMatchObject({ uploaded: 2, skipped: 1, skippedBy: { too_small: 1 }, pendingLeft: 0 });
    expect(h.inserts.flat().map((r) => r.fingerprint)).not.toContain(fpOf("f1"));
    expect([...h.rows.values()].every((r) => r.upload_state === "ready")).toBe(true);
  });

  it("other processing errors → failed('process_failed'), queue continues", async () => {
    const h = harness();
    const base = h.deps.process;
    const s = await run({ ...h, deps: { ...h.deps, process: (f) => (f.name === "f0" ? Promise.reject(new Error("oom")) : base(f)) } }, files(2));
    expect(s).toMatchObject({ uploaded: 1, failedBy: { process_failed: 1 } });
  });

  it("duplicate key on insert → reuses the existing row (pending → upload, ready → skip)", async () => {
    const h = harness();
    // Another tab inserted both meanwhile; our page-load `existing` didn't know.
    const pendingId = crypto.randomUUID();
    h.rows.set(pendingId, { id: pendingId, user_id: USER, book_id: BOOK, fingerprint: fpOf("a"), upload_state: "pending" });
    const readyId = crypto.randomUUID();
    h.rows.set(readyId, { id: readyId, user_id: USER, book_id: BOOK, fingerprint: fpOf("b"), upload_state: "ready" });
    const s = await run(h, [file("a"), file("b")]);
    expect(s).toMatchObject({ uploaded: 1, skippedBy: { already_uploaded: 1 } });
    expect(h.rows.size).toBe(2);
    expect(h.uploads.every((u) => u.path.includes(pendingId))).toBe(true);
  });

  it("insert with unknown errors is retried, then failed", async () => {
    const h = harness();
    h.faults.insert = (n) => (n <= 3 ? { code: "08006" } : null);
    const s = await run(h, files(2));
    expect(s).toMatchObject({ uploaded: 1, failedBy: { insert_failed: 1 } });
    expect(h.inserts).toHaveLength(4);
  });

  it("not_allowed (RLS) is fatal: stops, nothing else attempted", async () => {
    const h = harness();
    h.faults.insert = () => ({ code: "42501", message: "new row violates row-level security policy" });
    const s = await run(h, files(4));
    expect(s.fatal).toBe("not_allowed");
    expect(s.failedBy).toEqual({ not_allowed: 1 });
    expect(h.inserts).toHaveLength(1);
    expect(s.notStarted).toBeGreaterThanOrEqual(2);
    expect(s.uploaded + s.failed + s.skipped + s.notStarted).toBe(4);
  });

  it("progress is monotonic and ends at done === total", async () => {
    const h = harness({ existing: [{ id: crypto.randomUUID(), fingerprint: fpOf("f0"), upload_state: "ready" }] });
    h.faults.reject = (t) => (t === "f3" ? "decode_failed" : null);
    h.faults.upload = (p, n) => (p.endsWith("thumb.jpg") && n === 1 ? { message: "flaky", statusCode: "503" } : null);
    await run(h, [...files(8), file("f2")]);
    const prog = h.events.filter((e): e is Extract<QueueEvent, { type: "progress" }> => e.type === "progress");
    expect(prog.length).toBeGreaterThan(5);
    for (let i = 1; i < prog.length; i++) {
      expect(prog[i].done).toBeGreaterThanOrEqual(prog[i - 1].done);
      expect(prog[i].total).toBeGreaterThanOrEqual(prog[i - 1].total);
    }
    for (const p of prog) expect(p.done).toBeLessThanOrEqual(p.total);
    const last = prog.at(-1)!;
    expect(last).toMatchObject({ done: 9, total: 9, uploaded: 6, skipped: 3 });
  });

  it("processes one photo at a time and holds at most 1 processed photo waiting", async () => {
    const h = harness();
    await run(h, files(12));
    expect(h.stats.maxProcessing).toBe(1);
    expect(h.stats.maxWaiting).toBeLessThanOrEqual(1);
    // one uploading + one waiting
    expect(h.stats.maxHeld).toBeLessThanOrEqual(2);
  });

  it("keeps uploads in flight ≤ 3 (and uses the parallelism)", async () => {
    const h = harness();
    await run(h, files(10));
    expect(h.stats.maxUploads).toBe(3);
  });

  it("accepts more files while running", async () => {
    const h = harness();
    const q = createUploadQueue(h.deps);
    q.add(files(2, "a"));
    const done = q.start();
    await tick(3);
    q.add([...files(2, "b"), file("a0")]);
    const s = await done;
    expect(s).toMatchObject({ total: 5, uploaded: 4, skippedBy: { duplicate_in_selection: 1 } });
  });

  it("pause stops between photos; resume continues", async () => {
    const h = harness();
    const q = createUploadQueue({
      ...h.deps,
      onEvent: (e) => {
        h.events.push(e);
        if (e.type === "photo" && e.status === "uploaded" && h.events.filter((x) => x.type === "photo").length === 1) q.pause();
      },
    });
    q.add(files(6));
    const done = q.start();
    await tick(60);
    const processedWhilePaused = h.processCalls.length;
    expect(processedWhilePaused).toBeLessThanOrEqual(2); // the one already in flight may finish
    await tick(30);
    expect(h.processCalls.length).toBe(processedWhilePaused);
    q.resume();
    const s = await done;
    expect(s).toMatchObject({ uploaded: 6, cancelled: false });
  });

  it("cancel stops after the current photo; in-flight work finishes cleanly", async () => {
    const h = harness();
    const q = createUploadQueue({
      ...h.deps,
      onEvent: (e) => {
        h.events.push(e);
        if (e.type === "photo" && e.status === "uploaded") q.cancel();
      },
    });
    q.add(files(6));
    const s = await q.start();
    expect(s.cancelled).toBe(true);
    expect(s.uploaded).toBeLessThanOrEqual(2);
    expect(s.notStarted).toBe(6 - s.uploaded);
    expect(h.processCalls.length).toBe(s.uploaded);
    // no half-written photo: every inserted row is ready
    expect([...h.rows.values()].every((r) => r.upload_state === "ready")).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ type: "finished" });
  });

  it("cancel while paused finishes", async () => {
    const h = harness();
    const q = createUploadQueue(h.deps);
    q.pause();
    q.add(files(3));
    const done = q.start();
    await tick(10);
    q.cancel();
    expect(await done).toMatchObject({ uploaded: 0, cancelled: true, notStarted: 3 });
  });

  it("never puts file names in events", async () => {
    const h = harness();
    h.faults.reject = (t) => (t === "secret-name-1" ? "too_large" : null);
    await run(h, [file("secret-name-0"), file("secret-name-1")]);
    expect(JSON.stringify(h.events)).not.toContain("secret-name");
  });
});

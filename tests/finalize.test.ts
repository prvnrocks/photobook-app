import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("real client must not be used in finalize tests");
  },
}));

const { finalizeBook, isEmptyDoc, MAX_CLUSTERS_PER_RUN } = await import("@/lib/photos/finalize");
const { parseBookDoc, validateBookDoc } = await import("@/lib/book/schema");
type FinalizeDb = import("@/lib/photos/finalize").FinalizeDb;
type FinalizePhotoRow = import("@/lib/db/photos").FinalizePhotoRow;
type MyBook = import("@/lib/db/books").MyBook;

const BOOK = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLACE = "Zzplace Testville";

type FakePhoto = FinalizePhotoRow & { upload_state: "pending" | "ready" };

function photo(n: number, o: Partial<FakePhoto> = {}): FakePhoto {
  return {
    id: pid(n),
    width: 3000,
    height: 4000,
    taken_at: `2026-10-12T${String(8 + (n % 10)).padStart(2, "0")}:00:00Z`,
    date_source: "exif",
    lat: null,
    lng: null,
    place: null,
    // Distinct hashes far apart (each nibble differs) unless overridden.
    phash: (n % 16).toString(16).repeat(16),
    blur_score: 100,
    status: "kept",
    dup_group: null,
    upload_state: "ready",
    ...o,
  };
}

function makeDb(initial: { photos: FakePhoto[]; doc?: unknown; isPaid?: boolean }) {
  const book: MyBook = {
    id: BOOK,
    title: null,
    occasion: "travel",
    tone: "fun",
    caption_lang: "en",
    is_paid: initial.isPaid ?? false,
    max_pages: initial.isPaid ? 100 : 20,
    page_count: 0,
    doc: (initial.doc ?? {}) as MyBook["doc"],
    updated_at: "2026-11-08T10:00:00.000001+00:00",
  };
  const photos = initial.photos.map((p) => ({ ...p }));
  const calls = { setDupGroup: [] as [string[], number | null][], setPlace: 0, writeDoc: 0 };
  let tick = 1;
  const db: FinalizeDb = {
    async getBook(id) {
      return id === BOOK ? { ...book } : null;
    },
    async listReadyPhotos(id) {
      return photos
        .filter((p) => id === BOOK && p.upload_state === "ready")
        .map((p) => {
          const { upload_state, ...rest } = p;
          void upload_state;
          return rest;
        });
    },
    async setDupGroup(_id, ids, value) {
      calls.setDupGroup.push([[...ids], value]);
      for (const p of photos) if (ids.includes(p.id)) p.dup_group = value;
    },
    async setPlace(_id, ids, place) {
      calls.setPlace++;
      for (const p of photos) if (ids.includes(p.id) && p.place === null) p.place = place;
    },
    async writeDocIfEmpty(_id, doc, pageCount, expectedUpdatedAt) {
      calls.writeDoc++;
      if (!isEmptyDoc(book.doc) || book.updated_at !== expectedUpdatedAt) return false;
      book.doc = doc;
      book.page_count = pageCount;
      book.updated_at = `2026-11-08T10:00:0${tick++}.000000+00:00`;
      return true;
    },
  };
  return { db, book, photos, calls };
}

function makeGeocoder(label: string | null = PLACE) {
  return vi.fn<(lat: number, lng: number) => Promise<string | null>>(async () => label);
}

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("finalizeBook", () => {
  it("returns null when the book is missing / not the caller's", async () => {
    const { db } = makeDb({ photos: [photo(1)] });
    expect(await finalizeBook(OTHER, { db, geocoder: makeGeocoder() })).toBeNull();
  });

  it("writes dup groups for duplicates, batched per value, and clears stale groups", async () => {
    const hash = "a".repeat(16);
    const { db, photos, calls } = makeDb({
      photos: [
        photo(1, { phash: hash, taken_at: "2026-10-12T10:00:00Z" }),
        photo(2, { phash: hash, taken_at: "2026-10-12T10:05:00Z" }),
        photo(3, { phash: hash, taken_at: "2026-10-12T10:06:00Z" }),
        photo(4, { dup_group: 7 }), // no longer grouped → null
        photo(5),
      ],
    });
    const r = await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    expect(r).toMatchObject({ dupGroups: 1, dupPhotos: 3 });
    expect(photos.map((p) => p.dup_group)).toEqual([1, 1, 1, null, null]);
    // One update for group 1 (3 ids) + one for null (1 id).
    expect(calls.setDupGroup).toHaveLength(2);
    expect(calls.setDupGroup.find(([, v]) => v === 1)?.[0]).toHaveLength(3);
    expect(calls.setDupGroup.find(([, v]) => v === null)?.[0]).toEqual([pid(4)]);

    // Unchanged on a re-run → no writes.
    calls.setDupGroup.length = 0;
    await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    expect(calls.setDupGroup).toHaveLength(0);
  });

  it("geocodes once per cluster, writes places, and a re-run makes 0 geocoder calls", async () => {
    const { db, photos } = makeDb({
      photos: [
        photo(1, { lat: 24.45, lng: 54.37 }),
        photo(2, { lat: 24.4501, lng: 54.3701 }), // same cluster as 1
        photo(3, { lat: 25.2, lng: 55.27 }), // second cluster
        photo(4), // no GPS
        photo(5, { lat: 24.5, lng: 54.4, place: "Already set" }), // has place → not geocoded
      ],
    });
    const geocoder = makeGeocoder();
    const r = await finalizeBook(BOOK, { db, geocoder });
    expect(geocoder).toHaveBeenCalledTimes(2);
    expect(photos.map((p) => p.place)).toEqual([PLACE, PLACE, PLACE, null, "Already set"]);
    expect(r).toMatchObject({ withGps: 4, withPlace: 4, placesPending: 0 });

    const again = makeGeocoder();
    await finalizeBook(BOOK, { db, geocoder: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("caps geocoding at 50 clusters per run and reports placesPending", async () => {
    const pts = Array.from({ length: 60 }, (_, i) =>
      photo(i + 1, { lat: 20 + i * 0.1, lng: 54 }), // ~11 km apart → 60 clusters
    );
    const { db } = makeDb({ photos: pts });
    const geocoder = makeGeocoder();
    const r = await finalizeBook(BOOK, { db, geocoder });
    expect(MAX_CLUSTERS_PER_RUN).toBe(50);
    expect(geocoder).toHaveBeenCalledTimes(50);
    expect(r).toMatchObject({ withGps: 60, withPlace: 50, placesPending: 10 });

    const second = makeGeocoder();
    const r2 = await finalizeBook(BOOK, { db, geocoder: second });
    expect(second).toHaveBeenCalledTimes(10);
    expect(r2?.placesPending).toBe(0);
  });

  it("skips geocoding once the time budget is spent (photos stay pending)", async () => {
    let t = 0;
    const { db } = makeDb({
      photos: Array.from({ length: 10 }, (_, i) => photo(i + 1, { lat: 20 + i, lng: 54 })),
    });
    const geocoder = vi.fn(async () => {
      t += 1000;
      return PLACE;
    });
    const r = await finalizeBook(BOOK, { db, geocoder, geocodeBudgetMs: 2500, now: () => t });
    expect(geocoder.mock.calls.length).toBeLessThan(10);
    expect(r?.placesPending).toBeGreaterThan(0);
  });

  it("geocode failures (null) leave places null and pending", async () => {
    const { db, photos, calls } = makeDb({ photos: [photo(1, { lat: 24.45, lng: 54.37 })] });
    const r = await finalizeBook(BOOK, { db, geocoder: makeGeocoder(null) });
    expect(photos[0].place).toBeNull();
    expect(calls.setPlace).toBe(0);
    expect(r?.placesPending).toBe(1);
  });

  it("empty doc → writes a valid fallback album + page_count", async () => {
    const { db, book } = makeDb({
      photos: Array.from({ length: 12 }, (_, i) => photo(i + 1)),
    });
    const r = await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    expect(r?.wroteDoc).toBe(true);
    const parsed = parseBookDoc(book.doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ids = new Set(Array.from({ length: 12 }, (_, i) => pid(i + 1)));
    expect(validateBookDoc(parsed.doc, { photoIds: ids, maxPages: 20 })).toEqual([]);
    expect(book.page_count).toBe(parsed.doc.pages.length);
    expect(r?.pages).toBe(parsed.doc.pages.length);
    expect(r?.pages).toBeGreaterThan(0);
  });

  it("never overwrites a non-empty doc (and doesn't even try)", async () => {
    const existing = { version: 1, mine: true };
    const { db, book, calls } = makeDb({ photos: [photo(1)], doc: existing });
    const r = await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    expect(r?.wroteDoc).toBe(false);
    expect(calls.writeDoc).toBe(0);
    expect(book.doc).toEqual(existing);
  });

  it("second run after writing the doc leaves it untouched", async () => {
    const { db, book, calls } = makeDb({ photos: [photo(1), photo(2), photo(3)] });
    await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    const written = JSON.stringify(book.doc);
    const r2 = await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    expect(r2?.wroteDoc).toBe(false);
    expect(calls.writeDoc).toBe(1);
    expect(JSON.stringify(book.doc)).toBe(written);
    expect(r2?.pages).toBe(book.page_count);
  });

  it("lost race (doc written meanwhile) → wroteDoc false", async () => {
    const { db } = makeDb({ photos: [photo(1)] });
    const raced: FinalizeDb = { ...db, writeDocIfEmpty: async () => false };
    const r = await finalizeBook(BOOK, { db: raced, geocoder: makeGeocoder() });
    expect(r?.wroteDoc).toBe(false);
  });

  it("reports docStale when the doc references a photo that is gone", async () => {
    const { db: db1, book } = makeDb({ photos: [photo(1), photo(2), photo(3)] });
    await finalizeBook(BOOK, { db: db1, geocoder: makeGeocoder() });
    const doc = book.doc;

    const { db: fresh } = makeDb({ photos: [photo(1), photo(2), photo(3)], doc });
    expect((await finalizeBook(BOOK, { db: fresh, geocoder: makeGeocoder() }))?.docStale).toBe(false);

    const { db: missing } = makeDb({ photos: [photo(1), photo(2)], doc });
    expect((await finalizeBook(BOOK, { db: missing, geocoder: makeGeocoder() }))?.docStale).toBe(true);
  });

  it("ignores pending photos", async () => {
    const { db, photos } = makeDb({
      photos: [
        photo(1, { lat: 24.45, lng: 54.37 }),
        photo(2, { upload_state: "pending", lat: 25.2, lng: 55.27, phash: "a".repeat(16) }),
        photo(3, { phash: "a".repeat(16) }),
      ],
    });
    const geocoder = makeGeocoder();
    const r = await finalizeBook(BOOK, { db, geocoder });
    expect(r?.photos).toBe(2);
    expect(geocoder).toHaveBeenCalledTimes(1);
    expect(photos[1].place).toBeNull();
    expect(photos[1].dup_group).toBeNull();
    expect(r?.dupGroups).toBe(0);
  });

  it("result and logs contain counts only — no coordinates, places, dates or ids", async () => {
    const { db } = makeDb({
      photos: [
        photo(1, { lat: 24.4539, lng: 54.3773 }),
        photo(2, { lat: 25.1972, lng: 55.2744 }),
        photo(3),
      ],
    });
    const r = await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    expect(r).not.toBeNull();
    expect(Object.keys(r!).sort()).toEqual(
      [
        "photos",
        "withDate",
        "withGps",
        "withPlace",
        "placesPending",
        "dupGroups",
        "dupPhotos",
        "pages",
        "wroteDoc",
        "docStale",
      ].sort(),
    );
    for (const v of Object.values(r!)) expect(["number", "boolean"]).toContain(typeof v);
    const text = JSON.stringify(r) + logs.join("\n");
    for (const s of ["24.45", "54.37", "25.19", "55.27", "Zzplace", "2026-10", pid(1), BOOK]) {
      expect(text).not.toContain(s);
    }
    expect(r).toMatchObject({ photos: 3, withDate: 3, withGps: 2, withPlace: 2 });
  });
});

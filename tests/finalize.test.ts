import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("real client must not be used in finalize tests");
  },
}));
vi.mock("@/lib/book/book-design", async (orig) =>
  (await import("./fixtures/simulated-unsupported-style")).withSimulatedUnsupported(await orig()),
);
const { simulateUnsupported } = await import("./fixtures/simulated-unsupported-style");

const {
  finalizeBook,
  isEmptyDoc,
  MAX_CLUSTERS_PER_RUN,
  FINALIZE_MIN_INTERVAL_S,
  GEOCODE_DAILY_CAP,
  PLACE_RECHECK_MS,
} = await import("@/lib/photos/finalize");
const { parseBookDoc, validateBookDoc } = await import("@/lib/book/schema");
type FinalizeDb = import("@/lib/photos/finalize").FinalizeDb;
type FinalizeResult = import("@/lib/photos/finalize").FinalizeResult;
type FinalizeDeps = import("@/lib/photos/finalize").FinalizeDeps;
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
    place_checked_at: null,
    color: null,
    upload_state: "ready",
    ...o,
  };
}

function makeDb(initial: {
  photos: FakePhoto[];
  doc?: unknown;
  isPaid?: boolean;
  /** Fake clock for the rate limit (ms); without it every claim succeeds. */
  clock?: () => number;
  geocodeUsedToday?: number;
}) {
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
    doc_rev: 0,
    format: "A5_PORTRAIT",
    design_style: "classic",
    updated_at: "2026-11-08T10:00:00.000001+00:00",
  };
  const photos = initial.photos.map((p) => ({ ...p }));
  const calls = {
    setDupGroup: [] as [string[], number | null][],
    setPlace: 0,
    writeDoc: 0,
    claims: 0,
    reserved: [] as { want: number; cap: number; granted: number }[],
    setPlaceChecked: [] as [string, string[], string][],
    setColors: [] as [string, Map<string, string>][],
  };
  let tick = 1;
  let lastRun: number | null = null;
  let geocodeUsed = initial.geocodeUsedToday ?? 0;
  const db: FinalizeDb = {
    async getBook(id) {
      return id === BOOK ? { ...book } : null;
    },
    async claimRun(_id, minIntervalSeconds) {
      calls.claims++;
      if (!initial.clock) return { ok: true };
      const t = initial.clock();
      if (lastRun !== null && t - lastRun < minIntervalSeconds * 1000) {
        return { ok: false, retryAfterSeconds: Math.ceil((lastRun + minIntervalSeconds * 1000 - t) / 1000) };
      }
      lastRun = t;
      return { ok: true };
    },
    async reserveGeocodeCalls(_id, want, cap) {
      const granted = Math.max(0, Math.min(want, cap - geocodeUsed));
      geocodeUsed += granted;
      calls.reserved.push({ want, cap, granted });
      return granted;
    },
    async setPlaceChecked(id, ids, at) {
      calls.setPlaceChecked.push([id, [...ids], at]);
      for (const p of photos) if (ids.includes(p.id)) p.place_checked_at = at;
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
    async setColors(id, colors) {
      calls.setColors.push([id, new Map(colors)]);
      // Same filters as setPhotosColor: this book, colour still null.
      for (const p of photos) if (id === BOOK && p.color === null && colors.has(p.id)) p.color = colors.get(p.id)!;
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

/** finalizeBook, asserting the run was not rate limited. */
async function fin(id: string, deps: FinalizeDeps): Promise<FinalizeResult | null> {
  const r = await finalizeBook(id, deps);
  if (r && "rateLimited" in r) throw new Error("unexpected rate limit");
  return r;
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
    expect(await fin(OTHER, { db, geocoder: makeGeocoder() })).toBeNull();
  });

  it("writes dup groups for duplicates, batched per value, and clears stale groups", async () => {
    const hash = "a".repeat(16);
    const { db, photos, calls } = makeDb({
      photos: [
        photo(1, { phash: hash, taken_at: "2026-10-12T10:00:00Z" }),
        photo(2, { phash: hash, taken_at: "2026-10-12T10:01:00Z" }),
        photo(3, { phash: hash, taken_at: "2026-10-12T10:02:00Z" }),
        photo(4, { dup_group: 7 }), // no longer grouped → null
        photo(5),
      ],
    });
    const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
    expect(r).toMatchObject({ dupGroups: 1, dupPhotos: 3 });
    expect(photos.map((p) => p.dup_group)).toEqual([1, 1, 1, null, null]);
    // One update for group 1 (3 ids) + one for null (1 id).
    expect(calls.setDupGroup).toHaveLength(2);
    expect(calls.setDupGroup.find(([, v]) => v === 1)?.[0]).toHaveLength(3);
    expect(calls.setDupGroup.find(([, v]) => v === null)?.[0]).toEqual([pid(4)]);

    // Unchanged on a re-run → no writes.
    calls.setDupGroup.length = 0;
    await fin(BOOK, { db, geocoder: makeGeocoder() });
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
    const r = await fin(BOOK, { db, geocoder });
    expect(geocoder).toHaveBeenCalledTimes(2);
    expect(photos.map((p) => p.place)).toEqual([PLACE, PLACE, PLACE, null, "Already set"]);
    expect(r).toMatchObject({ withGps: 4, withPlace: 4, placesPending: 0 });

    const again = makeGeocoder();
    await fin(BOOK, { db, geocoder: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("caps geocoding at 50 clusters per run and reports placesPending", async () => {
    const pts = Array.from({ length: 60 }, (_, i) =>
      photo(i + 1, { lat: 20 + i * 0.1, lng: 54 }), // ~11 km apart → 60 clusters
    );
    const { db } = makeDb({ photos: pts });
    const geocoder = makeGeocoder();
    const r = await fin(BOOK, { db, geocoder });
    expect(MAX_CLUSTERS_PER_RUN).toBe(50);
    expect(geocoder).toHaveBeenCalledTimes(50);
    expect(r).toMatchObject({ withGps: 60, withPlace: 50, placesPending: 10 });

    const second = makeGeocoder();
    const r2 = await fin(BOOK, { db, geocoder: second });
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
    const r = await fin(BOOK, { db, geocoder, geocodeBudgetMs: 2500, now: () => t });
    expect(geocoder.mock.calls.length).toBeLessThan(10);
    expect(r?.placesPending).toBeGreaterThan(0);
  });

  it("geocode failures (null) leave places null, mark the attempt and are not retried for 24 h", async () => {
    let t = Date.parse("2026-11-08T10:00:00Z");
    const { db, photos, calls } = makeDb({ photos: [photo(1, { lat: 24.45, lng: 54.37 })] });
    const r = await fin(BOOK, { db, geocoder: makeGeocoder(null), now: () => t });
    expect(photos[0].place).toBeNull();
    expect(calls.setPlace).toBe(0);
    expect(photos[0].place_checked_at).toBe(new Date(t).toISOString());
    expect(r?.placesPending).toBe(0); // a re-run would not try again yet

    t += PLACE_RECHECK_MS - 60_000;
    const soon = makeGeocoder();
    await fin(BOOK, { db, geocoder: soon, now: () => t });
    expect(soon).not.toHaveBeenCalled();

    t += 120_000; // > 24 h after the attempt
    const later = makeGeocoder();
    await fin(BOOK, { db, geocoder: later, now: () => t });
    expect(later).toHaveBeenCalledTimes(1);
    expect(photos[0].place).toBe(PLACE);
  });

  it("marks place_checked_at for every photo of every attempted cluster, success or not", async () => {
    const { db, calls } = makeDb({
      photos: [
        photo(1, { lat: 24.45, lng: 54.37 }),
        photo(2, { lat: 24.4501, lng: 54.3701 }),
        photo(3, { lat: 25.2, lng: 55.27 }),
      ],
    });
    const geocoder = vi.fn(async (lat: number) => (lat > 25 ? null : PLACE));
    await fin(BOOK, { db, geocoder });
    expect(calls.setPlaceChecked).toHaveLength(1);
    const [bookId, ids] = calls.setPlaceChecked[0];
    expect(bookId).toBe(BOOK);
    expect([...ids].sort()).toEqual([pid(1), pid(2), pid(3)]);
  });

  it("clusters skipped by the time budget are not marked as checked", async () => {
    let t = 0;
    const { db, calls } = makeDb({
      photos: Array.from({ length: 10 }, (_, i) => photo(i + 1, { lat: 20 + i, lng: 54 })),
    });
    const geocoder = vi.fn(async () => {
      t += 1000;
      return null;
    });
    const r = await fin(BOOK, { db, geocoder, geocodeBudgetMs: 2500, now: () => t });
    const checked = calls.setPlaceChecked.flatMap(([, ids]) => ids);
    expect(checked).toHaveLength(geocoder.mock.calls.length);
    expect(r?.placesPending).toBe(10 - geocoder.mock.calls.length);
  });

  it("caps geocoding at GEOCODE_DAILY_CAP per book per day (reserved before calling)", async () => {
    expect(GEOCODE_DAILY_CAP).toBe(200);
    const pts = Array.from({ length: 30 }, (_, i) => photo(i + 1, { lat: 20 + i * 0.1, lng: 54 }));
    const { db, calls } = makeDb({ photos: pts, geocodeUsedToday: 190 });
    const geocoder = makeGeocoder();
    const r = await fin(BOOK, { db, geocoder });
    expect(calls.reserved).toEqual([{ want: 30, cap: 200, granted: 10 }]);
    expect(geocoder).toHaveBeenCalledTimes(10);
    expect(r).toMatchObject({ withPlace: 10, placesPending: 20 });

    const none = makeGeocoder();
    const r2 = await fin(BOOK, { db, geocoder: none });
    expect(none).not.toHaveBeenCalled();
    expect(r2?.placesPending).toBe(20);
  });

  it("no geocodable photos → no reservation", async () => {
    const { db, calls } = makeDb({ photos: [photo(1), photo(2, { lat: 1, lng: 1, place: "X" })] });
    await fin(BOOK, { db, geocoder: makeGeocoder() });
    expect(calls.reserved).toEqual([]);
  });

  it("rate limit: a second run within 10 s returns rateLimited before any read or write", async () => {
    expect(FINALIZE_MIN_INTERVAL_S).toBe(10);
    let t = 1_000_000;
    const { db, calls } = makeDb({
      photos: [photo(1, { lat: 24.45, lng: 54.37 })],
      clock: () => t,
    });
    const listSpy = vi.spyOn(db, "listReadyPhotos");
    expect(await finalizeBook(BOOK, { db, geocoder: makeGeocoder(), now: () => t })).not.toHaveProperty(
      "rateLimited",
    );
    expect(listSpy).toHaveBeenCalledTimes(1);

    t += 4_000;
    const geocoder = makeGeocoder();
    const r = await finalizeBook(BOOK, { db, geocoder, now: () => t });
    expect(r).toEqual({ rateLimited: true, retryAfterSeconds: 6 });
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(geocoder).not.toHaveBeenCalled();
    expect(calls.writeDoc).toBe(1);

    t += 6_000;
    expect(await finalizeBook(BOOK, { db, geocoder, now: () => t })).not.toHaveProperty("rateLimited");
    expect(calls.claims).toBe(3);
  });

  it("the owner check runs before the rate-limit claim", async () => {
    const { db, calls } = makeDb({ photos: [photo(1)] });
    expect(await finalizeBook(OTHER, { db, geocoder: makeGeocoder() })).toBeNull();
    expect(calls.claims).toBe(0);
  });

  it("empty doc → writes a valid fallback album + page_count", async () => {
    const { db, book } = makeDb({
      photos: Array.from({ length: 12 }, (_, i) => photo(i + 1)),
    });
    const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
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

  it("a style without layouts (simulated) → no fallback album, doc stays {}, counts still returned (M10b A19 S1)", async () => {
    simulateUnsupported(["scrapbook"]);
    try {
      const { db, book, calls } = makeDb({ photos: Array.from({ length: 5 }, (_, i) => photo(i + 1)) });
      book.design_style = "scrapbook";
      const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
      expect(r).toMatchObject({ photos: 5, wroteDoc: false, pages: 0 });
      expect(calls.writeDoc).toBe(0);
      expect(book.doc).toEqual({});
    } finally {
      simulateUnsupported([]);
    }
  });

  it("geometric / scrapbook books get a fallback album in their own format + style (M10c T10)", async () => {
    for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"]) {
      for (const style of ["geometric", "scrapbook"]) {
        const { db, book, calls } = makeDb({ photos: Array.from({ length: 12 }, (_, i) => photo(i + 1)) });
        book.design_style = style;
        book.format = format;
        const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
        expect(r?.wroteDoc, `${format}/${style}`).toBe(true);
        expect(calls.writeDoc).toBe(1);
        const parsed = parseBookDoc(book.doc);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.doc.format).toBe(format);
        expect(parsed.doc.style.designStyle).toBe(style);
        const ids = new Set(Array.from({ length: 12 }, (_, i) => pid(i + 1)));
        expect(validateBookDoc(parsed.doc, { photoIds: ids, maxPages: 20 })).toEqual([]);
      }
    }
  });

  it("rule album gets catalogue background suggestions in modern/geometric/scrapbook, none in classic (M10c T11)", async () => {
    const { isValidAiBackground } = await import("@/lib/design/background-suggest");
    for (const style of ["classic", "modern", "geometric", "scrapbook"]) {
      const { db, book } = makeDb({ photos: Array.from({ length: 12 }, (_, i) => photo(i + 1, { color: "#6f8f63" })) });
      book.design_style = style;
      await fin(BOOK, { db, geocoder: makeGeocoder() });
      const stored = book.doc as { version: number; style: Record<string, unknown> };
      const parsed = parseBookDoc(stored);
      expect(parsed.ok, style).toBe(true);
      if (!parsed.ok) continue;
      if (style === "classic") {
        expect(stored.version).toBe(1);
        expect(stored.style.background).toBe("#FFFFFF");
        expect(stored.style.backgroundSource).toBeUndefined();
        continue;
      }
      expect(parsed.doc.style.backgroundSource).toBe("ai");
      expect(isValidAiBackground(parsed.doc.style.designStyle, parsed.doc.style.background, { scope: "book" })).toBe(true);
      // Uniform green photos → the green catalogue entry (sage), scrapbook keeps a texture.
      if (style !== "scrapbook") expect(parsed.doc.style.background).toEqual({ kind: "color", hex: "#CAD6C1" });
      else expect(parsed.doc.style.background.kind).toBe("texture");
    }
  });

  it("never overwrites a non-empty doc (and doesn't even try)", async () => {
    const existing = { version: 1, mine: true };
    const { db, book, calls } = makeDb({ photos: [photo(1)], doc: existing });
    const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
    expect(r?.wroteDoc).toBe(false);
    expect(calls.writeDoc).toBe(0);
    expect(book.doc).toEqual(existing);
  });

  it("second run after writing the doc leaves it untouched", async () => {
    const { db, book, calls } = makeDb({ photos: [photo(1), photo(2), photo(3)] });
    await fin(BOOK, { db, geocoder: makeGeocoder() });
    const written = JSON.stringify(book.doc);
    const r2 = await fin(BOOK, { db, geocoder: makeGeocoder() });
    expect(r2?.wroteDoc).toBe(false);
    expect(calls.writeDoc).toBe(1);
    expect(JSON.stringify(book.doc)).toBe(written);
    expect(r2?.pages).toBe(book.page_count);
  });

  it("lost race (doc written meanwhile) → wroteDoc false", async () => {
    const { db } = makeDb({ photos: [photo(1)] });
    const raced: FinalizeDb = { ...db, writeDocIfEmpty: async () => false };
    const r = await fin(BOOK, { db: raced, geocoder: makeGeocoder() });
    expect(r?.wroteDoc).toBe(false);
  });

  it("reports docStale when the doc references a photo that is gone", async () => {
    const { db: db1, book } = makeDb({ photos: [photo(1), photo(2), photo(3)] });
    await fin(BOOK, { db: db1, geocoder: makeGeocoder() });
    const doc = book.doc;

    const { db: fresh } = makeDb({ photos: [photo(1), photo(2), photo(3)], doc });
    expect((await fin(BOOK, { db: fresh, geocoder: makeGeocoder() }))?.docStale).toBe(false);

    const { db: missing } = makeDb({ photos: [photo(1), photo(2)], doc });
    expect((await fin(BOOK, { db: missing, geocoder: makeGeocoder() }))?.docStale).toBe(true);
  });

  it("reports docStale when a photo background's photo is gone (M10a)", async () => {
    const { db: db1, book } = makeDb({ photos: [photo(1), photo(2)] });
    await fin(BOOK, { db: db1, geocoder: makeGeocoder() });
    const parsed = parseBookDoc(book.doc);
    if (!parsed.ok) throw new Error("fixture");
    const withBg = { ...parsed.doc, style: { ...parsed.doc.style, background: { kind: "photo" as const, photoId: pid(9), veil: 0.7, veilColor: "#FFFFFF" } } };
    const { db: missing } = makeDb({ photos: [photo(1), photo(2)], doc: withBg });
    expect((await fin(BOOK, { db: missing, geocoder: makeGeocoder() }))?.docStale).toBe(true);
    const { db: present } = makeDb({ photos: [photo(1), photo(2), photo(9)], doc: withBg });
    expect((await fin(BOOK, { db: present, geocoder: makeGeocoder() }))?.docStale).toBe(false);
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
    const r = await fin(BOOK, { db, geocoder });
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
    const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
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

describe("finalizeBook — photo colours (M10c)", () => {
  const HEX = "#8a7f72";

  it("writes colours only for this book's ready photos whose colour is null", async () => {
    const { db, photos, calls } = makeDb({
      photos: [
        photo(1),
        photo(2, { color: "#112233" }), // existing colour → never overwritten
        photo(3, { upload_state: "pending" }), // not ready → ignored
        photo(4),
      ],
    });
    const foreign = "33333333-3333-4333-8333-333333333333"; // another book's photo
    const r = await finalizeBook(BOOK, { db, geocoder: makeGeocoder() }, {
      colors: { [pid(1)]: HEX, [pid(2)]: "#aaaaaa", [pid(3)]: HEX, [foreign]: HEX, [pid(4)]: "#405060" },
    });
    expect(r).not.toBeNull();
    expect(calls.setColors).toHaveLength(1);
    const [bookId, written] = calls.setColors[0];
    expect(bookId).toBe(BOOK);
    expect([...written.entries()]).toEqual([
      [pid(1), HEX],
      [pid(4), "#405060"],
    ]);
    expect(photos.map((p) => p.color)).toEqual([HEX, "#112233", null, "#405060"]);
  });

  it("skips malformed colours defensively and makes no write when nothing applies", async () => {
    const { db, calls } = makeDb({ photos: [photo(1, { color: "#010203" }), photo(2)] });
    await finalizeBook(BOOK, { db, geocoder: makeGeocoder() }, { colors: { [pid(1)]: HEX, [pid(2)]: "#ABCDEF" } });
    expect(calls.setColors).toHaveLength(0);
    await finalizeBook(BOOK, { db, geocoder: makeGeocoder() });
    expect(calls.setColors).toHaveLength(0);
  });

  it("a colour write failure doesn't fail finalize and logs a code only", async () => {
    const { db } = makeDb({ photos: [photo(1)] });
    db.setColors = async () => {
      throw Object.assign(new Error(`boom ${pid(1)} ${HEX}`), { code: "PGRST301" });
    };
    const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
    expect(r).not.toBeNull();
    const r2 = await finalizeBook(BOOK, { db, geocoder: makeGeocoder() }, { colors: { [pid(1)]: HEX } });
    expect(r2).toMatchObject({ photos: 1 });
    expect(logs).toContain("[finalize] photo colours not saved (PGRST301)");
    expect(logs.join("\n")).not.toContain(HEX);
    expect(logs.join("\n")).not.toContain(pid(1));
  });
});

// M13 review fix 6: finalize's fallback album now comes from buildRuleDraft (src/lib/book/rule-draft.ts).
// These hashes were recorded with the pre-refactor inline pipeline (HEAD cde3d07) — the stored doc
// must stay byte-identical for every format × style × tier × photo mix. Re-record only for an
// intended album change: RECORD_FINALIZE=/tmp/x npx vitest run tests/finalize.test.ts -t byte-identical.
describe("fallback album is byte-identical to the pre-M13 inline pipeline", () => {
  const RECORDED: Record<string, string> = {
    "A5_LANDSCAPE/classic/free/big140": "e5f6dabff89b72f4",
    "A5_LANDSCAPE/classic/free/mixed30": "00b9ea8e5bcd2374",
    "A5_LANDSCAPE/classic/free/plain12": "90067372c4ce1c89",
    "A5_LANDSCAPE/classic/paid/big140": "07807c1d9944eaff",
    "A5_LANDSCAPE/classic/paid/mixed30": "bc41ee60d1d5b65d",
    "A5_LANDSCAPE/classic/paid/plain12": "90067372c4ce1c89",
    "A5_LANDSCAPE/geometric/free/big140": "6f2baf0bf68a30ac",
    "A5_LANDSCAPE/geometric/free/mixed30": "56bcfa30c2e1248d",
    "A5_LANDSCAPE/geometric/free/plain12": "75cfda261e389efe",
    "A5_LANDSCAPE/geometric/paid/big140": "76f4e7bc3565ca28",
    "A5_LANDSCAPE/geometric/paid/mixed30": "880700e952c4319a",
    "A5_LANDSCAPE/geometric/paid/plain12": "75cfda261e389efe",
    "A5_LANDSCAPE/modern/free/big140": "43166fa9570970e6",
    "A5_LANDSCAPE/modern/free/mixed30": "40d2125a4ab3dbb9",
    "A5_LANDSCAPE/modern/free/plain12": "5ce15b2aaf156167",
    "A5_LANDSCAPE/modern/paid/big140": "43166fa9570970e6",
    "A5_LANDSCAPE/modern/paid/mixed30": "6a1c52c7752741b0",
    "A5_LANDSCAPE/modern/paid/plain12": "5ce15b2aaf156167",
    "A5_LANDSCAPE/scrapbook/free/big140": "37ea4e9fc434e764",
    "A5_LANDSCAPE/scrapbook/free/mixed30": "530a4fc18ba9e2f1",
    "A5_LANDSCAPE/scrapbook/free/plain12": "c51b1306f266d80a",
    "A5_LANDSCAPE/scrapbook/paid/big140": "309d42c27a4c7408",
    "A5_LANDSCAPE/scrapbook/paid/mixed30": "e1c4415b7031cf44",
    "A5_LANDSCAPE/scrapbook/paid/plain12": "c51b1306f266d80a",
    "A5_PORTRAIT/classic/free/big140": "2b9731de7dd5a655",
    "A5_PORTRAIT/classic/free/mixed30": "521e5a38ffa630a2",
    "A5_PORTRAIT/classic/free/plain12": "43748980a732d98a",
    "A5_PORTRAIT/classic/paid/big140": "3afb1f12d355bdec",
    "A5_PORTRAIT/classic/paid/mixed30": "4ffba02e87461c7c",
    "A5_PORTRAIT/classic/paid/plain12": "43748980a732d98a",
    "A5_PORTRAIT/geometric/free/big140": "f981231b6c4a1b8c",
    "A5_PORTRAIT/geometric/free/mixed30": "88843ce40e12b8b3",
    "A5_PORTRAIT/geometric/free/plain12": "ab3d85cb36822276",
    "A5_PORTRAIT/geometric/paid/big140": "683bd5c37ff6c2e4",
    "A5_PORTRAIT/geometric/paid/mixed30": "69544ba271435b52",
    "A5_PORTRAIT/geometric/paid/plain12": "ab3d85cb36822276",
    "A5_PORTRAIT/modern/free/big140": "ab889bd0c9517231",
    "A5_PORTRAIT/modern/free/mixed30": "ac2ab2ba5bf63274",
    "A5_PORTRAIT/modern/free/plain12": "f59830eec897a09b",
    "A5_PORTRAIT/modern/paid/big140": "ab889bd0c9517231",
    "A5_PORTRAIT/modern/paid/mixed30": "7aca7b52fa984507",
    "A5_PORTRAIT/modern/paid/plain12": "f59830eec897a09b",
    "A5_PORTRAIT/scrapbook/free/big140": "ae188ceff20b3ffb",
    "A5_PORTRAIT/scrapbook/free/mixed30": "dd5977691126491d",
    "A5_PORTRAIT/scrapbook/free/plain12": "4a4d5e3fa604bdd3",
    "A5_PORTRAIT/scrapbook/paid/big140": "686dc234030cf502",
    "A5_PORTRAIT/scrapbook/paid/mixed30": "fa017387c7d9b186",
    "A5_PORTRAIT/scrapbook/paid/plain12": "4a4d5e3fa604bdd3",
  };
  const mixes: Record<string, () => FakePhoto[]> = {
    plain12: () => Array.from({ length: 12 }, (_, i) => photo(i + 1)),
    mixed30: () =>
      Array.from({ length: 30 }, (_, i) =>
        photo(i + 1, {
          width: i % 3 === 0 ? 4000 : i % 5 === 0 ? null : 3000,
          height: i % 3 === 0 ? 3000 : 4000,
          status: i % 7 === 6 ? "dropped" : "kept",
          color: i % 2 ? "#6f8f63" : "#a05a3c",
          blur_score: i % 4 === 0 ? 5 : 120,
          date_source: i % 6 === 0 ? "file" : "exif",
          taken_at: `2026-${String(1 + (i % 3)).padStart(2, "0")}-1${i % 10}T10:00:00Z`,
        }),
      ),
    big140: () => Array.from({ length: 140 }, (_, i) => photo(i + 1, { color: "#334455" })),
  };
  const cases: string[] = [];
  for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"])
    for (const style of ["classic", "modern", "geometric", "scrapbook"])
      for (const paid of [false, true]) for (const mix of Object.keys(mixes)) cases.push(`${format}/${style}/${paid ? "paid" : "free"}/${mix}`);

  it.each(cases)("%s", async (key) => {
    const [format, style, tier, mix] = key.split("/");
    const { db, book } = makeDb({ photos: mixes[mix](), isPaid: tier === "paid" });
    book.format = format;
    book.design_style = style;
    book.title = mix === "mixed30" ? "رحلة العيد 2026" : null;
    book.caption_lang = mix === "mixed30" ? "ar" : "en";
    book.occasion = mix === "big140" ? "wedding" : "travel";
    const r = await fin(BOOK, { db, geocoder: makeGeocoder() });
    const out = r?.wroteDoc ? `${r.pages}:${JSON.stringify(book.doc)}` : `nowrite:${r?.pages}`;
    const hash = createHash("sha256").update(out).digest("hex").slice(0, 16);
    if (process.env.RECORD_FINALIZE) appendFileSync(process.env.RECORD_FINALIZE, `    ${JSON.stringify(key)}: ${JSON.stringify(hash)},\n`);
    else expect(hash).toBe(RECORDED[key]);
  });
});

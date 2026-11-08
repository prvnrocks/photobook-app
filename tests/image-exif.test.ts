import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatCamera,
  normalizeGps,
  parseDateFromFilename,
  parseExifDate,
  parseOffsetMinutes,
  readPhotoMeta,
} from "@/lib/image/exif";

// Fixtures contain FAKE metadata (see tests/fixtures/README.md).
const FIX = join(process.cwd(), "tests", "fixtures");
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0); // 2026-11-08
const LAST_MODIFIED = Date.UTC(2026, 9, 20, 8, 15, 0); // 2026-10-20

// Pin the runtime zone so "local time" interpretation is deterministic (Asia/Dubai = +04:00, no DST).
let prevTz: string | undefined;
beforeAll(() => {
  prevTz = process.env.TZ;
  process.env.TZ = "Asia/Dubai";
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

function fixture(name: string, asName = name, lastModified = LAST_MODIFIED): File {
  return new File([readFileSync(join(FIX, name))], asName, { type: "image/jpeg", lastModified });
}

describe("readPhotoMeta with EXIF fixtures", () => {
  it("reads date with offset, GPS, camera and orientation", async () => {
    const meta = await readPhotoMeta(fixture("exif-gps.jpg"), NOW);
    expect(meta).toEqual({
      takenAt: "2026-10-12T14:22:31.000Z", // 18:22:31 +04:00
      takenAtLocal: "2026-10-12T18:22:31",
      dateSource: "exif",
      lat: 24.47,
      lng: 54.33,
      camera: "FakeCam Test 1",
      orientation: 6,
    });
  });

  it("treats an EXIF date without offset as local time and (0,0) GPS as missing", async () => {
    const meta = await readPhotoMeta(fixture("exif-no-offset-zero-gps.jpg"), NOW);
    expect(meta.dateSource).toBe("exif");
    expect(meta.takenAtLocal).toBe("2025-01-05T09:30:00");
    expect(meta.takenAt).toBe("2025-01-05T05:30:00.000Z"); // Asia/Dubai runtime
    expect(meta.lat).toBeNull();
    expect(meta.lng).toBeNull();
    expect(meta.camera).toBe("FakeCam Other");
    expect(meta.orientation).toBe(1);
  });

  it("no EXIF + plain name → lastModified", async () => {
    const meta = await readPhotoMeta(fixture("no-exif.jpg", "holiday.jpg"), NOW);
    expect(meta).toEqual({
      takenAt: new Date(LAST_MODIFIED).toISOString(),
      takenAtLocal: "2026-10-20T12:15:00",
      dateSource: "file",
      lat: null,
      lng: null,
      camera: null,
      orientation: null,
    });
  });

  it("no EXIF + dated filename → filename date", async () => {
    const meta = await readPhotoMeta(fixture("no-exif.jpg", "PHOTO-2026-10-12-18-22-31.jpg"), NOW);
    expect(meta.dateSource).toBe("file");
    expect(meta.takenAtLocal).toBe("2026-10-12T18:22:31");
    expect(meta.takenAt).toBe("2026-10-12T14:22:31.000Z");
  });

  it("WhatsApp date-only name: noon, unless lastModified is the same day (keeps its time)", async () => {
    const other = await readPhotoMeta(fixture("no-exif.jpg", "IMG-20261012-WA0003.jpg"), NOW);
    expect(other.takenAtLocal).toBe("2026-10-12T12:00:00");
    const sameDayMs = Date.UTC(2026, 9, 12, 16, 5, 9); // 20:05:09 Dubai
    const same = await readPhotoMeta(fixture("no-exif.jpg", "IMG-20261012-WA0003.jpg", sameDayMs), NOW);
    expect(same.takenAt).toBe(new Date(sameDayMs).toISOString());
    expect(same.takenAtLocal).toBe("2026-10-12T20:05:09");
    expect(same.dateSource).toBe("file");
  });

  it("does not throw on non-image or empty input", async () => {
    const junk = new File([new TextEncoder().encode("not an image at all")], "x.jpg", { lastModified: LAST_MODIFIED });
    expect((await readPhotoMeta(junk, NOW)).dateSource).toBe("file");
    const empty = new File([], "Screenshot_20261012-182231.png", { lastModified: LAST_MODIFIED });
    expect((await readPhotoMeta(empty, NOW)).takenAtLocal).toBe("2026-10-12T18:22:31");
  });
});

describe("parseDateFromFilename", () => {
  const local = (d: Date | null) =>
    d &&
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

  it.each([
    ["IMG-20261012-WA0003.jpg", "2026-10-12 12:00:00"],
    ["PHOTO-2026-10-12-18-22-31.jpg", "2026-10-12 18:22:31"],
    ["20261012_182231.jpg", "2026-10-12 18:22:31"],
    ["IMG_20261012_182231.jpg", "2026-10-12 18:22:31"],
    ["PXL_20261012_182231123.jpg", "2026-10-12 18:22:31"],
    ["Screenshot 2026-10-12 at 18.22.31.png", "2026-10-12 18:22:31"],
    ["Screenshot 2026-10-12 at 6.22.31\u202fPM.png", "2026-10-12 18:22:31"],
    ["Screenshot 2026-10-12 at 12.05.00 AM.png", "2026-10-12 00:05:00"],
    ["Screenshot_20261012-182231.png", "2026-10-12 18:22:31"],
    ["folder/sub/IMG_20200229_000000.jpg", "2020-02-29 00:00:00"],
  ])("%s → %s", (name, want) => {
    expect(local(parseDateFromFilename(name, NOW))).toBe(want);
  });

  it.each([
    "IMG_20261312_182231.jpg", // month 13
    "IMG_20250230_120000.jpg", // Feb 30
    "IMG_20261012_252231.jpg", // hour 25: invalid time rejects the whole match
    "IMG-19891231-WA0001.jpg", // before 1990
    "IMG-20261110-WA0001.jpg", // 2 days in the future
    "DSC_1234.jpg",
    "holiday.jpg",
    "202610121.jpg", // date glued to more digits
    "",
  ])("rejects %s", (name) => {
    expect(parseDateFromFilename(name, NOW)).toBeNull();
  });

  it("allows up to one day in the future (timezone slack)", () => {
    expect(parseDateFromFilename("IMG-20261109-WA0001.jpg", NOW)).not.toBeNull();
  });
});

describe("field helpers", () => {
  it("parseExifDate handles offsets, sub-seconds and bad values", () => {
    expect(parseExifDate("2026:10:12 18:22:31", "-05:30", NOW)?.date.toISOString()).toBe("2026-10-12T23:52:31.000Z");
    expect(parseExifDate("2026:10:12 18:22:31.123", "Z", NOW)?.date.toISOString()).toBe("2026-10-12T18:22:31.000Z");
    expect(parseExifDate("0000:00:00 00:00:00", null, NOW)).toBeNull();
    expect(parseExifDate("1985:01:01 00:00:00", null, NOW)).toBeNull();
    expect(parseExifDate("2030:01:01 00:00:00", null, NOW)).toBeNull();
    expect(parseExifDate(undefined, null, NOW)).toBeNull();
    expect(parseExifDate("    ", null, NOW)).toBeNull();
  });

  it("parseOffsetMinutes", () => {
    expect(parseOffsetMinutes("+04:00")).toBe(240);
    expect(parseOffsetMinutes("-0530")).toBe(-330);
    expect(parseOffsetMinutes("Z")).toBe(0);
    expect(parseOffsetMinutes("+25:00")).toBeNull();
    expect(parseOffsetMinutes("4")).toBeNull();
    expect(parseOffsetMinutes(null)).toBeNull();
  });

  it("normalizeGps validates ranges and drops null island", () => {
    expect(normalizeGps(24.47, 54.33)).toEqual({ lat: 24.47, lng: 54.33 });
    expect(normalizeGps(0, 0)).toBeNull();
    expect(normalizeGps(91, 10)).toBeNull();
    expect(normalizeGps(10, -181)).toBeNull();
    expect(normalizeGps(Number.NaN, 1)).toBeNull();
    expect(normalizeGps(undefined, 1)).toBeNull();
    expect(normalizeGps(0, 54.33)).toEqual({ lat: 0, lng: 54.33 });
  });

  it("formatCamera", () => {
    expect(formatCamera("Apple", "iPhone 15 Pro")).toBe("Apple iPhone 15 Pro");
    expect(formatCamera("Canon", "Canon EOS R5")).toBe("Canon EOS R5");
    expect(formatCamera("  SONY\u0000 ", "")).toBe("SONY");
    expect(formatCamera(undefined, undefined)).toBeNull();
    expect(formatCamera("X".repeat(100), "Y".repeat(100))?.length).toBe(120);
  });
});

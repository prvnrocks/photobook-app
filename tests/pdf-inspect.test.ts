// scripts/pdf-inspect.mjs (M8 T9) on a PDF with known geometry: proves the box / inset / dpi maths
// and the EXIF / GPS / metadata detection the live e2e (e2e/pdf.spec.ts) relies on.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "..", "scripts", "pdf-inspect.mjs");
const MM = 72 / 25.4;

/** EXIF APP1 with a GPS IFD pointer (0x8825), inserted right after SOI. */
function withGpsExif(jpeg: Buffer): Buffer {
  const t = Buffer.alloc(64);
  t.write("II", 0, "latin1");
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8);
  t.writeUInt16LE(0x8825, 10);
  t.writeUInt16LE(4, 12);
  t.writeUInt32LE(1, 14);
  t.writeUInt32LE(26, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16BE(0xffe1, 0);
  hdr.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), hdr, payload, jpeg.subarray(2)]);
}

type Result = {
  pageCount: number;
  file: { bytes: number };
  metadata: Record<string, unknown>;
  fonts: { family: string | null; embedded: boolean; type3: boolean }[];
  imageStreams: { count: number; dct: number; withExif: number; withGpsTag: number };
  dpi: { count: number; min: number; median: number; max: number };
  pages: { mediaBox: { wMm: number; hMm: number }; trimBox: { wMm: number; hMm: number } | null; trimInsetMm: number[] | null; text: string; images: { px: number[]; dpi: number[]; dpiMin: number }[] }[];
  rendered: string[];
};

let dir = "";
let result: Result;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pdf-inspect-"));
  const clean = await sharp({ create: { width: 1200, height: 1500, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  const gps = withGpsExif(await sharp({ create: { width: 600, height: 600, channels: 3, background: "#204060" } }).jpeg().toBuffer());

  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setAuthor("Someone");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const W = 154 * MM;
  const H = 216 * MM;
  // Page 1: sheet with 3 mm bleed; 1200 px drawn 4 in wide → 300 dpi; 1500 px over 5 in → 300.
  const p1 = doc.addPage([W, H]);
  p1.setTrimBox(3 * MM, 3 * MM, 148 * MM, 210 * MM);
  p1.setBleedBox(0, 0, W, H);
  p1.drawImage(await doc.embedJpg(clean), { x: 20, y: 20, width: 4 * 72, height: 5 * 72 });
  p1.drawText("Hello inspector", { x: 30, y: 500, size: 12, font });
  // Page 2: no TrimBox; 600 px over 6 in → 100 dpi, image keeps its EXIF (pdf-lib embeds raw).
  const p2 = doc.addPage([W, H]);
  p2.drawImage(await doc.embedJpg(gps), { x: 0, y: 0, width: 6 * 72, height: 6 * 72 });
  const file = path.join(dir, "known.pdf");
  writeFileSync(file, await doc.save());

  const out = execFileSync(process.execPath, [SCRIPT, file, "--render", "1", "--out", dir, "--scale", "0.5"], { timeout: 60_000 });
  result = JSON.parse(out.toString()) as Result;
}, 90_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("scripts/pdf-inspect.mjs", () => {
  it("reports page count, boxes in mm and the trim inset", () => {
    expect(result.pageCount).toBe(2);
    const [p1, p2] = result.pages;
    expect(p1.mediaBox.wMm).toBeCloseTo(154, 2);
    expect(p1.mediaBox.hMm).toBeCloseTo(216, 2);
    expect(p1.trimBox?.wMm).toBeCloseTo(148, 2);
    expect(p1.trimBox?.hMm).toBeCloseTo(210, 2);
    for (const inset of p1.trimInsetMm ?? []) expect(inset).toBeCloseTo(3, 1);
    expect(p2.trimBox).toBeNull();
    expect(p2.trimInsetMm).toBeNull();
  });

  it("computes effective dpi from the placed image size", () => {
    const [p1, p2] = result.pages;
    expect(p1.images).toHaveLength(1);
    expect(p1.images[0].px).toEqual([1200, 1500]);
    expect(p1.images[0].dpi[0]).toBeCloseTo(300, 0);
    expect(p1.images[0].dpi[1]).toBeCloseTo(300, 0);
    expect(p2.images[0].dpiMin).toBeCloseTo(100, 0);
    expect(result.dpi).toMatchObject({ count: 2, min: 100, max: 300 });
    expect(result.dpi.median).toBeCloseTo(200, 0);
  });

  it("detects EXIF / GPS in DCT image streams", () => {
    expect(result.imageStreams).toMatchObject({ count: 2, dct: 2, withExif: 1, withGpsTag: 1 });
  });

  it("extracts text, fonts and metadata", () => {
    expect(result.pages[0].text).toContain("Hello inspector");
    expect(result.fonts.some((f) => f.family === "Helvetica")).toBe(true);
    expect(result.fonts.every((f) => !f.type3)).toBe(true);
    expect(result.metadata.author).toBe("Someone");
    expect(result.file.bytes).toBeGreaterThan(0);
  });

  it("renders a page to PNG", () => {
    expect(result.rendered).toHaveLength(1);
    expect(result.rendered[0]).toMatch(/known-p1\.png$/);
  });
});

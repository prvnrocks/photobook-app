import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BLEED_PT, mergePdfs, printBoxes, SHEET_PT, TRIM_PT } from "@/lib/pdf/finalize";
import { PdfRenderError } from "@/lib/pdf/errors";

// Chromium quantises a 154×216 mm @page to 437.04 × 612 pt (measured, Chrome 153/156).
const CHROMIUM = { w: 437.04, h: 612 };

async function chunk(pages: number, opts: { w?: number; h?: number; jpeg?: Buffer; title?: string } = {}) {
  const doc = await PDFDocument.create();
  if (opts.title) {
    doc.setTitle(opts.title);
    doc.setAuthor("Chromium Author");
    doc.setSubject("secret subject");
  }
  const img = opts.jpeg ? await doc.embedJpg(opts.jpeg) : null;
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([opts.w ?? CHROMIUM.w, opts.h ?? CHROMIUM.h]);
    p.drawText(`p${i}`, { x: 20, y: 20, size: 12 });
    if (img) p.drawImage(img, { x: 0, y: 0, width: 100, height: 100 });
  }
  return doc.save();
}

const boxArr = (page: ReturnType<PDFDocument["getPage"]>, name: string) => {
  const b = page.node.lookup(PDFName.of(name));
  return b ? b.toString() : null;
};

describe("mergePdfs", () => {
  it("constants: 154×216 mm sheet and 3 mm bleed in points", () => {
    expect(SHEET_PT.w).toBeCloseTo(436.535, 3);
    expect(SHEET_PT.h).toBeCloseTo(612.283, 3);
    expect(BLEED_PT).toBeCloseTo(8.504, 3);
  });

  it("merges chunks in order and counts pages", async () => {
    const { bytes, pageCount } = await mergePdfs([await chunk(3), await chunk(3), await chunk(1)]);
    expect(pageCount).toBe(7);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(7);
  });

  it("printBoxes: exact nominal sheet + trim anchored at the real box's top-left", () => {
    expect(TRIM_PT.w).toBeCloseTo(419.528, 3);
    expect(TRIM_PT.h).toBeCloseTo(595.276, 3);
    const b = printBoxes({ x: 0, y: 0, width: CHROMIUM.w, height: CHROMIUM.h });
    expect(b).not.toBeNull();
    // Top edge stays where Chromium put it (y = 612); the box extends 0.283 pt below the real box.
    expect(b!.sheet).toEqual({ x: 0, y: -0.283, width: SHEET_PT.w, height: SHEET_PT.h });
    expect(b!.sheet.y + b!.sheet.height).toBeCloseTo(612, 3);
    // Trim = 3 mm in from the top-left of the content box, exact 148×210 mm.
    expect(b!.trim.x).toBeCloseTo(BLEED_PT, 3);
    expect(b!.trim.y + b!.trim.height).toBeCloseTo(612 - BLEED_PT, 2);
    expect(b!.trim.width).toBe(TRIM_PT.w);
    expect(b!.trim.height).toBe(TRIM_PT.h);
    // Bottom bleed is 3 mm measured from the nominal sheet bottom.
    expect(b!.trim.y - b!.sheet.y).toBeCloseTo(BLEED_PT, 3);

    // Non-zero origin: everything shifts with the real top-left.
    const o = printBoxes({ x: 10, y: 20, width: 436.0, height: 613 })!;
    expect(o.sheet.x).toBe(10);
    expect(o.sheet.y + o.sheet.height).toBeCloseTo(633, 3);
    expect(o.trim.x).toBeCloseTo(10 + BLEED_PT, 3);

    expect(printBoxes({ x: 0, y: 0, width: 612, height: 792 })).toBeNull(); // Letter
    expect(printBoxes({ x: 0, y: 0, width: 595.28, height: 841.89 })).toBeNull(); // A4
    expect(printBoxes({ x: 0, y: 0, width: NaN, height: 612 })).toBeNull();
  });

  it("sets MediaBox = CropBox = BleedBox = sheet and TrimBox inset by the bleed on every page", async () => {
    const { bytes } = await mergePdfs([await chunk(2), await chunk(2, { w: SHEET_PT.w, h: SHEET_PT.h })]);
    const out = await PDFDocument.load(bytes);
    out.getPages().forEach((page, i) => {
      const realTop = i < 2 ? CHROMIUM.h : SHEET_PT.h;
      const media = page.getMediaBox();
      expect(media.x).toBe(0);
      expect(media.width).toBeCloseTo(436.535, 3);
      expect(media.height).toBeCloseTo(612.283, 3);
      expect(media.y + media.height).toBeCloseTo(realTop, 3);
      expect(page.getBleedBox()).toEqual(media);
      expect(page.getCropBox()).toEqual(media);
      const trim = page.getTrimBox();
      expect(trim.x).toBeCloseTo(8.504, 3);
      expect(trim.y + trim.height).toBeCloseTo(realTop - 8.504, 2);
      expect(trim.y - media.y).toBeCloseTo(8.504, 3);
      expect(trim.width * (25.4 / 72)).toBeCloseTo(148, 2);
      expect(trim.height * (25.4 / 72)).toBeCloseTo(210, 2);
      expect(boxArr(page, "TrimBox")).not.toBeNull();
      expect(boxArr(page, "BleedBox")).not.toBeNull();
    });
  });

  it("writes title/producer/creator/dates only — no author, subject, keywords or chunk metadata", async () => {
    const now = new Date("2026-11-10T08:00:00Z");
    const { bytes } = await mergePdfs([await chunk(1, { title: "Chunk <title>" })], { title: "  رحلة دبي  ", now });
    const out = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(out.getTitle()).toBe("رحلة دبي");
    expect(out.getProducer()).toBe("Photobook");
    expect(out.getCreator()).toBe("Photobook");
    expect(out.getCreationDate()?.toISOString()).toBe(now.toISOString());
    expect(out.getModificationDate()?.toISOString()).toBe(now.toISOString());
    expect(out.getAuthor()).toBeUndefined();
    expect(out.getSubject()).toBeUndefined();
    expect(out.getKeywords()).toBeUndefined();
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).not.toContain("Chromium Author");
    expect(raw).not.toContain("pdf-lib");
  });

  it("falls back to the app name for an empty/missing title and clips long ones", async () => {
    const a = await PDFDocument.load((await mergePdfs([await chunk(1)])).bytes, { updateMetadata: false });
    expect(a.getTitle()).toBe("Photobook");
    const b = await PDFDocument.load((await mergePdfs([await chunk(1)], { title: "   " })).bytes, { updateMetadata: false });
    expect(b.getTitle()).toBe("Photobook");
    const c = await PDFDocument.load((await mergePdfs([await chunk(1)], { title: "x".repeat(500) })).bytes, {
      updateMetadata: false,
    });
    expect([...(c.getTitle() ?? "")].length).toBeLessThanOrEqual(200);
  });

  it("copies image streams byte-for-byte (no re-encode)", async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c33" } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const { bytes } = await mergePdfs([await chunk(2, { jpeg }), await chunk(1, { jpeg })]);
    const out = await PDFDocument.load(bytes);
    const images = out.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    expect(images.length).toBe(1); // shared within a chunk, deduped across chunks (M10b A14)
    for (const img of images) {
      expect(img.dict.get(PDFName.of("Filter"))).toBe(PDFName.of("DCTDecode"));
      expect(Buffer.from(img.contents).equals(jpeg)).toBe(true);
    }
  });

  it("rejects wrong page sizes (e.g. Letter when @page is missing), garbage and empty input", async () => {
    await expect(mergePdfs([await chunk(1, { w: 612, h: 792 })])).rejects.toMatchObject({ code: "merge_failed" });
    await expect(mergePdfs([new Uint8Array([1, 2, 3])])).rejects.toBeInstanceOf(PdfRenderError);
    await expect(mergePdfs([])).rejects.toMatchObject({ code: "merge_failed" });
    const empty = await (await PDFDocument.create()).save();
    await expect(mergePdfs([empty])).rejects.toMatchObject({ code: "merge_failed" });
  });
});

// M12 T7: the orphan sweep after image dedupe walks references without a depth limit.
import { PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFRef } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { dedupeImages } from "@/lib/pdf/finalize";

/** Two pages, each with a byte-identical image whose ColorSpace is [/ICCBased <own ICC copy>]. */
async function twoIdenticalImages(): Promise<{ d: PDFDocument; iccs: PDFRef[] }> {
  const d = await PDFDocument.create();
  const pixels = new Uint8Array(4 * 4 * 3).fill(200);
  const iccs: PDFRef[] = [];
  for (let i = 0; i < 2; i++) {
    const icc = d.context.register(d.context.stream(new TextEncoder().encode("ICC-PROFILE-AAAA"), { N: 3 }));
    iccs.push(icc);
    const img = d.context.register(
      d.context.stream(pixels, {
        Type: "XObject",
        Subtype: "Image",
        Width: 4,
        Height: 4,
        BitsPerComponent: 8,
        ColorSpace: d.context.obj([PDFName.of("ICCBased"), icc]),
      }),
    );
    d.addPage([437.04, 612]).node.setXObject(PDFName.of("Im0"), img);
  }
  return { d, iccs };
}

/** Catalog /Deep → indirect dict → /Next → … (`length` dicts); the last one holds /Keep `target`. */
function chainFromCatalog(d: PDFDocument, length: number, target: PDFRef): void {
  let next: PDFRef = d.context.register(d.context.obj({ Keep: target }));
  for (let i = 1; i < length; i++) next = d.context.register(d.context.obj({ Next: next }));
  d.catalog.set(PDFName.of("Deep"), next);
}

const iccCount = (d: PDFDocument) =>
  d.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("N")) !== undefined)
    .length;

describe("dedupeImages reachability walk (no depth limit)", () => {
  it("control: without the chain the duplicate's ICC is an orphan and is deleted", async () => {
    const { d } = await twoIdenticalImages();
    expect(dedupeImages(d.context)).toBe(2); // 1 duplicate image + 1 orphaned ICC
    expect(iccCount(d)).toBe(1);
  });

  it("an orphan candidate reachable only through a 200-deep /Next chain is kept", async () => {
    const { d, iccs } = await twoIdenticalImages();
    chainFromCatalog(d, 200, iccs[1]);
    expect(dedupeImages(d.context)).toBe(1); // only the duplicate image goes
    expect(iccCount(d)).toBe(2);
    expect(d.context.lookup(iccs[1])).toBeInstanceOf(PDFRawStream);
    expect(await d.save()).toBeInstanceOf(Uint8Array);
  });

  it("a very deep chain (50 000) neither overflows the stack nor loses the candidate", async () => {
    const { d, iccs } = await twoIdenticalImages();
    chainFromCatalog(d, 50_000, iccs[1]);
    expect(dedupeImages(d.context)).toBe(1);
    expect(d.context.lookup(iccs[1])).toBeInstanceOf(PDFRawStream);
  });

  it("reference cycles terminate", async () => {
    const { d, iccs } = await twoIdenticalImages();
    const a = d.context.register(d.context.obj({ Keep: iccs[1] }));
    const b = d.context.register(d.context.obj({ Next: a }));
    d.context.lookup(a, PDFDict).set(PDFName.of("Next"), b);
    d.catalog.set(PDFName.of("Loop"), b);
    expect(dedupeImages(d.context)).toBe(1);
    expect(iccCount(d)).toBe(2);
  });
});

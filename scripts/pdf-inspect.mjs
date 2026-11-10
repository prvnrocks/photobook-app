#!/usr/bin/env node
// PDF inspector (M8 T9): structural + content checks for an exported book PDF.
//
//   node scripts/pdf-inspect.mjs <file.pdf> [--render <n[,n…]>] [--out <dir>] [--scale <s>] [--no-text]
//
// Prints one JSON object on stdout:
//   file { bytes }, pageCount, metadata (Info dict + XMP present?),
//   pages[]: { n, mediaBox/trimBox/bleedBox (pt + mm, raw entries; null if absent), text, images[] }
//   images[]: { name, px: [w, h], placedPt: [w, h], dpi: [x, y], dpiMin } (from the pdfjs operator
//            list: paintImageXObject under the current transform, incl. Form XObjects)
//   fonts[]: { baseFont, subtype, subset, embedded, type3 } (unique, all pages + nested forms)
//   imageStreams: { count, dct, withExif, withXmp, withGpsTag } (raw XObject bytes scanned for
//            APP1 "Exif\0\0" / XMP markers)
//   dpi: { min, median, max, count }, rendered: [png paths]
// --render uses pdfjs + @napi-rs/canvas (optional dependency of pdfjs-dist). Page numbers are
// 1-based (1 = cover). PNGs go to --out (default: next to the PDF).
// Never prints text other than what is IN the PDF given (test fixtures); no secrets involved.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "pdf-lib";

const PT_PER_MM = 72 / 25.4;

function parseArgs(argv) {
  const out = { file: "", render: [], outDir: "", scale: 2, text: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--render") out.render = String(argv[++i] ?? "").split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);
    else if (a === "--out") out.outDir = String(argv[++i] ?? "");
    else if (a === "--scale") out.scale = Number(argv[++i] ?? 2) || 2;
    else if (a === "--no-text") out.text = false;
    else if (!out.file) out.file = a;
  }
  return out;
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function box(doc, raw) {
  if (!raw) return null;
  const arr = raw instanceof PDFArray ? raw : doc.context.lookup(raw);
  if (!(arr instanceof PDFArray)) return null;
  const v = arr.asArray().map((x) => {
    const o = doc.context.lookup(x);
    return typeof o?.asNumber === "function" ? o.asNumber() : NaN;
  });
  const [x1, y1, x2, y2] = v;
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return { pt: v.map((n) => round(n)), wPt: round(w), hPt: round(h), wMm: round(w / PT_PER_MM), hMm: round(h / PT_PER_MM) };
}

/** Inherited page attribute (MediaBox may live on the Pages node). */
function inherited(node, key) {
  let n = node;
  const name = PDFName.of(key);
  for (let i = 0; n && i < 32; i++) {
    const v = n.get(name);
    if (v) return v;
    const parent = n.get(PDFName.of("Parent"));
    n = parent ? n.context.lookup(parent) : null;
  }
  return null;
}

function nameOf(o) {
  return o && typeof o.asString === "function" ? o.asString().replace(/^\//, "") : o ? String(o).replace(/^\//, "") : null;
}

function fontInfo(doc, fontDict) {
  const L = (x) => (x ? doc.context.lookup(x) : null);
  const subtype = nameOf(fontDict.get(PDFName.of("Subtype")));
  const baseFont = nameOf(fontDict.get(PDFName.of("BaseFont")));
  let descriptor = L(fontDict.get(PDFName.of("FontDescriptor")));
  if (subtype === "Type0") {
    const desc = L(fontDict.get(PDFName.of("DescendantFonts")));
    const first = desc instanceof PDFArray ? L(desc.get(0)) : null;
    if (first instanceof PDFDict) descriptor = L(first.get(PDFName.of("FontDescriptor")));
  }
  const embedded =
    descriptor instanceof PDFDict &&
    ["FontFile", "FontFile2", "FontFile3"].some((k) => descriptor.get(PDFName.of(k)) !== undefined);
  // Type3 has no BaseFont; Skia still writes a FontDescriptor with the real FontName.
  const fontName = descriptor instanceof PDFDict ? nameOf(descriptor.get(PDFName.of("FontName"))) : null;
  const name = baseFont ?? fontName;
  // Type3 glyph programs: vector (paths only) or bitmap (inline images / XObjects)?
  let type3Glyphs = null;
  let type3Bitmap = false;
  if (subtype === "Type3") {
    const procs = L(fontDict.get(PDFName.of("CharProcs")));
    if (procs instanceof PDFDict) {
      type3Glyphs = procs.keys().length;
      for (const [, ref] of procs.entries()) {
        const s = L(ref);
        if (!(s instanceof PDFRawStream)) continue;
        let ops = "";
        try {
          ops = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
        } catch {
          continue;
        }
        if (/(^|\s)(BI|Do)(\s|$)/.test(ops)) type3Bitmap = true;
      }
    }
  }
  return {
    baseFont: name,
    family: name ? name.replace(/^[A-Z]{6}\+/, "") : null,
    subtype,
    subset: !!name && /^[A-Z]{6}\+/.test(name),
    embedded: subtype === "Type3" ? true : embedded,
    type3: subtype === "Type3",
    type3Glyphs,
    type3Bitmap,
  };
}

function scanJpeg(bytes) {
  // APP1 segments only appear in the header area, but scan the first 64 KB to be safe.
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const exif = head.indexOf(Buffer.from([0xff, 0xe1])) >= 0 && head.indexOf(Buffer.from("Exif\0\0", "latin1")) >= 0;
  const xmp = head.indexOf(Buffer.from("http://ns.adobe.com/xap/1.0/", "latin1")) >= 0;
  // GPS IFD tag 0x8825 in either byte order inside an Exif block.
  const gps = exif && (head.indexOf(Buffer.from([0x88, 0x25])) >= 0 || head.indexOf(Buffer.from([0x25, 0x88])) >= 0);
  return { exif, xmp, gps };
}

function walkResources(doc, resources, acc, seenForms) {
  const L = (x) => (x ? doc.context.lookup(x) : null);
  const res = L(resources);
  if (!(res instanceof PDFDict)) return;
  const fonts = L(res.get(PDFName.of("Font")));
  if (fonts instanceof PDFDict) {
    for (const [, ref] of fonts.entries()) {
      const key = ref instanceof PDFRef ? ref.toString() : `inline-${acc.fonts.size}`;
      if (acc.fonts.has(key)) continue;
      const f = L(ref);
      if (f instanceof PDFDict) acc.fonts.set(key, fontInfo(doc, f));
    }
  }
  const xobjs = L(res.get(PDFName.of("XObject")));
  if (xobjs instanceof PDFDict) {
    for (const [, ref] of xobjs.entries()) {
      const key = ref instanceof PDFRef ? ref.toString() : null;
      const x = L(ref);
      if (!(x instanceof PDFStream)) continue;
      const sub = nameOf(x.dict.get(PDFName.of("Subtype")));
      if (sub === "Image") {
        if (key && acc.images.has(key)) continue;
        const filter = L(x.dict.get(PDFName.of("Filter")));
        const filters = filter instanceof PDFArray ? filter.asArray().map((f) => nameOf(L(f))) : filter ? [nameOf(filter)] : [];
        const w = L(x.dict.get(PDFName.of("Width")))?.asNumber?.() ?? 0;
        const h = L(x.dict.get(PDFName.of("Height")))?.asNumber?.() ?? 0;
        const isMask = x.dict.get(PDFName.of("ImageMask")) !== undefined;
        const raw = x instanceof PDFRawStream ? x.contents : null;
        const dct = filters.includes("DCTDecode");
        const scan = dct && raw ? scanJpeg(raw) : { exif: false, xmp: false, gps: false };
        acc.images.set(key ?? `inline-${acc.images.size}`, { w, h, filters, dct, isMask, bytes: raw?.length ?? 0, ...scan });
      } else if (sub === "Form") {
        if (key && seenForms.has(key)) continue;
        if (key) seenForms.add(key);
        walkResources(doc, x.dict.get(PDFName.of("Resources")), acc, seenForms);
      }
    }
  }
}

// ---- pdfjs part -------------------------------------------------------------

function mul(m, n) {
  // [a b c d e f] — pdf matrix multiply: m × n (apply m, then n)
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

async function pdfjsPass(bytes, opts) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = pdfjs.OPS;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0, isEvalSupported: false });
  const pdf = await task.promise;
  const pages = [];
  const rendered = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    let text = "";
    if (opts.text) {
      const tc = await page.getTextContent();
      text = tc.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
    }
    const ol = await page.getOperatorList();
    const images = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i];
      const args = ol.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(args, ctm);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        const m = Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0]) ? Array.from(args[0]) : null;
        if (m && m.length === 6) ctm = mul(m, ctm);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
        let w = 0;
        let h = 0;
        let name = "";
        if (fn === OPS.paintInlineImageXObject) {
          w = args?.[0]?.width ?? 0;
          h = args?.[0]?.height ?? 0;
          name = "inline";
        } else {
          name = String(args?.[0] ?? "");
          w = Number(args?.[1] ?? 0);
          h = Number(args?.[2] ?? 0);
        }
        // Unit square → page: placed size = lengths of the transformed axes.
        const pw = Math.hypot(ctm[0], ctm[1]);
        const ph = Math.hypot(ctm[2], ctm[3]);
        const dx = pw > 0 ? w / (pw / 72) : 0;
        const dy = ph > 0 ? h / (ph / 72) : 0;
        images.push({ name, px: [w, h], placedPt: [round(pw, 2), round(ph, 2)], placedMm: [round(pw / PT_PER_MM, 1), round(ph / PT_PER_MM, 1)], dpi: [round(dx, 1), round(dy, 1)], dpiMin: round(Math.min(dx, dy), 1) });
      }
    }
    pages.push({ n, text, images });

    if (opts.render.includes(n)) {
      const viewport = page.getViewport({ scale: opts.scale });
      const factory = pdf.canvasFactory;
      const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      const out = path.join(opts.outDir, `${path.basename(opts.file, ".pdf")}-p${n}.png`);
      writeFileSync(out, canvas.toBuffer("image/png"));
      rendered.push(out);
    }
    page.cleanup();
  }
  await task.destroy();
  return { pages, rendered };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) {
    console.error("usage: node scripts/pdf-inspect.mjs <file.pdf> [--render n[,n]] [--out dir] [--scale s] [--no-text]");
    process.exit(2);
  }
  opts.file = path.resolve(opts.file);
  opts.outDir = path.resolve(opts.outDir || path.dirname(opts.file));
  if (opts.render.length) mkdirSync(opts.outDir, { recursive: true });
  const bytes = readFileSync(opts.file);

  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const acc = { fonts: new Map(), images: new Map() };
  const seenForms = new Set();
  const structural = doc.getPages().map((p, i) => {
    walkResources(doc, inherited(p.node, "Resources"), acc, seenForms);
    const media = box(doc, inherited(p.node, "MediaBox"));
    const trim = box(doc, p.node.get(PDFName.of("TrimBox")));
    const bleed = box(doc, p.node.get(PDFName.of("BleedBox")));
    const crop = box(doc, inherited(p.node, "CropBox"));
    let trimInsetMm = null;
    if (media && trim) {
      const [mx1, my1, mx2, my2] = media.pt;
      const [tx1, ty1, tx2, ty2] = trim.pt;
      trimInsetMm = [tx1 - mx1, ty1 - my1, mx2 - tx2, my2 - ty2].map((v) => round(v / PT_PER_MM, 2));
    }
    return { n: i + 1, mediaBox: media, trimBox: trim, bleedBox: bleed, cropBox: crop, trimInsetMm };
  });

  const info = {
    title: doc.getTitle() ?? null,
    author: doc.getAuthor() ?? null,
    subject: doc.getSubject() ?? null,
    keywords: doc.getKeywords() ?? null,
    creator: doc.getCreator() ?? null,
    producer: doc.getProducer() ?? null,
    xmpMetadataStream: doc.catalog.get(PDFName.of("Metadata")) !== undefined,
  };

  const { pages: pj, rendered } = await pdfjsPass(bytes, opts);
  const pages = structural.map((s, i) => ({ ...s, text: pj[i]?.text ?? "", images: pj[i]?.images ?? [] }));

  const dpis = pages.flatMap((p) => p.images.map((im) => im.dpiMin)).filter((d) => d > 0).sort((a, b) => a - b);
  const median = dpis.length ? (dpis.length % 2 ? dpis[(dpis.length - 1) / 2] : (dpis[dpis.length / 2 - 1] + dpis[dpis.length / 2]) / 2) : null;
  const streams = [...acc.images.values()];
  const out = {
    file: { path: opts.file, bytes: bytes.length, mb: round(bytes.length / 1048576, 2) },
    pageCount: doc.getPageCount(),
    metadata: info,
    fonts: [...acc.fonts.values()],
    imageStreams: {
      count: streams.length,
      dct: streams.filter((s) => s.dct).length,
      masks: streams.filter((s) => s.isMask).length,
      withExif: streams.filter((s) => s.exif).length,
      withXmp: streams.filter((s) => s.xmp).length,
      withGpsTag: streams.filter((s) => s.gps).length,
      filters: [...new Set(streams.flatMap((s) => s.filters))],
      maxPx: streams.reduce((m, s) => Math.max(m, s.w, s.h), 0),
    },
    dpi: { count: dpis.length, min: dpis[0] ?? null, median: median === null ? null : round(median, 1), max: dpis[dpis.length - 1] ?? null },
    pages,
    rendered,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((err) => {
  console.error(`pdf-inspect failed: ${err?.message ?? err}`);
  process.exit(1);
});

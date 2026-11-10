// Deep structure dump: images (filter/px/SMask/bytes), forms (transparency groups), patterns (tiling vs shading,
// nested images), ExtGState (alpha, soft masks), and content-op stats per page.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "pdf-lib";
const file = process.argv[2];
const doc = await PDFDocument.load(readFileSync(file), { updateMetadata: false });
const L = (x) => (x ? doc.context.lookup(x) : null);
const N = (o) => (o ? String(o).replace(/^\//, "") : null);
const num = (o) => (o && typeof o.asNumber === "function" ? o.asNumber() : o ? String(o) : undefined);
const decode = (s) => { try { return Buffer.from(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()).toString("latin1"); } catch { return ""; } };
function ops(src, acc) {
  const t = src.replace(/\((?:\\.|[^\\)])*\)/g, "()").replace(/<[0-9A-Fa-f\s]*>/g, "<>");
  for (const m of t.matchAll(/(?<=\s|^)(W\*?|re|c|l|m|Do|sh|scn|SCN|cs|gs|cm|Tj|TJ|BI|f\*?|B\*?|S|n|q)(?=\s|$)/g)) acc[m[1]] = (acc[m[1]] ?? 0) + 1;
}
function walk(res, out, seen, depth, where) {
  res = L(res); if (!(res instanceof PDFDict)) return;
  const xo = L(res.get(PDFName.of("XObject")));
  if (xo instanceof PDFDict) for (const [k, ref] of xo.entries()) {
    const key = ref instanceof PDFRef ? ref.toString() : k.toString(); const x = L(ref); if (!(x instanceof PDFStream)) continue;
    const sub = N(x.dict.get(PDFName.of("Subtype")));
    if (sub === "Image") {
      if (!out.images.has(key)) {
        const f = L(x.dict.get(PDFName.of("Filter")));
        out.images.set(key, { where, w: num(L(x.dict.get(PDFName.of("Width")))), h: num(L(x.dict.get(PDFName.of("Height")))), filter: f instanceof PDFArray ? f.asArray().map(N).join("+") : N(f), cs: String(L(x.dict.get(PDFName.of("ColorSpace"))) ?? "").slice(0, 30), smask: x.dict.get(PDFName.of("SMask")) ? "yes" : "", bytes: x instanceof PDFRawStream ? x.contents.length : 0 });
      }
      const sm = L(x.dict.get(PDFName.of("SMask")));
      if (sm instanceof PDFStream) { const sk = x.dict.get(PDFName.of("SMask")).toString(); if (!out.images.has(sk)) out.images.set(sk, { where: where + " (smask of " + key + ")", w: num(L(sm.dict.get(PDFName.of("Width")))), h: num(L(sm.dict.get(PDFName.of("Height")))), filter: N(L(sm.dict.get(PDFName.of("Filter")))), cs: "mask", smask: "", bytes: sm.contents?.length ?? 0 }); }
    } else if (sub === "Form") {
      if (seen.has(key)) continue; seen.add(key);
      const g = L(x.dict.get(PDFName.of("Group")));
      out.forms.push({ key, where, group: g instanceof PDFDict ? N(g.get(PDFName.of("S"))) + (g.get(PDFName.of("I")) ? " I" : "") + (g.get(PDFName.of("K")) ? " K" : "") : "", bbox: String(x.dict.get(PDFName.of("BBox")) ?? "") });
      ops(decode(x), out.ops);
      walk(x.dict.get(PDFName.of("Resources")), out, seen, depth + 1, where + ">" + key);
    }
  }
  const pat = L(res.get(PDFName.of("Pattern")));
  if (pat instanceof PDFDict) for (const [, ref] of pat.entries()) {
    const key = ref.toString(); if (seen.has(key)) continue; seen.add(key);
    const p = L(ref); const d = p instanceof PDFStream ? p.dict : p;
    const pt = num(L(d.get(PDFName.of("PatternType"))));
    out.patterns.push({ key, type: pt === 1 ? "tiling" : "shading", bbox: String(d.get(PDFName.of("BBox")) ?? ""), step: [num(L(d.get(PDFName.of("XStep")))), num(L(d.get(PDFName.of("YStep"))))].join("x"), matrix: String(d.get(PDFName.of("Matrix")) ?? "") });
    if (p instanceof PDFStream) { ops(decode(p), out.ops); walk(d.get(PDFName.of("Resources")), out, seen, depth + 1, where + ">pattern " + key); }
  }
  const gs = L(res.get(PDFName.of("ExtGState")));
  if (gs instanceof PDFDict) for (const [, ref] of gs.entries()) {
    const key = ref.toString(); if (seen.has(key)) continue; seen.add(key);
    const g = L(ref); if (!(g instanceof PDFDict)) continue;
    const e = { key, ca: num(L(g.get(PDFName.of("ca")))), CA: num(L(g.get(PDFName.of("CA")))), BM: N(g.get(PDFName.of("BM"))), smask: "" };
    const sm = L(g.get(PDFName.of("SMask")));
    if (sm instanceof PDFDict) { e.smask = N(sm.get(PDFName.of("S"))); const G = sm.get(PDFName.of("G")); if (G) { const gx = L(G); if (gx instanceof PDFStream && !seen.has(G.toString())) { seen.add(G.toString()); ops(decode(gx), out.ops); walk(gx.dict.get(PDFName.of("Resources")), out, seen, depth + 1, where + ">smaskG"); } } }
    out.gstates.push(e);
  }
  const sh = L(res.get(PDFName.of("Shading")));
  if (sh instanceof PDFDict) out.shadings += sh.entries().length;
}
const pages = doc.getPages(); const global = new Map();
for (let i = 0; i < pages.length; i++) {
  const pg = pages[i].node; const out = { images: new Map(), forms: [], patterns: [], gstates: [], shadings: 0, ops: {} };
  const c = L(pg.get(PDFName.of("Contents")));
  const streams = c instanceof PDFArray ? c.asArray().map(L) : [c];
  for (const s of streams) if (s) ops(decode(s), out.ops);
  walk(pg.get(PDFName.of("Resources")), out, new Set(), 0, "page");
  for (const [k, v] of out.images) global.set(k, v);
  const nonDefault = out.gstates.filter((g) => g.smask || (g.ca !== undefined && g.ca !== 1) || (g.CA !== undefined && g.CA !== 1) || (g.BM && g.BM !== "Normal"));
  console.log(JSON.stringify({ page: i + 1, images: [...out.images].map(([k, v]) => ({ k, ...v })), forms: out.forms.length, tgroups: out.forms.filter((f) => f.group).length, patterns: out.patterns, gstates: nonDefault, shadings: out.shadings, ops: out.ops }));
}
console.log(JSON.stringify({ file, bytes: readFileSync(file).length, uniqueImages: global.size, imageBytes: [...global.values()].reduce((a, b) => a + b.bytes, 0) }));

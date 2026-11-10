// Real headless Chromium render (M8 T6). Skipped unless PDF_CHROME_PATH points at a Chrome binary:
//   PDF_CHROME_PATH="$(node -e "console.log(require('playwright').chromium.executablePath())")" \
//     npx vitest run tests/pdf-render-live.test.ts
// A tiny local HTTP server stands in for the print route (T5's contract: token-checked
// /print/{bookId}, images from PRINT_ASSET_ORIGIN, window.__PRINT_READY__ / __PRINT_ERROR__ /
// __PRINT_TIMEOUT__, 154×216 mm @page sheets), so this test doesn't depend on the Next app.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from "pdf-lib";
import type { Browser } from "puppeteer-core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SECRET = "t6-live-test-secret-0123456789abcdef0123456789";
process.env.BOOK_ACCESS_SECRET = SECRET;

import { closeBrowser, launchBrowser } from "@/lib/pdf/browser";
import { BLEED_PT, mergePdfs, TRIM_PT } from "@/lib/pdf/finalize";
import type { PrintImageLoader } from "@/lib/pdf/images";
import { verifyPrintToken } from "@/lib/pdf/print-token";
import { renderBook, renderChunk } from "@/lib/pdf/render-pdf";
import { PRINT_ASSET_ORIGIN } from "@/lib/pdf/request-routing";

const CHROME = process.env.PDF_CHROME_PATH?.trim();
const BOOK = "6a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const EXPORT = "7b2d3c4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
const photoId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
}

function sheetHtml(from: number, to: number, opts: { tracker: string }): string {
  const sheets: string[] = [];
  for (let i = from; i <= to; i++) {
    sheets.push(
      `<section class="sheet"><img src="${PRINT_ASSET_ORIGIN}/${photoId(i)}.jpg" alt=""><p dir="auto">Sheet ${i} — رحلة</p></section>`,
    );
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Secret book title</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo">
<style>
@page { size: 154mm 216mm; margin: 0 }
html, body { margin: 0; padding: 0 }
.sheet { width: 154mm; height: 216mm; position: relative; overflow: hidden; break-after: page; background: #f4efe6 }
.sheet:last-child { break-after: auto }
.sheet img { position: absolute; left: 0; top: 0; width: 100%; height: 70%; object-fit: cover }
.sheet p { position: absolute; left: 12mm; bottom: 20mm; margin: 0; font: 18px sans-serif }
</style></head><body>
${sheets.join("\n")}
<img src="${opts.tracker}/pixel.gif" alt="" style="display:none">
<script>
(async () => {
  const imgs = [...document.querySelectorAll(".sheet img")];
  try {
    await Promise.all(imgs.map((i) => i.decode()));
    await document.fonts.ready;
    window.__PRINT_READY__ = true;
  } catch {
    window.__PRINT_ERROR__ = "image";
  }
})();
</script></body></html>`;
}


/**
 * Device-space rect of the first `re` filled after `r g b rg` on a page — a minimal content-stream
 * interpreter (q/Q/cm/rg/re only), enough for Chromium's Skia output.
 */
function findFilledRect(doc: PDFDocument, page: PDFPage, rgb: string): { x0: number; y0: number; x1: number; y1: number } | null {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const text = streams
    .map((st) => new TextDecoder().decode(decodePDFRawStream(st as PDFRawStream).decode()))
    .join("\n");
  const tokens = text.split(/\s+/).filter(Boolean);
  type M = [number, number, number, number, number, number];
  const mul = (m: M, n: M): M => [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let fill = "";
  const args: string[] = [];
  for (const t of tokens) {
    if (/^-?[\d.]+$/.test(t)) {
      args.push(t);
      continue;
    }
    const n = args.map(Number);
    if (t === "q") stack.push(ctm);
    else if (t === "Q") ctm = stack.pop() ?? ctm;
    else if (t === "cm") ctm = mul(n.slice(-6) as M, ctm);
    else if (t === "rg") fill = n.slice(-3).join(" ");
    else if (t === "re" && fill === rgb) {
      const [x, y, w, h] = n.slice(-4);
      const pt = (px: number, py: number) => [ctm[0] * px + ctm[2] * py + ctm[4], ctm[1] * px + ctm[3] * py + ctm[5]];
      const [ax, ay] = pt(x, y);
      const [bx, by] = pt(x + w, y + h);
      return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    }
    args.length = 0;
  }
  return null;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

describe.skipIf(!CHROME)("PDF render with real Chromium", () => {
  const hits: Hit[] = [];
  const trackerHits: string[] = [];
  let app: Server;
  let tracker: Server;
  let origin = "";
  let trackerOrigin = "";
  let browser: Browser;
  const photos = new Map<string, Buffer>();

  const loader: PrintImageLoader = {
    async get(id) {
      const b = photos.get(id);
      if (!b) throw new Error("unknown_photo");
      return b;
    },
  };

  beforeAll(async () => {
    for (let i = 0; i < 6; i++) {
      const hue = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400", "#16a085"][i];
      photos.set(
        photoId(i),
        await sharp({ create: { width: 1800, height: 1300, channels: 3, background: hue } })
          .composite([{ input: Buffer.from(`<svg width="1800" height="1300"><circle cx="900" cy="650" r="${200 + i * 60}" fill="#fff"/></svg>`) }])
          .jpeg({ quality: 82 })
          .toBuffer(),
      );
    }

    tracker = createServer((req, res) => {
      trackerHits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "image/gif" }).end();
    });
    trackerOrigin = await listen(tracker);

    app = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      hits.push({ path: url.pathname, headers: req.headers });
      const m = /^\/print\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (url.pathname === "/trim-marker") {
        // A box exactly on the trim line (3 mm in, 148×210 mm) and one at the sheet's top-left corner.
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><style>
@page { size: 154mm 216mm; margin: 0 } html, body { margin: 0 }
.s { width: 154mm; height: 216mm; position: relative; background: #fff }
.t { position: absolute; left: 3mm; top: 3mm; width: 148mm; height: 210mm; background: rgb(51, 102, 153) }
</style><div class="s"><div class="t"></div></div><script>window.__PRINT_READY__ = true</script>`);
        return;
      }
      if (url.pathname === "/never-ready") {
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><p>loading forever</p>");
        return;
      }
      if (url.pathname === "/flag-timeout") {
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><script>window.__PRINT_TIMEOUT__ = true</script>");
        return;
      }
      if (m) {
        const grant = verifyPrintToken(url.searchParams.get("token"), { bookId: m[1], nowSec: Date.now() / 1000 });
        if (grant && grant.exportId === EXPORT && grant.docRev === 7) {
          res
            .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
            .end(sheetHtml(grant.from, grant.to, { tracker: trackerOrigin }));
          return;
        }
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
    origin = await listen(app);
    browser = await launchBrowser();
  }, 60_000);

  afterAll(async () => {
    if (browser) await closeBrowser(browser);
    await new Promise((r) => app?.close(r));
    await new Promise((r) => tracker?.close(r));
  });

  it("renders two 3-sheet chunks and merges them into a 6-page print PDF", async () => {
    hits.length = 0;
    const t0 = performance.now();
    const chunks = await renderBook({
      origin,
      bookId: BOOK,
      exportId: EXPORT,
      docRev: 7,
      sheetCount: 6,
      chunkSheets: 3,
      loader,
      browser,
      bypassSecret: "bypass-123",
    });
    const t1 = performance.now();
    const { bytes, pageCount } = await mergePdfs(chunks, { title: "Our trip" });
    const t2 = performance.now();
    console.info(
      `[pdf-live] render 2×3 sheets ${(t1 - t0).toFixed(0)} ms, merge ${(t2 - t1).toFixed(0)} ms, ` +
        `chunks ${chunks.map((c) => `${(c.length / 1024).toFixed(0)} KB`).join(" + ")}, final ${(bytes.length / 1024).toFixed(0)} KB`,
    );

    expect(chunks).toHaveLength(2);
    expect(pageCount).toBe(6);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(6);
    for (const page of doc.getPages()) {
      const media = page.getMediaBox();
      expect(media.width).toBeCloseTo(436.5, 0);
      expect(media.height).toBeCloseTo(612.3, 0);
      const trim = page.getTrimBox();
      expect(trim.x - media.x).toBeCloseTo(8.5, 1);
      expect(trim.y - media.y).toBeCloseTo(8.5, 1);
      expect(media.y + media.height - (trim.y + trim.height)).toBeCloseTo(8.5, 1);
      expect(media.width - trim.width).toBeCloseTo(17, 0);
    }
    expect(doc.getTitle()).toBe("Our trip");
    expect(doc.getAuthor()).toBeUndefined();
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("Secret book title");

    // The six distinct photos made it in as images.
    const images = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    expect(images.length).toBeGreaterThanOrEqual(6);
    const raw = await PDFDocument.load(chunks[0], { updateMetadata: false });
    console.info(
      `[pdf-live] chunk page ${raw.getPage(0).getWidth()}×${raw.getPage(0).getHeight()} pt; images ` +
        images
          .map((o) => {
            const d = (o as PDFRawStream).dict;
            return `${d.get(PDFName.of("Filter"))} ${d.get(PDFName.of("Width"))}×${d.get(PDFName.of("Height"))} ${(o as PDFRawStream).contents.length}B`;
          })
          .join(", ") +
        `; source jpeg sizes ${[...photos.values()].map((b) => b.length).join(",")}`,
    );

    // Each chunk navigated with its own token; bypass header went to the app only; no third parties.
    const printHits = hits.filter((h) => h.path === `/print/${BOOK}`);
    expect(printHits).toHaveLength(2);
    for (const h of printHits) expect(h.headers["x-vercel-protection-bypass"]).toBe("bypass-123");
    expect(trackerHits).toEqual([]);
  }, 90_000);


  it("real Chromium chunk: TrimBox matches a CSS box drawn on the 3 mm trim line (top-left anchored)", async () => {
    const chunk = await renderChunk(browser, { url: `${origin}/trim-marker`, origin, loader, timeoutMs: 10_000 });
    const raw = await PDFDocument.load(chunk, { updateMetadata: false });
    const real = raw.getPage(0).getMediaBox();
    console.info(`[pdf-live] Chromium MediaBox ${real.width}×${real.height} pt (nominal 436.535×612.283)`);

    const { bytes } = await mergePdfs([chunk]);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPage(0);
    const media = page.getMediaBox();
    const trim = page.getTrimBox();
    // Top edge is where Chromium's real box starts (content is laid out from the top-left).
    expect(media.y + media.height).toBeCloseTo(real.y + real.height, 3);
    expect(media.x).toBeCloseTo(real.x, 3);
    expect(trim.width).toBeCloseTo(TRIM_PT.w, 2);
    expect(trim.height).toBeCloseTo(TRIM_PT.h, 2);
    expect(media.y + media.height - (trim.y + trim.height)).toBeCloseTo(BLEED_PT, 2);

    const marker = findFilledRect(doc, page, "0.2 0.4 0.6");
    expect(marker).not.toBeNull();
    // Chromium snaps boxes to whole CSS px (0.75 pt): allow ±0.75 pt per edge.
    const tol = 0.75;
    expect(Math.abs(marker!.x0 - trim.x)).toBeLessThanOrEqual(tol);
    expect(Math.abs(marker!.y1 - (trim.y + trim.height))).toBeLessThanOrEqual(tol);
    expect(Math.abs(marker!.x1 - (trim.x + trim.width))).toBeLessThanOrEqual(tol);
    expect(Math.abs(marker!.y0 - trim.y)).toBeLessThanOrEqual(tol);
    console.info(
      `[pdf-live] trim marker vs TrimBox edges (pt): left ${(marker!.x0 - trim.x).toFixed(3)}, top ${(marker!.y1 - trim.y - trim.height).toFixed(3)}, ` +
        `right ${(marker!.x1 - trim.x - trim.width).toFixed(3)}, bottom ${(marker!.y0 - trim.y).toFixed(3)}`,
    );
  }, 30_000);

  it("a failing print image → image_failed", async () => {
    const failing: PrintImageLoader = {
      async get(id) {
        if (id === photoId(1)) throw new Error("decode_failed");
        return loader.get(id);
      },
    };
    await expect(
      renderBook({ origin, bookId: BOOK, exportId: EXPORT, docRev: 7, sheetCount: 3, chunkSheets: 3, loader: failing, browser }),
    ).rejects.toMatchObject({ code: "image_failed" });
  }, 60_000);

  it("hooks: onChunkDone per chunk, timings filled; two tabs in parallel keep chunk order", async () => {
    const base = { origin, bookId: BOOK, exportId: EXPORT, docRev: 7, sheetCount: 6, chunkSheets: 2, loader, browser };
    const done: number[] = [];
    const timings = { launchMs: -1, chunkMs: [] as number[] };
    const seq = await renderBook({ ...base, onChunkDone: (k) => done.push(k), timings });
    expect(done).toEqual([0, 1, 2]);
    expect(timings.launchMs).toBe(0); // caller's browser: no launch
    expect(timings.chunkMs).toHaveLength(3);
    expect(timings.chunkMs.every((ms) => ms > 0)).toBe(true);

    const parDone: number[] = [];
    const par = await renderBook({ ...base, onChunkDone: (k) => parDone.push(k), parallelChunks: 2 });
    expect(parDone.sort()).toEqual([0, 1, 2]);
    const pages = async (chunks: Buffer[]) => Promise.all(chunks.map(async (c) => (await PDFDocument.load(c)).getPageCount()));
    expect(await pages(par)).toEqual(await pages(seq));
    expect(await pages(seq)).toEqual([2, 2, 2]);
  }, 60_000);

  it("a page that never reports ready → render_timeout; __PRINT_TIMEOUT__ → render_timeout", async () => {
    const t0 = performance.now();
    await expect(renderChunk(browser, { url: `${origin}/never-ready`, origin, loader, timeoutMs: 1_500 })).rejects.toMatchObject({
      code: "render_timeout",
    });
    expect(performance.now() - t0).toBeLessThan(10_000);
    await expect(renderChunk(browser, { url: `${origin}/flag-timeout`, origin, loader, timeoutMs: 5_000 })).rejects.toMatchObject({
      code: "render_timeout",
    });
  }, 30_000);

  it("a rejected token (404) or off-origin URL → navigation_failed", async () => {
    await expect(
      renderBook({ origin, bookId: BOOK, exportId: EXPORT, docRev: 8, sheetCount: 1, loader, browser }),
    ).rejects.toMatchObject({ code: "navigation_failed" });
    await expect(renderChunk(browser, { url: `${trackerOrigin}/x`, origin, loader, timeoutMs: 5_000 })).rejects.toMatchObject({
      code: "navigation_failed",
    });
  }, 30_000);
});

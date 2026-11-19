// Task 10 live print check: representative storybook fixtures rendered to PDF with the PRODUCTION
// renderer pieces — launchBrowser (PDF_CHROME_PATH locally), renderChunk (request interception,
// print-asset origin, __PRINT_READY__, page.pdf options), printChunkRanges, mergePdfs (print boxes,
// image dedupe, blank-page check) and splitPrintPackage — against /dev-print?story=… on a running
// `next dev` (the same <PrintDocument> markup /print/[bookId] serves, without the DB or a token).
// Print copies are synthetic JPEGs at the print plan's exact pixel sizes (planPrintImages).
// Then scripts/pdf-inspect.mjs checks: sheet count, MediaBox/BleedBox 154×216 (216×154) mm, TrimBox
// 148×210 (210×148) mm, every font embedded, no Type3, the user's edited text present.
//
// Skipped unless both are set:
//   PDF_CHROME_PATH=/path/to/chrome  PRINT_CHECK_ORIGIN=http://localhost:3217  npx vitest run tests/print-fixtures.live.test.ts
// PRINT_CHECK_OUT=<dir> keeps the PDFs (default: the OS temp dir).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Browser } from "puppeteer-core";
import type { BookFormat, DesignStyle } from "@/lib/book/types";
import { closeBrowser, launchBrowser } from "@/lib/pdf/browser";
import { mergePdfs } from "@/lib/pdf/finalize";
import { planPrintImages } from "@/lib/pdf/image-plan";
import type { PrintImageLoader } from "@/lib/pdf/images";
import { splitPrintPackage } from "@/lib/pdf/package";
import { printChunkRanges } from "@/lib/pdf/print-doc";
import { renderChunk } from "@/lib/pdf/render-pdf";
import { validatePrintReadiness } from "@/lib/print/readiness";
import { GENERIC_A5_DIGITAL } from "@/lib/print/specs";
import { DEV_EDIT_TEXT } from "@/lib/storybook/compose/dev-fixture";
import { devStoryPrintBook } from "@/lib/storybook/compose/dev-print-book";

const CHROME = process.env.PDF_CHROME_PATH?.trim();
const ORIGIN = process.env.PRINT_CHECK_ORIGIN?.trim();
const OUT = process.env.PRINT_CHECK_OUT?.trim() || path.join(tmpdir(), "print-check");
const RUN = !!CHROME && !!ORIGIN;

type Fixture = { name: string; style: DesignStyle; format: BookFormat; lang: "en" | "ar"; photos: number; lowRes?: boolean; edits?: boolean };

const FIXTURES: Fixture[] = [
  { name: "10-classic-portrait", style: "classic", format: "A5_PORTRAIT", lang: "en", photos: 10 },
  { name: "20-magazine-landscape-edits", style: "magazine", format: "A5_LANDSCAPE", lang: "en", photos: 20, edits: true },
  { name: "40-editorial-portrait-edits", style: "editorial", format: "A5_PORTRAIT", lang: "en", photos: 40, edits: true },
  { name: "60-modern-landscape-lowres", style: "modern", format: "A5_LANDSCAPE", lang: "en", photos: 60, lowRes: true },
  { name: "20-scrapbook-portrait-arabic", style: "scrapbook", format: "A5_PORTRAIT", lang: "ar", photos: 20 },
];

type Inspect = {
  pageCount: number;
  pages: { n: number; mediaBox: { wMm: number; hMm: number } | null; trimBox: { wMm: number; hMm: number } | null; bleedBox: { wMm: number; hMm: number } | null; text: string }[];
  fonts: { baseFont: string; subtype: string; embedded: boolean; type3: boolean }[];
  dpi: { min: number | null; median: number | null; max: number | null; count: number };
};

function inspect(file: string): Inspect {
  return JSON.parse(execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "pdf-inspect.mjs"), file], { maxBuffer: 256 * 1024 * 1024, timeout: 300_000 }).toString()) as Inspect;
}

const PALETTE = ["#8FB3C9", "#C9A27E", "#9FB88B", "#D6C08A", "#7F8FA6", "#C98B7E"];

/** Loader serving a synthetic JPEG at the print plan's size for each photo (no Storage). */
function syntheticLoader(plan: Map<string, { width: number; height: number }>): PrintImageLoader {
  const cache = new Map<string, Promise<Buffer>>();
  let k = 0;
  return {
    get(id: string) {
      const t = plan.get(id);
      if (!t) return Promise.reject(new Error("unknown_photo"));
      if (!cache.has(id)) {
        const bg = PALETTE[k++ % PALETTE.length]!;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#222"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${t.width / 3}" cy="${t.height / 2.5}" r="${Math.min(t.width, t.height) / 6}" fill="#fff" fill-opacity="0.8"/></svg>`;
        cache.set(id, sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer());
      }
      return cache.get(id)!;
    },
  };
}

describe.skipIf(!RUN)("live print check: storybook fixtures → PDF", () => {
  let browser: Browser;
  const report: string[] = [];
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    browser = await launchBrowser();
  }, 60_000);
  afterAll(async () => {
    if (browser) await closeBrowser(browser);
    console.log(`\n[print-check] PDFs in ${OUT}\n${report.join("\n")}`);
  });

  for (const fx of FIXTURES) {
    it(`${fx.name}: renders cover + every page, boxes, embedded fonts, no blank sheet; cover / interior split`, async () => {
      const { doc, fixturePhotos, maxPages } = devStoryPrintBook(fx.style, fx.format, fx.lang, { photos: fx.photos, lowRes: fx.lowRes, edits: fx.edits });
      const dims = fixturePhotos.map((p) => ({ id: p.id, width: p.width, height: p.height }));
      const ready = validatePrintReadiness(doc, GENERIC_A5_DIGITAL, { photos: new Map(dims.map((d) => [d.id, d])), lang: fx.lang, maxPages });
      expect(ready.errors, JSON.stringify(ready.issues)).toBe(0);

      const plan = planPrintImages(doc, dims);
      const loader = syntheticLoader(plan);
      const ranges = printChunkRanges(doc, { planned: (id) => plan.has(id) });
      const q = new URLSearchParams({ story: fx.style, ...(fx.format === "A5_LANDSCAPE" ? { format: "landscape" } : {}), ...(fx.lang === "ar" ? { ar: "1" } : {}), photos: String(fx.photos), ...(fx.lowRes ? { lowres: "1" } : {}), ...(fx.edits ? { edits: "1" } : {}), printAssets: "1" });
      const t0 = Date.now();
      const chunks: Buffer[] = [];
      for (const r of ranges) {
        chunks.push(await renderChunk(browser, { url: `${ORIGIN}/dev-print?${q.toString()}&sheets=${r.from}-${r.to}`, loader, origin: ORIGIN!, timeoutMs: 120_000 }));
      }
      const merged = await mergePdfs(chunks, { title: doc.cover.title, format: doc.format });
      const ms = Date.now() - t0;
      expect(merged.pageCount).toBe(doc.pages.length + 1);
      expect(merged.blankPages).toEqual([]);
      const file = path.join(OUT, `${fx.name}.pdf`);
      writeFileSync(file, merged.bytes);

      const split = await splitPrintPackage(merged.bytes, { title: doc.cover.title });
      writeFileSync(path.join(OUT, `${fx.name}-cover.pdf`), split.cover);
      writeFileSync(path.join(OUT, `${fx.name}-interior.pdf`), split.interior);
      expect(split.interiorPages).toBe(doc.pages.length);

      const r = inspect(file);
      expect(r.pageCount).toBe(doc.pages.length + 1);
      const [sw, sh, tw, th] = fx.format === "A5_LANDSCAPE" ? [216, 154, 210, 148] : [154, 216, 148, 210];
      for (const p of r.pages) {
        expect(Math.abs((p.mediaBox?.wMm ?? 0) - sw), `page ${p.n} media w`).toBeLessThanOrEqual(0.5);
        expect(Math.abs((p.mediaBox?.hMm ?? 0) - sh), `page ${p.n} media h`).toBeLessThanOrEqual(0.5);
        expect(Math.abs((p.bleedBox?.wMm ?? 0) - sw)).toBeLessThanOrEqual(0.5);
        expect(Math.abs((p.trimBox?.wMm ?? 0) - tw), `page ${p.n} trim w`).toBeLessThanOrEqual(0.5);
        expect(Math.abs((p.trimBox?.hMm ?? 0) - th), `page ${p.n} trim h`).toBeLessThanOrEqual(0.5);
      }
      expect(r.fonts.length).toBeGreaterThan(0);
      expect(r.fonts.filter((f) => f.type3).map((f) => f.baseFont)).toEqual([]);
      expect(r.fonts.filter((f) => !f.embedded).map((f) => f.baseFont)).toEqual([]);
      const text = r.pages.map((p) => p.text).join(" ").replace(/\s+/g, " ");
      if (fx.edits) {
        // some styles set the title in capitals (CSS text-transform), so compare case-insensitively
        expect(text.toLowerCase()).toContain(DEV_EDIT_TEXT.title.toLowerCase());
        expect(text.toLowerCase()).toContain(DEV_EDIT_TEXT.page.slice(0, 30).toLowerCase());
      }
      if (fx.lang === "ar") {
        expect(text).toMatch(/[؀-ۿﭐ-﷿ﹰ-﻿]/);
        expect(r.fonts.map((f) => f.baseFont).join(" ")).toMatch(/Cairo|Tajawal|Lalezar|Amiri/);
      }
      const families = [...new Set(r.fonts.map((f) => String(f.baseFont).replace(/^[A-Z]{6}\+/, "")))].sort();
      report.push(
        `${fx.name}: pages=${r.pageCount} (cover + ${doc.pages.length}) chunks=${ranges.length} bytes=${merged.bytes.byteLength} ms=${ms} ` +
          `dpi(min/median)=${r.dpi.min}/${r.dpi.median} fonts=${r.fonts.length} embedded=${r.fonts.every((f) => f.embedded)} type3=${r.fonts.some((f) => f.type3)} ` +
          `trim=${r.pages[0]?.trimBox?.wMm}x${r.pages[0]?.trimBox?.hMm} bleed=${r.pages[0]?.bleedBox?.wMm}x${r.pages[0]?.bleedBox?.hMm} warnings=${ready.warnings} families=${families.join(",")}`,
      );
    }, 300_000);
  }
});

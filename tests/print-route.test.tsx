import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  getExportForRender: vi.fn(),
  listPrintPhotoDims: vi.fn(),
  headers: new Map<string, string>(),
}));

class NotFoundSignal extends Error {}

vi.mock("@/lib/db/exports", () => ({ getExportForRender: h.getExportForRender }));
vi.mock("@/lib/db/print", () => ({ listPrintPhotoDims: h.listPrintPhotoDims }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => h.headers.get(k.toLowerCase()) ?? null }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
}));

import PrintPage, { dynamic, metadata } from "@/app/print/[bookId]/page";
import robots from "@/app/robots";
import { PRINT_CSS, PrintDocument } from "@/components/print/PrintDocument";
import type { BookDoc, BookPage as DocPage } from "@/lib/book/types";
import { PRINT_ASSET_ORIGIN, printAssetUrl } from "@/lib/pdf/print-assets";
import { printPhotoIds, printRenderPhotos, printSheetTargets } from "@/lib/pdf/print-doc";
import { printTokenExpiry, signPrintToken, type PrintGrant } from "@/lib/pdf/print-token";
import { PRINT_TOKEN_HEADER, readPrintToken } from "@/lib/pdf/print-token-source";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BookPage } from "@/components/book/BookPage";
import { PRINT_FONT_CLASSES, PRINT_FONT_VARS } from "@/components/print/print-fonts";
import { BOOK_FONTS, CAPTION_FONT_VARS } from "@/lib/book/fonts";
import nextConfig, { PRINT_ROUTE_HEADERS } from "../next.config";

const SECRET = "s".repeat(40);
const BOOK = "1111aaaa-2222-4333-8444-5555ffff5555";
const OTHER_BOOK = "99999999-2222-4333-8444-555555555555";
const EXPORT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function docPage(i: number): DocPage {
  return {
    id: `pg${i}`,
    chapterId: null,
    layout: "one-portrait",
    slots: [{ photoId: pid(i + 1), crop: { x: 0.5, y: 0.5, zoom: 1 } }],
    caption: { text: i % 2 ? "أجمل ليلة بدأت بضحكة" : `Day ${i}`, font: i % 2 ? "Cairo" : "Playfair", align: "center", source: "user" },
  };
}

function makeDoc(pageCount: number): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "wedding",
    cover: { layout: "cover", photoId: pid(0), title: "Sara & Omar", subtitle: "Abu Dhabi" },
    chapters: [],
    pages: Array.from({ length: pageCount }, (_, i) => docPage(i)),
    style: { background: { kind: "color", hex: "#F5EFE6" }, designStyle: "classic", font: "Playfair" },
  };
}

const NOW = () => Math.floor(Date.now() / 1000);
function token(over: Partial<PrintGrant> = {}): string {
  const t = signPrintToken(
    { exportId: EXPORT, bookId: BOOK, docRev: 7, from: 0, to: 19, exp: printTokenExpiry(NOW()), ...over },
    Buffer.from(SECRET),
  );
  if (!t) throw new Error("no token");
  return t;
}

function exportRow(over: Record<string, unknown> = {}) {
  return { id: EXPORT, bookId: BOOK, userId: pid(999), docRev: 7, doc: makeDoc(45), captionLang: "en", status: "rendering", ...over };
}

/** Tokens go in the x-print-token header like the renderer sends them (N6); arrays / `via: "query"` use ?token=. */
async function render(bookId: string, tok: unknown, via: "header" | "query" = "header"): Promise<string> {
  h.headers.clear();
  const inHeader = via === "header" && typeof tok === "string";
  if (inHeader) h.headers.set("x-print-token", tok);
  const el = await PrintPage({
    params: Promise.resolve({ bookId }),
    searchParams: Promise.resolve(tok === undefined || inHeader ? {} : { token: tok as string }),
  });
  expect(isValidElement(el)).toBe(true);
  return renderToStaticMarkup(el as ReactElement);
}

const sheetCount = (html: string) => (html.match(/data-print-sheet="true"/g) ?? []).length;
const imgSrcs = (html: string) => [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);

let oldSecret: string | undefined;
beforeAll(() => {
  oldSecret = process.env.BOOK_ACCESS_SECRET;
  process.env.BOOK_ACCESS_SECRET = SECRET;
});
afterAll(() => {
  if (oldSecret === undefined) delete process.env.BOOK_ACCESS_SECRET;
  else process.env.BOOK_ACCESS_SECRET = oldSecret;
});
beforeEach(() => {
  h.getExportForRender.mockReset().mockResolvedValue(exportRow());
  h.listPrintPhotoDims.mockReset().mockImplementation(async (_book: string, ids: string[]) =>
    ids.map((id) => ({ id, width: 3000, height: 4000 })),
  );
});

describe("/print/[bookId] token source (N6)", () => {
  it("reads the x-print-token header", async () => {
    expect(sheetCount(await render(BOOK, token()))).toBe(20);
  });

  it("?token= works only outside production; a production build ignores it", async () => {
    expect(sheetCount(await render(BOOK, token(), "query"))).toBe(20);
    h.getExportForRender.mockClear();
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(render(BOOK, token(), "query")).rejects.toBeInstanceOf(NotFoundSignal);
      expect(h.getExportForRender).not.toHaveBeenCalled();
      expect(sheetCount(await render(BOOK, token()))).toBe(20);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("readPrintToken: header first, query fallback only outside production", () => {
    expect(readPrintToken("h", "q", "production")).toBe("h");
    expect(readPrintToken(null, "q", "production")).toBeUndefined();
    expect(readPrintToken("", "q", "development")).toBe("q");
    expect(readPrintToken(null, ["a", "b"], "development")).toBeUndefined();
    expect(PRINT_TOKEN_HEADER).toBe("x-print-token");
  });
});

describe("/print/[bookId] gate", () => {
  it("is dynamic and noindex", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("renders the token's sheet range for a rendering export", async () => {
    const html = await render(BOOK, token());
    expect(sheetCount(html)).toBe(20);
    expect(h.getExportForRender).toHaveBeenCalledWith(EXPORT);
    expect(h.listPrintPhotoDims).toHaveBeenCalledWith(BOOK, expect.arrayContaining([pid(0), pid(1), pid(19)]));
    expect(h.listPrintPhotoDims.mock.calls[0][1]).toHaveLength(20);
  });

  it("renders another sheet range of a rendering export", async () => {
    expect(sheetCount(await render(BOOK, token({ from: 21, to: 40 })))).toBe(20);
  });

  it("404 (not 500) when the export read throws", async () => {
    h.getExportForRender.mockRejectedValue(new Error("db down"));
    await expect(render(BOOK, token())).rejects.toBeInstanceOf(NotFoundSignal);
    expect(h.listPrintPhotoDims).not.toHaveBeenCalled();
  });

  it("404 (not 500) when the photo dims read throws", async () => {
    h.listPrintPhotoDims.mockRejectedValue(new Error("db down"));
    await expect(render(BOOK, token())).rejects.toBeInstanceOf(NotFoundSignal);
  });

  const cases: [string, () => Promise<string>][] = [
    ["missing token", () => render(BOOK, undefined)],
    ["garbage token", () => render(BOOK, "abc.def")],
    ["array token", () => render(BOOK, ["a", "b"])],
    ["expired token", () => render(BOOK, token({ exp: NOW() - 1 }))],
    ["token for another book", () => render(OTHER_BOOK, token())],
    ["token signed with another secret", async () => {
      const t = signPrintToken(
        { exportId: EXPORT, bookId: BOOK, docRev: 7, from: 0, to: 19, exp: printTokenExpiry(NOW()) },
        Buffer.from("o".repeat(40)),
      );
      return render(BOOK, t);
    }],
  ];
  it.each(cases)("404 on %s (no DB read)", async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(h.getExportForRender).not.toHaveBeenCalled();
  });

  const rowCases: [string, unknown][] = [
    ["missing export", null],
    ["export of another book", exportRow({ bookId: OTHER_BOOK })],
    ["wrong doc_rev", exportRow({ docRev: 8 })],
    ["status queued (not claimed yet)", exportRow({ status: "queued" })],
    ["status ready", exportRow({ status: "ready" })],
    ["status failed", exportRow({ status: "failed" })],
    ["invalid doc", exportRow({ doc: { nope: true } })],
    ["range past the last sheet", exportRow({ doc: makeDoc(10) })],
  ];
  it.each(rowCases)("404 on %s", async (_name, row) => {
    h.getExportForRender.mockResolvedValue(row);
    await expect(render(BOOK, token())).rejects.toBeInstanceOf(NotFoundSignal);
    expect(h.listPrintPhotoDims).not.toHaveBeenCalled();
  });

  it("only print-asset URLs, no watermark, captions dir=auto, caption lang from the export", async () => {
    h.getExportForRender.mockResolvedValue(exportRow({ captionLang: "ar" }));
    const html = await render(BOOK, token());
    const srcs = imgSrcs(html);
    expect(srcs).toHaveLength(20);
    for (const s of srcs) expect(s.startsWith(`${PRINT_ASSET_ORIGIN}/`)).toBe(true);
    expect(srcs).toContain(printAssetUrl(pid(0)));
    expect(html).not.toMatch(/https?:\/\/(?!print-assets\.invalid\/)/);
    expect(html.toLowerCase()).not.toContain("watermark");
    const captions = html.match(/<p[^>]*data-testid="page-caption"[^>]*>/g) ?? [];
    expect(captions).toHaveLength(19);
    for (const c of captions) expect(c).toContain('dir="auto"');
    expect(html).toContain("@page");
  });

  it("photos missing from the DB render as empty slots, never a foreign URL", async () => {
    h.listPrintPhotoDims.mockResolvedValue([]);
    const html = await render(BOOK, token());
    expect(imgSrcs(html)).toEqual([]);
    expect(sheetCount(html)).toBe(20);
  });
});

describe("printSheetTargets", () => {
  it.each([
    [45, 0, 0, ["cover"]],
    [45, 0, 19, ["cover", ...Array.from({ length: 19 }, (_, i) => i)]],
    [45, 21, 40, Array.from({ length: 20 }, (_, i) => 20 + i)],
    [45, 41, 45, [40, 41, 42, 43, 44]],
    [0, 0, 0, ["cover"]],
  ] as const)("pages=%i %i..%i", (n, from, to, want) => {
    expect(printSheetTargets(n, from, to)).toEqual(want);
  });
  it.each([
    [45, 0, 46],
    [45, 5, 4],
    [45, -1, 3],
    [45, 1.5, 3],
    [-1, 0, 0],
  ])("rejects pages=%s %s..%s", (n, from, to) => {
    expect(printSheetTargets(n, from, to)).toBeNull();
  });
});

describe("print-doc helpers", () => {
  it("printRenderPhotos sets every src to the print-asset origin and keeps dims", () => {
    const m = printRenderPhotos([{ id: pid(1), width: 3000, height: 0 }]);
    expect(m[pid(1)]).toEqual({ url: `https://print-assets.invalid/${pid(1)}.jpg`, width: 3000, height: null });
  });
  it("printPhotoIds collects cover + page slots of the given sheets only", () => {
    const doc = makeDoc(5);
    expect(printPhotoIds(doc, ["cover", 0])).toEqual([pid(0), pid(1)]);
    expect(printPhotoIds(doc, [3, 4])).toEqual([pid(4), pid(5)]);
  });
});

describe("<PrintDocument>", () => {
  const doc = makeDoc(45);
  const photos = printRenderPhotos(Array.from({ length: 46 }, (_, i) => ({ id: pid(i), width: 1200, height: 1600 })));
  const html = (from: number, to: number) =>
    renderToStaticMarkup(
      <PrintDocument doc={doc} photos={photos} captionLang="en" sheets={printSheetTargets(45, from, to)!} />,
    );

  it.each([
    [0, 0, 1],
    [0, 19, 20],
    [21, 40, 20],
    [41, 45, 5],
  ])("sheets %i..%i → %i sheets", (from, to, n) => {
    const out = html(from, to);
    expect(sheetCount(out)).toBe(n);
    expect(out.includes('data-page="cover"')).toBe(from === 0);
  });

  it("cover only when from = 0; sheet i = pages[i-1]", () => {
    const a = html(0, 1);
    expect(a).toContain(`${pid(0)}.jpg`);
    expect(a).toContain('data-page="0"');
    expect(a).not.toContain('data-page="1"');
    const b = html(21, 22);
    expect(b).toContain('data-page="20"');
    expect(b).toContain('data-page="21"');
    expect(b).not.toContain(`${pid(0)}.jpg`);
  });

  it("sheets are direct children of the document, with the print CSS", () => {
    const out = html(0, 2);
    expect(out).toMatch(/<div data-print-document="" class="[^"]*">\s*<div[^>]*data-print-sheet="true"/);
    expect(out).toContain("@page { size: 154mm 216mm; margin: 0; }");
    expect(PRINT_CSS).toContain("break-after: page");
    expect(PRINT_CSS).toMatch(/:last-child \{ break-after: auto/);
    expect(out).toMatch(/width:154mm;height:216mm/);
  });
});

describe("headers + robots", () => {
  it("/print gets noindex, no-store, no-referrer", async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === "/print/:path*");
    expect(rule?.headers).toEqual(PRINT_ROUTE_HEADERS);
    const map = Object.fromEntries(PRINT_ROUTE_HEADERS.map((x) => [x.key, x.value]));
    expect(map).toEqual({ "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  });
  it("robots.txt disallows /print/ only", () => {
    const r = robots();
    expect(r.rules).toEqual([{ userAgent: "*", disallow: "/print/" }]);
    // M9 T11: robots also points at the sitemap (/, /privacy, /terms).
    expect(String(r.sitemap ?? "")).toMatch(/(^$|\/sitemap\.xml$)/);
  });
});

// WOFF2 table directory (uncompressed): known-tag index per the WOFF2 spec, 63 = explicit tag.
const WOFF2_TAGS = ("cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern " +
  "LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc " +
  "bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill").match(/.{4}\s?/g)!.map((t) => t.slice(0, 4).trim());

function woff2Tables(buf: Buffer): string[] {
  expect(buf.toString("latin1", 0, 4)).toBe("wOF2");
  const numTables = buf.readUInt16BE(12);
  let o = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[o++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error("bad UIntBase128");
  };
  const tags: string[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[o++];
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 63) {
      tag = buf.toString("latin1", o, o + 4).trim();
      o += 4;
    } else tag = WOFF2_TAGS[idx];
    tags.push(tag);
    base128();
    const xform = (flags >> 6) & 3;
    // glyf/loca: transform 0 has a transformLength; other tables: any non-zero transform has one.
    if ((tag === "glyf" || tag === "loca") ? xform === 0 : xform !== 0) base128();
  }
  return tags;
}

describe("print fonts (static instances, Type0 in the PDF)", () => {
  const FONT_DIR = path.join(__dirname, "../src/components/print/fonts");
  const files = readdirSync(FONT_DIR);
  const woff2 = files.filter((f) => f.endsWith(".woff2")).sort();
  const loader = readFileSync(path.join(__dirname, "../src/components/print/print-fonts.ts"), "utf8");
  const doc = makeDoc(3);
  const photos = printRenderPhotos(Array.from({ length: 4 }, (_, i) => ({ id: pid(i), width: 1200, height: 1600 })));

  it("re-declares every font variable the renderer uses (classic + M10b registry)", () => {
    for (const v of Object.values(CAPTION_FONT_VARS)) expect(PRINT_FONT_VARS).toContain(v);
    expect([...PRINT_FONT_VARS].sort()).toEqual(Object.values(BOOK_FONTS).map((f) => f.cssVar).sort());
    for (const v of PRINT_FONT_VARS) expect(loader).toContain(`variable: "${v}"`);
    // const names = CSS family names: unique and print-prefixed (never merge with screen faces)
    for (const f of Object.values(BOOK_FONTS)) expect(loader).toContain(`const ${f.printConst} = localFont(`);
    const classes = PRINT_FONT_CLASSES.split(" ");
    expect(classes).toHaveLength(10);
    for (const v of PRINT_FONT_VARS) expect(classes).toContain(`__variable_${v.slice(2)}`);
  });

  it("the print wrapper carries the font classes; each sheet is the plain <BookPage mode=print> markup", () => {
    const out = renderToStaticMarkup(
      <PrintDocument doc={doc} photos={photos} captionLang="ar" sheets={printSheetTargets(3, 0, 3)!} />,
    );
    expect(out).toContain(`<div data-print-document="" class="${PRINT_FONT_CLASSES}">`);
    for (const t of ["cover", 0, 1, 2] as const) {
      const page = renderToStaticMarkup(
        <BookPage doc={doc} page={t} mode="print" photos={photos} captionLang="ar" priority />,
      ).replace(/^(<link[^>]*>)+/, "");
      expect(out).toContain(page);
    }
  });

  it("viewer markup is untouched (root layout fonts, no print font classes)", () => {
    for (const t of ["cover", 1] as const) {
      const view = renderToStaticMarkup(<BookPage doc={doc} page={t} mode="view" photos={photos} captionLang="ar" />);
      expect(view).not.toContain("__variable_");
      expect(view).toMatch(/font-family:var\(--font-(playfair|cairo)\)/);
    }
  });

  it("ships exactly the weights the renderer uses (400 captions, 600 cover title; Tajawal 400/700; M10b pairs)", () => {
    expect(woff2).toEqual([
      "Amiri-400.woff2",
      "Amiri-700.woff2",
      "ArefRuqaa-400.woff2",
      "ArefRuqaa-700.woff2",
      "BebasNeue-400.woff2",
      "Cairo-400.woff2",
      "Cairo-600.woff2",
      "CormorantGaramond-400.woff2",
      "CormorantGaramond-400italic.woff2",
      "CormorantGaramond-600.woff2",
      "GreatVibes-400.woff2",
      "Inter-400.woff2",
      "Inter-600.woff2",
      "Lalezar-400.woff2",
      "PlayfairDisplay-400.woff2",
      "PlayfairDisplay-600.woff2",
      "Tajawal-400.woff2",
      "Tajawal-700.woff2",
    ]);
    for (const f of woff2) {
      const [, w, italic] = /-(\d{3})(italic)?\.woff2$/.exec(f)!;
      expect(loader).toContain(`{ path: "./fonts/${f}", weight: "${w}", style: "${italic ? "italic" : "normal"}" }`);
    }
  });

  it.each(readdirSync(path.join(__dirname, "../src/components/print/fonts")).filter((f) => f.endsWith(".woff2")))(
    "%s is a static TrueType font (glyf, no fvar/gvar/CFF) with shaping tables, under 150 KB",
    (f) => {
      const buf = readFileSync(path.join(FONT_DIR, f));
      expect(buf.length).toBeLessThan(150 * 1024);
      const tags = woff2Tables(buf);
      expect(tags).toContain("glyf");
      expect(tags).toEqual(expect.arrayContaining(["GSUB", "GPOS", "cmap", "OS/2"]));
      for (const bad of ["fvar", "gvar", "avar", "CFF", "CFF2"]) expect(tags).not.toContain(bad);
    },
  );

  it("each family ships its SIL OFL 1.1 licence", () => {
    for (const fam of ["Cairo", "Inter", "PlayfairDisplay", "Tajawal", "Amiri", "ArefRuqaa", "BebasNeue", "CormorantGaramond", "GreatVibes", "Lalezar"]) {
      expect(files).toContain(`OFL-${fam}.txt`);
      expect(readFileSync(path.join(FONT_DIR, `OFL-${fam}.txt`), "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
  });
});

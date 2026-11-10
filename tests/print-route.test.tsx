import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  getExportForRender: vi.fn(),
  listPrintPhotoDims: vi.fn(),
}));

class NotFoundSignal extends Error {}

vi.mock("@/lib/db/exports", () => ({ getExportForRender: h.getExportForRender }));
vi.mock("@/lib/db/print", () => ({ listPrintPhotoDims: h.listPrintPhotoDims }));
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
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "wedding",
    cover: { layout: "cover", photoId: pid(0), title: "Sara & Omar", subtitle: "Abu Dhabi" },
    chapters: [],
    pages: Array.from({ length: pageCount }, (_, i) => docPage(i)),
    style: { background: "#F5EFE6", font: "Playfair" },
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

async function render(bookId: string, tok: unknown): Promise<string> {
  const el = await PrintPage({
    params: Promise.resolve({ bookId }),
    searchParams: Promise.resolve(tok === undefined ? {} : { token: tok as string }),
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

  it("accepts a queued export", async () => {
    h.getExportForRender.mockResolvedValue(exportRow({ status: "queued" }));
    expect(sheetCount(await render(BOOK, token({ from: 21, to: 40 })))).toBe(20);
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
    expect(out).toMatch(/<div data-print-document="">\s*<div[^>]*data-print-sheet="true"/);
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
    expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/print/" }] });
  });
});

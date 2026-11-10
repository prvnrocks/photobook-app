import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/ai/limits";
import type { BookDoc } from "@/lib/book/types";
import {
  canExport,
  CHUNK_SHEETS,
  chunkRanges,
  EXPORT_DAILY_CAP,
  EXPORT_STALE_SECONDS,
  isLeaseStale,
  isValidSheetRange,
  MAX_SHEET_INDEX,
  pdfFilename,
  PRINT_TOKEN_TTL_SECONDS,
  reuseDecision,
  SIGNED_URL_TTL_SECONDS,
  type ExportRowLike,
} from "@/lib/pdf/rules";

const NOW = new Date("2026-11-10T12:00:00.000Z");

function doc(pages: number): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "cover", photoId: null, title: "T", subtitle: "" },
    chapters: [],
    pages: Array.from({ length: pages }, (_, i) => ({
      id: `pg${i}`,
      chapterId: null,
      layout: "full-page",
      slots: [{ photoId: `p${i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } }],
      caption: null,
    })),
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  };
}

describe("constants", () => {
  it("match D-048/D-051/D-052", () => {
    expect(EXPORT_DAILY_CAP).toBe(20);
    expect(EXPORT_STALE_SECONDS).toBe(360);
    expect(SIGNED_URL_TTL_SECONDS).toBe(600);
    expect(PRINT_TOKEN_TTL_SECONDS).toBe(300);
    expect(CHUNK_SHEETS).toBe(20);
    expect(MAX_SHEET_INDEX).toBe(LIMITS.paid.maxPages);
  });
});

describe("canExport", () => {
  const paid = LIMITS.paid.maxPages;

  it("paid + valid → ok with parsed doc and sheetCount = pages + cover", () => {
    const r = canExport({ isPaid: true, doc: doc(40), maxPages: paid });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.pages).toHaveLength(40);
      expect(r.sheetCount).toBe(41);
    }
  });

  it("free → not_paid, checked before anything else", () => {
    expect(canExport({ isPaid: false, doc: doc(3), maxPages: LIMITS.free.maxPages })).toEqual({ ok: false, reason: "not_paid" });
    expect(canExport({ isPaid: false, doc: null, maxPages: 20 })).toEqual({ ok: false, reason: "not_paid" });
    expect(canExport({ isPaid: "true" as unknown as boolean, doc: doc(3), maxPages: paid })).toEqual({ ok: false, reason: "not_paid" });
  });

  it.each([null, {}, "doc", { ...doc(1), version: 3 }, { ...doc(1), meta: { generator: "ai", extra: 1 } }])(
    "invalid doc %# → invalid_doc",
    (d) => {
      expect(canExport({ isPaid: true, doc: d, maxPages: paid })).toEqual({ ok: false, reason: "invalid_doc" });
    },
  );

  it("0 pages → empty", () => {
    expect(canExport({ isPaid: true, doc: doc(0), maxPages: paid })).toEqual({ ok: false, reason: "empty" });
  });

  it("page limit: 100 ok, maxPages respected, > 100 never ok", () => {
    expect(canExport({ isPaid: true, doc: doc(100), maxPages: paid }).ok).toBe(true);
    expect(canExport({ isPaid: true, doc: doc(21), maxPages: 20 })).toEqual({ ok: false, reason: "page_limit" });
    // > 100 pages already fails the doc schema (pages.max(LIMITS.paid.maxPages)).
    expect(canExport({ isPaid: true, doc: doc(101), maxPages: paid })).toEqual({ ok: false, reason: "invalid_doc" });
    expect(canExport({ isPaid: true, doc: doc(101), maxPages: 1000 })).toEqual({ ok: false, reason: "invalid_doc" });
    expect(canExport({ isPaid: true, doc: doc(5), maxPages: Number.NaN })).toEqual({ ok: false, reason: "page_limit" });
  });
});

describe("chunkRanges", () => {
  it.each([
    [1, [{ from: 0, to: 0 }]],
    [20, [{ from: 0, to: 19 }]],
    [21, [{ from: 0, to: 19 }, { from: 20, to: 20 }]],
    [41, [{ from: 0, to: 19 }, { from: 20, to: 39 }, { from: 40, to: 40 }]],
  ])("%i sheets", (n, expected) => {
    expect(chunkRanges(n)).toEqual(expected);
  });

  it("101 sheets (100-page paid book) → 6 chunks covering every sheet once", () => {
    const r = chunkRanges(101);
    expect(r).toHaveLength(6);
    expect(r[5]).toEqual({ from: 100, to: 100 });
    const covered = r.flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, i) => from + i));
    expect(covered).toEqual(Array.from({ length: 101 }, (_, i) => i));
    for (const { from, to } of r) expect(isValidSheetRange(from, to)).toBe(true);
  });

  it("degenerate inputs", () => {
    expect(chunkRanges(0)).toEqual([]);
    expect(chunkRanges(-3)).toEqual([]);
    expect(chunkRanges(2.5)).toEqual([]);
    expect(chunkRanges(Number.NaN)).toEqual([]);
    expect(chunkRanges(5, 2)).toEqual([{ from: 0, to: 1 }, { from: 2, to: 3 }, { from: 4, to: 4 }]);
    expect(chunkRanges(3, 0)).toEqual([{ from: 0, to: 2 }]);
  });
});

describe("isValidSheetRange", () => {
  it("bounds", () => {
    expect(isValidSheetRange(0, 0)).toBe(true);
    expect(isValidSheetRange(0, 19)).toBe(true);
    expect(isValidSheetRange(0, 20)).toBe(false);
    expect(isValidSheetRange(5, 4)).toBe(false);
    expect(isValidSheetRange(-1, 0)).toBe(false);
    expect(isValidSheetRange(100, 101)).toBe(false);
    expect(isValidSheetRange("0", 1)).toBe(false);
    expect(isValidSheetRange(0.5, 1)).toBe(false);
  });
});

describe("pdfFilename", () => {
  it.each([
    ["Summer in Abu Dhabi 2026", "summer-in-abu-dhabi-2026.pdf"],
    ["Café Crème — été", "cafe-creme-ete.pdf"],
    ["رحلتنا إلى العين", "photobook.pdf"],
    ["🎉🎂🎈", "photobook.pdf"],
    ["Eid 🎉 2026", "eid-2026.pdf"],
    ["Mixed عيد Eid", "mixed-eid.pdf"],
    ["../../etc/passwd", "etc-passwd.pdf"],
    ["a\\b/c:d*e?f\"g<h>i|j", "a-b-c-d-e-f-g-h-i-j.pdf"],
    ["evil.pdf\r\nX-Header: 1", "evil-pdf-x-header-1.pdf"],
    ["   ", "photobook.pdf"],
    ["", "photobook.pdf"],
  ])("%j → %s", (title, expected) => {
    expect(pdfFilename(title)).toBe(expected);
  });

  it("non-string titles and custom fallback", () => {
    expect(pdfFilename(null)).toBe("photobook.pdf");
    expect(pdfFilename(undefined)).toBe("photobook.pdf");
    expect(pdfFilename(42)).toBe("photobook.pdf");
    expect(pdfFilename("عيد", "My Book")).toBe("my-book.pdf");
    expect(pdfFilename("عيد", "عيد")).toBe("photobook.pdf");
  });

  it("long titles are clipped to 60 chars without a trailing dash", () => {
    const name = pdfFilename(`${"a".repeat(59)} bcdef ghij`);
    const stem = name.slice(0, -4);
    expect(stem.length).toBeLessThanOrEqual(60);
    expect(stem).toBe("a".repeat(59));
    expect(pdfFilename("x".repeat(200))).toBe(`${"x".repeat(60)}.pdf`);
  });

  it("output is always a safe ASCII slug", () => {
    for (const t of ["Ünïcödé", "日本語の本", "tab\there", "a..b", "-lead-trail-", "A".repeat(500)]) {
      expect(pdfFilename(t)).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.pdf$/);
    }
  });
});

describe("isLeaseStale", () => {
  it("future lease → live; past/equal/missing/garbage → stale", () => {
    expect(isLeaseStale(new Date(NOW.getTime() + 1000), NOW)).toBe(false);
    expect(isLeaseStale("2026-11-10 12:05:00+00", NOW)).toBe(false);
    expect(isLeaseStale(NOW, NOW)).toBe(true);
    expect(isLeaseStale(new Date(NOW.getTime() - 1), NOW)).toBe(true);
    expect(isLeaseStale(null, NOW)).toBe(true);
    expect(isLeaseStale(undefined, NOW)).toBe(true);
    expect(isLeaseStale("not a date", NOW)).toBe(true);
  });
});

describe("reuseDecision", () => {
  const iso = (deltaSec: number) => new Date(NOW.getTime() + deltaSec * 1000).toISOString();
  const row = (over: Partial<ExportRowLike>): ExportRowLike => ({
    id: "r",
    status: "queued",
    docRev: 3,
    leaseUntil: null,
    createdAt: iso(-10),
    ...over,
  });

  it("no rows → create", () => {
    expect(reuseDecision([], 3, NOW)).toEqual({ action: "create", staleIds: [] });
  });

  it("newest ready row for the same rev is reused", () => {
    const rows = [
      row({ id: "old", status: "ready", createdAt: iso(-1000) }),
      row({ id: "new", status: "ready", createdAt: iso(-100) }),
      row({ id: "otherRev", status: "ready", docRev: 2, createdAt: iso(-5) }),
    ];
    expect(reuseDecision(rows, 3, NOW)).toEqual({ action: "reuse_ready", id: "new" });
  });

  it("ready row for another rev does not count", () => {
    expect(reuseDecision([row({ status: "ready", docRev: 2 })], 3, NOW)).toEqual({ action: "create", staleIds: [] });
  });

  it("live job for the same rev → join; for another rev → busy", () => {
    expect(reuseDecision([row({ id: "a", status: "running", leaseUntil: iso(60) })], 3, NOW)).toEqual({ action: "join", id: "a" });
    expect(reuseDecision([row({ id: "b", status: "running", docRev: 2, leaseUntil: iso(60) })], 3, NOW)).toEqual({
      action: "busy",
      id: "b",
    });
  });

  it("queued without lease is live until createdAt + staleSeconds", () => {
    expect(reuseDecision([row({ id: "q", createdAt: iso(-(EXPORT_STALE_SECONDS - 1)) })], 3, NOW)).toEqual({ action: "join", id: "q" });
    expect(reuseDecision([row({ id: "q", createdAt: iso(-EXPORT_STALE_SECONDS) })], 3, NOW)).toEqual({
      action: "create",
      staleIds: ["q"],
    });
  });

  it("stale running rows are reported for reaping; failed rows are ignored", () => {
    const rows = [
      row({ id: "dead", status: "running", leaseUntil: iso(-1) }),
      row({ id: "dead2", status: "queued", docRev: 1, createdAt: iso(-10_000) }),
      row({ id: "f", status: "failed", leaseUntil: iso(100) }),
    ];
    const d = reuseDecision(rows, 3, NOW);
    expect(d.action).toBe("create");
    if (d.action === "create") expect([...d.staleIds].sort()).toEqual(["dead", "dead2"]);
  });

  it("ready same-rev wins over a live job", () => {
    const rows = [row({ id: "live", status: "running", leaseUntil: iso(60) }), row({ id: "done", status: "ready" })];
    expect(reuseDecision(rows, 3, NOW)).toEqual({ action: "reuse_ready", id: "done" });
  });
});

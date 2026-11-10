import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/ai/limits";
import type { BookDoc } from "@/lib/book/types";
import { canPublish, FREE_LINK_DAYS, isExpired, nextExpiry } from "@/lib/publish/rules";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY = 86_400_000;

function doc(pages: number): BookDoc {
  return {
    version: 1,
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
    style: { background: "#FFFFFF", font: "Playfair" },
  };
}

describe("nextExpiry", () => {
  it("first free publish → now + 30 days", () => {
    expect(FREE_LINK_DAYS).toBe(30);
    expect(nextExpiry({ isPaid: false, existingExpiresAt: null, now: NOW })).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
  });

  it("republish never extends an existing expiry (string or Date)", () => {
    const first = nextExpiry({ isPaid: false, existingExpiresAt: null, now: NOW })!;
    const later = new Date(NOW.getTime() + 20 * DAY);
    expect(nextExpiry({ isPaid: false, existingExpiresAt: first, now: later })).toBe(first);
    expect(nextExpiry({ isPaid: false, existingExpiresAt: new Date(first), now: later })).toBe(first);
    // Postgres timestamptz text form.
    expect(nextExpiry({ isPaid: false, existingExpiresAt: "2026-12-10 12:00:00+00", now: later })).toBe(
      "2026-12-10T12:00:00.000Z",
    );
    // Even when already expired.
    const past = new Date(NOW.getTime() - DAY).toISOString();
    expect(nextExpiry({ isPaid: false, existingExpiresAt: past, now: NOW })).toBe(past);
  });

  it("paid → null (permanent), whatever was stored", () => {
    expect(nextExpiry({ isPaid: true, existingExpiresAt: null, now: NOW })).toBeNull();
    expect(nextExpiry({ isPaid: true, existingExpiresAt: "2026-12-01T00:00:00Z", now: NOW })).toBeNull();
  });

  it("unparsable existing value fails closed (expired), never a fresh 30 days", () => {
    const r = nextExpiry({ isPaid: false, existingExpiresAt: "garbage", now: NOW });
    expect(r).toBe(new Date(0).toISOString());
    expect(isExpired({ isPaid: false, expiresAt: r, now: NOW })).toBe(true);
  });
});

describe("isExpired", () => {
  const exp = new Date(NOW.getTime() + DAY).toISOString();
  it.each([
    [false, null, NOW, false],
    [false, exp, NOW, false],
    [false, exp, new Date(NOW.getTime() + DAY), true],
    [false, exp, new Date(NOW.getTime() + DAY - 1), false],
    [false, "garbage", NOW, true],
    [true, exp, new Date(NOW.getTime() + 100 * DAY), false],
    [true, "garbage", NOW, false],
  ] as const)("paid=%s expiresAt=%s now=%s → %s", (isPaid, expiresAt, now, expected) => {
    expect(isExpired({ isPaid, expiresAt, now })).toBe(expected);
  });
});

describe("canPublish", () => {
  const free = LIMITS.free.maxPages;
  const base = { isPaid: false, expiresAt: null, now: NOW };

  it("ok for a valid free doc within the limit (returns the parsed doc)", () => {
    const r = canPublish({ ...base, doc: doc(20), maxPages: free });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.pages).toHaveLength(20);
  });

  it("21 pages on a free book → page_limit", () => {
    expect(canPublish({ ...base, doc: doc(21), maxPages: free })).toEqual({ ok: false, reason: "page_limit" });
  });

  it("21 pages on a paid book → ok", () => {
    expect(canPublish({ ...base, isPaid: true, doc: doc(21), maxPages: LIMITS.paid.maxPages }).ok).toBe(true);
  });

  it("empty doc → empty", () => {
    expect(canPublish({ ...base, doc: doc(0), maxPages: free })).toEqual({ ok: false, reason: "empty" });
  });

  it.each([null, {}, "doc", { ...doc(1), version: 2 }, { ...doc(1), meta: { generator: "ai", extra: 1 } }])(
    "invalid doc %# → invalid_doc",
    (d) => {
      expect(canPublish({ ...base, doc: d, maxPages: free })).toEqual({ ok: false, reason: "invalid_doc" });
    },
  );

  it("expired free book → expired (even with a valid doc)", () => {
    const expiresAt = new Date(NOW.getTime() - 1).toISOString();
    expect(canPublish({ ...base, expiresAt, doc: doc(3), maxPages: free })).toEqual({ ok: false, reason: "expired" });
  });

  it("paid book with a stale expires_at is not expired", () => {
    const expiresAt = new Date(NOW.getTime() - DAY).toISOString();
    expect(canPublish({ ...base, isPaid: true, expiresAt, doc: doc(3), maxPages: 100 }).ok).toBe(true);
  });
});

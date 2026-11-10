// M6 tester gaps: JS publish rules ↔ SQL get_published_book expiry parity, public DTO allowlist
// on realistic (autolayout + AI-captioned + dirty) docs, cookie scoping in production, OG version.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { autolayout, type AutoPhoto } from "@/lib/autolayout";
import type { BookDoc } from "@/lib/book/types";
import { accessCookieName, accessCookieOptions } from "@/lib/publish/access-cookie";
import { parsePublicDoc, publicDocToRenderDoc, toPublicDoc } from "@/lib/publish/public-doc";
import { FREE_LINK_DAYS, isExpired, nextExpiry } from "@/lib/publish/rules";
import { isValidSlug, makeSlug } from "@/lib/publish/slug";
import { ogImagePath } from "@/lib/viewer/metadata";

const SQL = readFileSync(join(__dirname, "..", "supabase", "migrations", "20261111001000_publish.sql"), "utf8");
const DAY = 86_400_000;
const NOW = new Date("2026-11-10T12:00:00.000Z");

/** Port of the SQL expression `not is_paid and expires_at is not null and expires_at <= now()`. */
function sqlIsExpired(isPaid: boolean, expiresAt: Date | null, now: Date): boolean {
  return !isPaid && expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

describe("expiry parity: rules.ts ↔ get_published_book", () => {
  it("the migration uses exactly the expression the JS port mirrors (is_expired and the doc gate)", () => {
    const expr = "(not b.is_paid and b.expires_at is not null and b.expires_at <= now())";
    const count = SQL.split(expr).length - 1;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("isExpired agrees with the SQL expression on the boundary grid", () => {
    const offsets = [-31 * DAY, -1, 0, 1, DAY, 30 * DAY, 30 * DAY + 1];
    for (const isPaid of [false, true]) {
      expect(isExpired({ isPaid, expiresAt: null, now: NOW })).toBe(sqlIsExpired(isPaid, null, NOW));
      for (const off of offsets) {
        const exp = new Date(NOW.getTime() + off);
        expect(isExpired({ isPaid, expiresAt: exp.toISOString(), now: NOW }), `${isPaid} ${off}`).toBe(
          sqlIsExpired(isPaid, exp, NOW),
        );
      }
    }
  });

  it("a freshly published free link is live for exactly 30 days, then both sides call it expired", () => {
    const exp = nextExpiry({ isPaid: false, existingExpiresAt: null, now: NOW })!;
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(isExpired({ isPaid: false, expiresAt: exp, now: at(FREE_LINK_DAYS * DAY - 1) })).toBe(false);
    expect(sqlIsExpired(false, new Date(exp), at(FREE_LINK_DAYS * DAY - 1))).toBe(false);
    expect(isExpired({ isPaid: false, expiresAt: exp, now: at(FREE_LINK_DAYS * DAY) })).toBe(true);
    expect(sqlIsExpired(false, new Date(exp), at(FREE_LINK_DAYS * DAY))).toBe(true);
  });

  it("republish 29 days later keeps the original expiry (never extended)", () => {
    const first = nextExpiry({ isPaid: false, existingExpiresAt: null, now: NOW });
    const later = new Date(NOW.getTime() + 29 * DAY);
    expect(nextExpiry({ isPaid: false, existingExpiresAt: first, now: later })).toBe(first);
  });

  it("payment after expiry makes the link live on both sides", () => {
    const past = new Date(NOW.getTime() - DAY);
    expect(isExpired({ isPaid: true, expiresAt: past, now: NOW })).toBe(false);
    expect(sqlIsExpired(true, past, NOW)).toBe(false);
  });
});

// ---- Realistic doc: autolayout album + AI captions + chapter place + stray private keys --------

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function realisticDoc(): BookDoc {
  const photos: AutoPhoto[] = Array.from({ length: 40 }, (_, i) => ({
    id: uuid(i + 1),
    width: i % 3 === 0 ? 4032 : 3024,
    height: i % 3 === 0 ? 3024 : 4032,
    takenAt: new Date(Date.UTC(2026, 2, 10 + Math.floor(i / 10), 6 + (i % 10), 0, 0)).toISOString(),
    dateSource: "exif",
    place: i < 20 ? "Al Ain" : "Liwa Oasis",
    status: i === 7 ? "dropped" : "kept",
    dupGroup: i === 3 || i === 4 ? 1 : null,
    blurScore: 100 + i,
  }));
  const doc = autolayout(photos, { occasion: "travel", title: "Our desert trip", captionLang: "en", isPaid: true, runId: uuid(999) });
  // Pretend the AI pipeline captioned every other page.
  return {
    ...doc,
    meta: { ...doc.meta!, generator: "ai", userEdited: true },
    pages: doc.pages.map((p, i) => ({
      ...p,
      caption: i % 2 === 0 ? { text: `Morning light ${i}`, font: "Playfair", align: "center", source: i % 4 === 0 ? "ai" : "user" } : null,
    })),
  } as BookDoc;
}

function dirty(doc: BookDoc): BookDoc {
  const stray = { user_id: uuid(500), original: "u/b/original/x.jpg", lat: 24.2, lng: 55.7, taken_at: "2026-03-10T06:00:00Z", ai: { description: "kids on dunes" } };
  return {
    ...doc,
    ...stray,
    meta: { ...doc.meta!, ...stray },
    cover: { ...doc.cover, ...stray },
    chapters: doc.chapters.map((c) => ({ ...c, ...stray })),
    pages: doc.pages.map((p) => ({
      ...p,
      ...stray,
      caption: p.caption ? { ...p.caption, ...stray } : null,
      slots: p.slots.map((s) => ({ ...s, ...stray, crop: { ...s.crop, ...stray } })),
    })),
    style: { ...doc.style, ...stray },
  } as unknown as BookDoc;
}

/** Path-aware key allowlist: every key in the public doc must be one of these. */
const ALLOWED: Record<string, string[]> = {
  "": ["version", "format", "cover", "chapters", "pages", "style"],
  cover: ["layout", "photoId", "title", "subtitle"],
  "chapters[]": ["id", "title", "dateLabel"],
  "pages[]": ["id", "chapterId", "layout", "slots", "caption"],
  "pages[].slots[]": ["photoId", "crop"],
  "pages[].slots[].crop": ["x", "y", "zoom"],
  "pages[].caption": ["text", "font", "align"],
  style: ["background", "font"],
};

function checkKeys(v: unknown, path: string, bad: string[]) {
  if (Array.isArray(v)) {
    for (const x of v) checkKeys(x, `${path}[]`, bad);
    return;
  }
  if (!v || typeof v !== "object") return;
  const allowed = ALLOWED[path];
  for (const [k, x] of Object.entries(v)) {
    if (!allowed || !allowed.includes(k)) bad.push(`${path}.${k}`);
    checkKeys(x, path ? `${path}.${k}` : k, bad);
  }
}

describe("public doc on a realistic album", () => {
  it("only allowlisted keys survive, even with private keys injected at every level", () => {
    const pub = toPublicDoc(dirty(realisticDoc()));
    const bad: string[] = [];
    checkKeys(pub, "", bad);
    expect(bad).toEqual([]);
    // Note: autolayout chapter titles / cover subtitle are place NAMES by design (visible + editable
    // in the editor), so "Al Ain" may appear as a title; only the `place` field itself is dropped.
    const json = JSON.stringify(pub);
    for (const s of ['"user_id"', '"original"', '"lat"', '"lng"', '"taken_at"', '"meta"', '"ai"', '"source"', '"place"', "kids on dunes", uuid(500), uuid(999)]) {
      expect(json, s).not.toContain(s);
    }
    expect(parsePublicDoc(pub).ok).toBe(true);
  });

  it("keeps the album intact (pages, chapters, captions text, crops)", () => {
    const doc = realisticDoc();
    const pub = toPublicDoc(doc);
    expect(pub.pages.length).toBe(doc.pages.length);
    expect(pub.chapters.map((c) => c.id)).toEqual(doc.chapters.map((c) => c.id));
    expect(pub.pages.map((p) => p.caption?.text ?? null)).toEqual(doc.pages.map((p) => p.caption?.text ?? null));
    const back = publicDocToRenderDoc(pub);
    expect(back.pages.map((p) => p.slots)).toEqual(doc.pages.map((p) => p.slots));
    expect(back.meta).toBeUndefined();
  });

  it("parsePublicDoc rejects a snapshot that still carries any private key", () => {
    const pub = toPublicDoc(realisticDoc());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately untyped mutation of a JSON copy
    type Loose = any;
    for (const inject of [
      (d: Loose) => (d.user_id = "x"),
      (d: Loose) => (d.cover.ai = "x"),
      (d: Loose) => (d.chapters[0].place = "Al Ain"),
      (d: Loose) => (d.pages[0].slots[0].lat = 1),
      (d: Loose) => (d.pages[0].caption = { ...d.pages[0].caption, source: "ai" }),
      (d: Loose) => (d.meta = {}),
    ]) {
      const copy = JSON.parse(JSON.stringify(pub));
      inject(copy);
      expect(parsePublicDoc(copy).ok).toBe(false);
    }
  });
});

describe("access cookie scoping", () => {
  it("production / test: Secure, httpOnly, Lax, path exactly /b/<slug> (not a prefix of another book)", () => {
    for (const env of ["production", "test", undefined]) {
      const o = accessCookieOptions("trip-AbCdEfGh12", env);
      expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/b/trip-AbCdEfGh12" });
    }
    expect(accessCookieOptions("x", "development").secure).toBe(false);
  });

  it("cookie name never contains the slug and differs per book", () => {
    const a = makeSlug("Trip");
    const b = makeSlug("Trip");
    expect(accessCookieName(a)).not.toContain(a);
    expect(accessCookieName(a)).not.toBe(accessCookieName(b));
    expect(accessCookieName(a)).toMatch(/^pb_a_[0-9a-f]{16}$/);
  });
});

describe("slug + OG version", () => {
  it("random titles (emoji, Arabic, mixed, very long) always give a valid, URL-safe slug", () => {
    for (const t of ["", "   ", "🎉🎉", "رحلتنا", "Eid 2026 — عائلتنا", "x".repeat(500), "A/B?C#D", "Ünïcødé façade"]) {
      const s = makeSlug(t);
      expect(isValidSlug(s), t).toBe(true);
      expect(encodeURIComponent(s)).toBe(s);
    }
  });

  it("OG image version changes on republish and on password toggle", () => {
    const slug = makeSlug("Trip");
    const a = ogImagePath(slug, { publishedRev: 3, hasPassword: false });
    expect(ogImagePath(slug, { publishedRev: 4, hasPassword: false })).not.toBe(a);
    expect(ogImagePath(slug, { publishedRev: 3, hasPassword: true })).not.toBe(a);
    expect(a).toBe(`/b/${slug}/og?v=3-0`);
  });
});

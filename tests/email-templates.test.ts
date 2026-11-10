// M9 T5 (D-057): reminder email templates — subjects, escaping, dir="auto" titles, links, footer,
// List-Unsubscribe headers.
import { describe, expect, it } from "vitest";
import { SUPPORT_EMAIL } from "@/lib/brand";
import { FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY } from "@/lib/cleanup/rules";
import { draftWarningEmail } from "@/lib/email/templates/draft-warning";
import { daysLeft, expiryEmail } from "@/lib/email/templates/expiry";
import { cleanTitle, escapeHtml, formatEmailDate, unsubscribeHeaders } from "@/lib/email/templates/layout";

const BOOK = "0b6f5d3e-1c2a-4b7e-9f00-123456789abc";
const APP = "https://photobook.example";
const UNSUB = `${APP}/api/email/unsubscribe?t=u1.abc.def`;
const links = { appUrl: APP, unsubscribeUrl: UNSUB };
// 2026-12-01 10:00 Dubai = 06:00Z
const EXPIRES = "2026-12-01T06:00:00.000Z";
const NOW = Date.parse("2026-11-28T06:00:00.000Z");

describe("expiry email", () => {
  const mail = expiryEmail({ bookId: BOOK, title: "Eid <b>& family</b>", expiresAt: EXPIRES, now: NOW, links });

  it("subject says 3 days", () => {
    expect(mail.subject).toBe("Your photobook link expires in 3 days");
  });

  it("subject never overstates the time left on a late run", () => {
    expect(daysLeft(EXPIRES, Date.parse("2026-11-30T12:00:00Z"))).toBe(1);
    expect(expiryEmail({ bookId: BOOK, title: null, expiresAt: EXPIRES, now: Date.parse("2026-11-30T12:00:00Z"), links }).subject).toBe(
      "Your photobook link expires tomorrow",
    );
    expect(daysLeft(EXPIRES, Date.parse("2026-11-20T00:00:00Z"))).toBe(3);
  });

  it("escapes the title and wraps it in dir=auto", () => {
    expect(mail.html).toContain('<span dir="auto" style="font-weight:600;">Eid &lt;b&gt;&amp; family&lt;/b&gt;</span>');
    expect(mail.html).not.toContain("<b>&");
  });

  it("states the expiry date and the deletion date (grace from rules) in English, Dubai time", () => {
    expect(mail.html).toContain("1 December 2026");
    expect(mail.text).toContain("1 December 2026");
    expect(mail.html).toContain(`${FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY} days later, on <strong>15 December 2026</strong>`);
    expect(mail.text).toContain("stops working");
  });

  it("links to the publish page with the AED 39 upgrade CTA", () => {
    expect(mail.html).toContain(`href="${APP}/books/${BOOK}/publish"`);
    expect(mail.html).toContain("Upgrade to keep it forever — AED 39");
    expect(mail.text).toContain(`${APP}/books/${BOOK}/publish`);
  });

  it("footer: reason, unsubscribe link, support email, brand", () => {
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain("reminder emails are on");
      expect(body).toContain(SUPPORT_EMAIL);
      expect(body).toContain("Photobook");
    }
    expect(mail.html).toContain(`href="${escapeHtml(UNSUB)}"`);
    expect(mail.text).toContain(`Unsubscribe from reminder emails: ${UNSUB}`);
  });

  it("is a mobile-friendly English document", () => {
    expect(mail.html).toMatch(/^<!doctype html>/);
    expect(mail.html).toContain('<html lang="en" dir="ltr">');
    expect(mail.html).toContain('name="viewport"');
    expect(mail.html).toContain("max-width:560px");
  });

  it("null / blank title → 'your photobook'", () => {
    for (const title of [null, "   "]) {
      const m = expiryEmail({ bookId: BOOK, title, expiresAt: EXPIRES, now: NOW, links });
      expect(m.html).toContain("for your photobook stops working");
      expect(m.html).not.toContain('dir="auto"');
    }
  });

  it("rejects an invalid date", () => {
    expect(() => expiryEmail({ bookId: BOOK, title: null, expiresAt: "nope", now: NOW, links })).toThrow(RangeError);
  });
});

describe("draft warning email", () => {
  const arabic = "عيد سعيد <script>";
  const mail = draftWarningEmail({ bookId: BOOK, title: arabic, deleteAfter: "2026-12-17T21:30:00Z", links });

  it("subject carries the deletion date (Dubai calendar day)", () => {
    // 21:30Z = 01:30 next day in Dubai
    expect(mail.subject).toBe("Your draft photobook will be deleted on 18 December 2026");
    expect(formatEmailDate("2026-12-17T21:30:00Z")).toBe("18 December 2026");
  });

  it("Arabic title escaped, dir=auto; text version isolates it", () => {
    expect(mail.html).toContain('<span dir="auto" style="font-weight:600;">عيد سعيد &lt;script&gt;</span>');
    expect(mail.html).not.toContain("<script>");
    expect(mail.text).toContain(`“\u2068${arabic}\u2069”`);
  });

  it("links to the editor with 'Open it to keep it'", () => {
    expect(mail.html).toContain(`href="${APP}/books/${BOOK}/edit"`);
    expect(mail.html).toContain("Open it to keep it");
    expect(mail.text).toContain(`Open it to keep it:\n${APP}/books/${BOOK}/edit`);
  });

  it("says opening it in the editor keeps it (server-side touch, review S3)", () => {
    expect(mail.html).toContain("Opening it in the editor keeps it for another 45 days.");
    expect(mail.text).toContain("Opening it in the editor keeps it for another 45 days.");
    expect(mail.text).not.toContain("restarts the clock");
  });

  it("footer has the unsubscribe link and support email", () => {
    expect(mail.html).toContain("Unsubscribe from reminder emails");
    expect(mail.html).toContain(`mailto:${SUPPORT_EMAIL}`);
    expect(mail.text).toContain("never published");
  });
});

describe("helpers", () => {
  it("List-Unsubscribe headers (RFC 8058 one-click)", () => {
    expect(unsubscribeHeaders(UNSUB)).toEqual({
      "List-Unsubscribe": `<${UNSUB}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("cleanTitle strips control characters and newlines, clips long titles", () => {
    expect(cleanTitle("a\nb\u0000c\u2028d")).toBe("a b c d");
    expect(cleanTitle(null)).toBeNull();
    const long = cleanTitle("x".repeat(500)) as string;
    expect(Array.from(long).length).toBeLessThanOrEqual(121);
  });
});

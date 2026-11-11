import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BookList } from "@/components/dashboard/BookList";
import { EditorShell } from "@/components/editor/EditorShell";
import { PasswordField } from "@/components/publish/PasswordField";
import { PublishPanelView, type PublishActions } from "@/components/publish/PublishPanel";
import { bookPublishChip, bookShareHref } from "@/lib/dashboard/publish-chip";
import type { BookListItem } from "@/lib/db/books";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";
import { DEV_PUBLISH_STATES, DEV_PUBLISH_URL, devPublishState, type DevPublishStateName } from "@/lib/publish/dev-fixture";
import {
  blockReasonCopy,
  CONFLICT_COPY,
  CONFLICT_RETRY_MS,
  displayUrl,
  EXPIRED_COPY,
  expiryLabel,
  hasUnpublishedChanges,
  passwordErrorCopy,
  passwordLengthError,
  publishErrorCopy,
  publishWithRetry,
  unpublishErrorCopy,
} from "@/lib/publish/ui";
import { readFileSync } from "node:fs";
import { LIMITS } from "@/lib/ai/limits";
import { UPGRADE } from "@/lib/pricing";
import { publishCompare } from "@/lib/publish/compare";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";

vi.mock("server-only", () => ({}));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

const NOW = new Date("2026-11-10T10:00:00.000Z");
const BOOK = "11111111-1111-4111-8111-111111111111";

const actions: PublishActions = {
  publish: async () => ({ ok: true, slug: "s", url: DEV_PUBLISH_URL, expiresAt: null }),
  unpublish: async () => ({ ok: true }),
  setPassword: async () => ({ ok: true, hasPassword: true }),
};

function panel(name: DevPublishStateName, paymentsEnabled = true): string {
  return renderToStaticMarkup(
    <PublishPanelView
      bookId={BOOK}
      title="Sara & Omar"
      state={devPublishState(name)}
      actions={actions}
      paymentsEnabled={paymentsEnabled}
      compare={publishCompare()}
      refresh={() => {}}
      now={NOW}
    />,
  );
}

const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

describe("publishWithRetry", () => {
  it("retries a conflict once after the delay, then returns the second result", async () => {
    const publish = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "conflict" })
      .mockResolvedValueOnce({ ok: true, slug: "s" });
    const wait = vi.fn(async () => {});
    await expect(publishWithRetry(publish, wait)).resolves.toEqual({ ok: true, slug: "s" });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(CONFLICT_RETRY_MS);
  });

  it("a second conflict is returned (no third call)", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: false, error: "conflict" });
    await expect(publishWithRetry(publish, async () => {})).resolves.toEqual({ ok: false, error: "conflict" });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publishErrorCopy("conflict")).toBe(CONFLICT_COPY);
  });

  it.each(["failed", "expired", "empty", "signed_out"])("%s is not retried", async (error) => {
    const publish = vi.fn().mockResolvedValue({ ok: false, error });
    const wait = vi.fn(async () => {});
    await publishWithRetry(publish, wait);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("success is not retried", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    await publishWithRetry(publish, async () => {});
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("copy mapping", () => {
  it("block reasons", () => {
    expect(blockReasonCopy("expired")).toBe("This free link has expired — Upgrade to bring it back");
    expect(blockReasonCopy("page_limit", 20)).toContain("more than 20 pages");
    expect(blockReasonCopy("empty")).toMatch(/no pages/);
    expect(blockReasonCopy("invalid_doc")).toMatch(/needs fixing/);
  });

  it("every publish error has distinct, non-empty copy", () => {
    const codes = ["signed_out", "not_found", "invalid_doc", "empty", "page_limit", "expired", "conflict", "failed"] as const;
    const texts = codes.map((c) => publishErrorCopy(c));
    for (const t of texts) expect(t.length).toBeGreaterThan(5);
    expect(new Set(texts).size).toBe(codes.length);
    expect(publishErrorCopy("expired")).toBe(EXPIRED_COPY);
  });

  it("password errors", () => {
    expect(passwordErrorCopy("too_short")).toBe("Use at least 4 characters.");
    expect(passwordErrorCopy("too_long")).toBe("Use at most 64 characters.");
    expect(passwordErrorCopy("invalid_chars")).toMatch(/characters we can't use/);
    expect(passwordErrorCopy("invalid_password")).toBe(passwordErrorCopy("invalid_chars"));
    expect(passwordErrorCopy("failed")).toMatch(/Try again/);
    expect(passwordErrorCopy("unavailable")).toBe("Passwords aren't available right now — try again later");
  });

  it("free vs upgraded copy never implies a free (watermarked) PDF — D-002: free = no PDF (T10 N5)", () => {
    const c = publishCompare();
    expect(JSON.stringify(c)).not.toMatch(/watermark-free PDF|free PDF/i);
    expect(c.rows.find((r) => r.key === "pdf")?.freeIncluded).toBe(false);
    expect(unpublishErrorCopy("failed")).toMatch(/unpublish/i);
  });

  it("password length counts code points", () => {
    expect(passwordLengthError("abc")).toBe("too_short");
    expect(passwordLengthError("abcd")).toBeNull();
    expect(passwordLengthError("😀😀😀")).toBe("too_short"); // 6 UTF-16 units, 3 code points
    expect(passwordLengthError("كلمة")).toBeNull();
    expect(passwordLengthError("a".repeat(64))).toBeNull();
    expect(passwordLengthError("a".repeat(65))).toBe("too_long");
  });

  it("expiry label", () => {
    expect(expiryLabel({ isPaid: true, expiresAt: "2026-12-12T08:00:00Z", expired: false, now: NOW })).toBe("Permanent link");
    expect(expiryLabel({ isPaid: false, expiresAt: "2026-12-12T08:00:00Z", expired: false, now: NOW })).toBe("Link expires 12 Dec");
    expect(expiryLabel({ isPaid: false, expiresAt: "2027-01-05T08:00:00Z", expired: false, now: NOW })).toBe("Link expires 5 Jan 2027");
    // UAE time zone: 21:00 UTC on 11 Dec is 12 Dec in Abu Dhabi.
    expect(expiryLabel({ isPaid: false, expiresAt: "2026-12-11T21:00:00Z", expired: false, now: NOW })).toBe("Link expires 12 Dec");
    expect(expiryLabel({ isPaid: false, expiresAt: "2026-11-01T08:00:00Z", expired: true, now: NOW })).toBe("Link expired 1 Nov");
    expect(expiryLabel({ isPaid: false, expiresAt: null, expired: false, now: NOW })).toBeNull();
    expect(expiryLabel({ isPaid: false, expiresAt: "nope", expired: false, now: NOW })).toBeNull();
  });

  it("displayUrl strips the scheme", () => {
    expect(displayUrl("https://x.ae/b/abc")).toBe("x.ae/b/abc");
  });
});

describe("hasUnpublishedChanges", () => {
  it("only when published and the saved rev moved past the snapshot", () => {
    expect(hasUnpublishedChanges(null, 5)).toBe(false);
    expect(hasUnpublishedChanges(5, 5)).toBe(false);
    expect(hasUnpublishedChanges(5, 6)).toBe(true);
    expect(hasUnpublishedChanges(5, null)).toBe(false);
    expect(hasUnpublishedChanges(6, 5)).toBe(false);
  });
});

describe("PublishPanelView states", () => {
  it.each(DEV_PUBLISH_STATES)("%s renders the message slot and the panel", (name) => {
    const html = panel(name);
    expect(has(html, "publish-panel")).toBe(true);
    expect(has(html, "publish-message-slot")).toBe(true);
  });

  it("unpublished free: Publish enabled, free notice + live upgrade, password, no unpublish", () => {
    const html = panel("draft");
    expect(html).toContain('data-state="unpublished"');
    expect(html).toMatch(/<button type="button" class="[^"]*" data-testid="publish-button"/); // no disabled=""
    expect(html).toContain(">Publish</");
    // M11 T15: the free notice is a Free vs upgraded comparison card (numbers from the limit modules).
    expect(html).toContain(publishCompare().summary);
    expect(html).toContain('data-testid="publish-compare"');
    expect(html).toMatch(/<button type="button" class="[^"]*" data-testid="publish-upgrade"/); // no disabled=""
    expect(html).toContain("Upgrade this book — AED 39");
    expect(html).not.toMatch(/coming soon/i);
    expect(has(html, "publish-upgrade-unavailable")).toBe(false);
    expect(has(html, "password-section")).toBe(true);
    expect(has(html, "unpublish-section")).toBe(false);
    expect(has(html, "share-buttons")).toBe(false);
  });

  it("payments off: disabled upgrade + 'Payments unavailable' (free notice and expired)", () => {
    for (const name of ["draft", "expired"] as const) {
      const html = panel(name, false);
      expect(html).toMatch(/<button type="button" disabled=""[^>]*data-testid="publish-upgrade"/);
      expect(has(html, "publish-upgrade-unavailable")).toBe(true);
      expect(html).toContain("Payments unavailable");
      expect(html).not.toMatch(/coming soon/i);
    }
  });

  it("unpublished paid: no free notice", () => {
    const html = panel("draft-paid");
    expect(has(html, "publish-free-notice")).toBe(false);
    expect(has(html, "publish-upgrade")).toBe(false);
  });

  it.each([
    ["empty", "empty"],
    ["page_limit", "page_limit"],
    ["invalid_doc", "invalid_doc"],
  ] as const)("blocked (%s): reason copy and disabled Publish", (name, reason) => {
    const html = panel(name);
    expect(html).toContain(blockReasonCopy(reason, 20));
    expect(html).toMatch(/<button type="button" disabled=""[^>]*data-testid="publish-button"/);
  });

  it("published free: link, share buttons, open book, expiry, unpublish, no publish-changes", () => {
    const html = panel("live");
    expect(html).toContain('data-state="published"');
    expect(html).toMatch(/<input id="[^"]+" readOnly="" dir="ltr"[^>]*data-testid="publish-url" value="https:\/\/photobook\.example\/b\/[^"]+"/);
    expect(html).toMatch(/<label for="[^"]+"[^>]*>Book link<\/label>/);
    expect(has(html, "share-buttons")).toBe(true);
    expect(has(html, "share-whatsapp")).toBe(true);
    expect(html).toMatch(/<a href="\/b\/sara-and-omar-wedding-7Hq2xYp9Kd" target="_blank" rel="noopener noreferrer"[^>]*data-testid="publish-open"/);
    expect(html).toContain("Link expires 12 Dec");
    expect(has(html, "unpublish-button")).toBe(true);
    expect(has(html, "publish-changes")).toBe(false);
    expect(has(html, "publish-button")).toBe(false);
    expect(html).toContain("Off — anyone with the link");
  });

  it("published paid: permanent link, no free notice", () => {
    const html = panel("live-paid");
    expect(html).toContain("Permanent link");
    expect(has(html, "publish-free-notice")).toBe(false);
  });

  it("published with changes: Publish changes button", () => {
    const html = panel("changes");
    expect(has(html, "publish-changes")).toBe(true);
    expect(html).toContain("Publish changes");
  });

  it("password on: change + remove", () => {
    const html = panel("password");
    expect(html).toContain("On — people need the password");
    expect(html).toContain("Change password");
    expect(has(html, "password-remove")).toBe(true);
  });

  it("expired: upgrade copy, no share / publish / password, unpublish still offered", () => {
    const html = panel("expired");
    expect(html).toContain('data-state="expired"');
    expect(html).toContain(EXPIRED_COPY);
    expect(has(html, "publish-upgrade")).toBe(true);
    expect(has(html, "share-buttons")).toBe(false);
    expect(has(html, "publish-button")).toBe(false);
    expect(has(html, "password-section")).toBe(false);
    expect(has(html, "unpublish-button")).toBe(true);
  });

  it("unpublished after a publish: keeps the same link note", () => {
    const html = panel("unpublished");
    expect(html).toContain("keeps the same link and expiry date");
    expect(has(html, "unpublish-section")).toBe(false);
  });

  it("live: Send on WhatsApp is the WhatsApp-green cta; Copy link and Open book are secondary, before the link field", () => {
    const html = panel("live");
    expect(html).toContain("Send on WhatsApp");
    // User decision 2026-11-11: WhatsApp green (white text ≥ 4.5:1), not the terracotta accent —
    // and no other accent was added, so the live screen has none (one accent per screen at most).
    const wa = html.match(/<a[^>]*data-testid="share-whatsapp"[^>]*>/)?.[0] ?? "";
    expect(wa).toContain("bg-[#0F7A40] text-white");
    expect(wa).toContain("h-12");
    expect(wa).toContain("focus-visible:ring-2");
    expect(html.match(/class="[^"]*\bbg-accent-strong\b/g)?.length ?? 0).toBe(0);
    const order = ["share-whatsapp", "share-copy", "publish-open", "publish-url"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Unpublish lives in the quiet bottom section, after password.
    expect(html.indexOf('data-testid="unpublish-section"')).toBeGreaterThan(html.indexOf('data-testid="password-section"'));
  });

  it("free vs upgraded card: every number comes from LIMITS / UPGRADE / FREE_LINK_DAYS", () => {
    const c = publishCompare();
    expect(c.summary).toBe(`Free link works for ${FREE_LINK_DAYS} days after you publish`);
    expect(c.price).toBe(UPGRADE.label);
    const row = (k: string) => c.rows.find((r) => r.key === k)!;
    expect(row("pages")).toMatchObject({ free: `Up to ${LIMITS.free.maxPages}`, paid: `Up to ${LIMITS.paid.maxPages}` });
    expect(row("link")).toMatchObject({ free: `${FREE_LINK_DAYS} days`, paid: "Permanent" });
    expect(row("pdf").freeIncluded).toBe(false);
    const html = panel("live");
    for (const r of c.rows) {
      expect(html).toContain(`data-row="${r.key}"`);
      expect(html).toContain(r.free);
      expect(html).toContain(r.paid);
    }
    expect(html).toContain(`${UPGRADE.label} · ${c.priceNote}`);
    // Source never hard-codes the limits.
    const src = readFileSync("src/components/publish/PublishPanel.tsx", "utf8") + readFileSync("src/lib/publish/compare.ts", "utf8");
    expect(src).not.toMatch(/\b(20|100|30) (pages|days)\b|AED 39/);
  });

  it("blocked reason and messages keep their exact text on the testid element", () => {
    const html = panel("empty");
    expect(html).toContain(`data-testid="publish-blocked">${blockReasonCopy("empty", 20)}</p>`);
  });

  it("PasswordField off: add button only", () => {
    const html = renderToStaticMarkup(<PasswordField hasPassword={false} setPassword={actions.setPassword} onChanged={() => {}} />);
    expect(html).toContain("Add a password");
    expect(has(html, "password-remove")).toBe(false);
  });
});

describe("dashboard publish chip", () => {
  const free = { published: true, is_paid: false, expires_at: "2026-12-12T08:00:00Z" };
  it("free live → expiry date", () => {
    expect(bookPublishChip(free, NOW)).toEqual({ label: "Published · expires 12 Dec", tone: "live" });
  });
  it("paid → Published", () => {
    expect(bookPublishChip({ ...free, is_paid: true }, NOW)).toEqual({ label: "Published", tone: "live" });
  });
  it("free past expiry → Expired (paid never)", () => {
    expect(bookPublishChip({ ...free, expires_at: "2026-11-01T00:00:00Z" }, NOW)).toEqual({ label: "Expired", tone: "expired" });
    expect(bookPublishChip({ ...free, is_paid: true, expires_at: "2026-11-01T00:00:00Z" }, NOW).label).toBe("Published");
  });
  it("not published → Draft, no share link", () => {
    expect(bookPublishChip({ ...free, published: false }, NOW).label).toBe("Draft");
    expect(bookShareHref({ ...free, published: false, id: BOOK })).toBeNull();
    expect(bookShareHref({ ...free, id: BOOK })).toBe(`/books/${BOOK}/publish`);
  });

  it("BookList renders the chip and a Share link outside the card link", () => {
    const book: BookListItem = {
      id: BOOK,
      title: "عطلتنا",
      updated_at: "2026-11-09T10:00:00Z",
      page_count: 12,
      published_at: "2026-11-12T08:00:00Z",
      is_paid: false,
      ai_status: "done",
      slug: "s-1",
      expires_at: "2026-12-12T08:00:00Z",
      draft_warning_sent_at: null,
      published: true,
      photo_count: 30,
      user_edited: true,
      format: "A5_PORTRAIT",
      designStyle: "classic",
      coverThumbUrl: null,
    };
    const html = renderToStaticMarkup(<BookList books={[book, { ...book, id: "x", published: false }]} now={NOW} />);
    expect(html).toContain("Published · expires 12 Dec");
    expect(html).toContain("Draft");
    expect(html.match(/data-testid="book-share"/g)?.length).toBe(1);
    expect(html).toContain(`href="/books/${BOOK}/publish"`);
    expect(html).toMatch(/<p dir="auto"[^>]*>عطلتنا<\/p>/);
    // No nested anchors.
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>)[\s\S])*<a /);
  });
});

describe("editor header publish chip", () => {
  it("shown when published and the loaded rev is past the snapshot", () => {
    const data = { ...devEditorData("ok"), docRev: 4, publishedRev: 3 };
    const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} tools={[]} />);
    expect(html).toContain('data-testid="editor-publish-changes"');
  });
  it("hidden when unpublished or up to date", () => {
    for (const publishedRev of [null, 1]) {
      const data = { ...devEditorData("ok"), docRev: 1, publishedRev };
      const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} tools={[]} />);
      expect(html).not.toContain('data-testid="editor-publish-changes"');
    }
  });
});

describe("PublishHeader on the shared PageHeader (M11 review)", () => {
  it("keeps publish-back / publish-title testids, step 6 and an Arabic-safe title line", async () => {
    const { PublishHeader } = await import("@/components/publish/PublishHeader");
    const html = renderToStaticMarkup(<PublishHeader bookId="b1" title="سارة وعمر" />);
    expect(html).toContain('data-testid="page-header"');
    expect(html).toMatch(/<a data-testid="publish-back"[^>]*href="\/books\/b1\/edit"/);
    expect(html).toContain("Back to editor");
    expect(html).toContain("Step 6 of 6: Share");
    expect(html).toMatch(/<p dir="auto" class="type-small[^"]*" data-testid="publish-title">سارة وعمر<\/p>/);
    expect(html).not.toContain("type-eyebrow");
    expect(html).toMatch(/<h1[^>]*>Share your book<\/h1>/);
  });
});

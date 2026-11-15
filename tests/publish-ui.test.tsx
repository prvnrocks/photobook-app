import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BookList } from "@/components/dashboard/BookList";
import { EditorShell } from "@/components/editor/EditorShell";
import { PasswordField } from "@/components/publish/PasswordField";
import { type PublishActions } from "@/components/publish/PublishPanel";
import { SharePanel } from "./helpers/share-panel";
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
    <SharePanel
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

describe("PublishPanelView after the editor's Share (M13 T9)", () => {
  const shared = (name: DevPublishStateName, flag: "live" | "changes" | null) =>
    renderToStaticMarkup(
      <SharePanel
        bookId={BOOK}
        title="Sara & Omar"
        state={devPublishState(name)}
        actions={actions}
        paymentsEnabled
        compare={publishCompare()}
        refresh={() => {}}
        now={NOW}
        shared={flag}
        preview={null}
      />,
    );

  it("?shared=live → 'Your book is live'; ?shared=changes → 'Changes published'; none → no message", () => {
    expect(shared("live", "live")).toMatch(/data-testid="publish-message">Your book is live</);
    expect(shared("live", "changes")).toMatch(/data-testid="publish-message">Changes published</);
    expect(shared("live", null)).not.toContain('data-testid="publish-message"');
  });

  it("M13 polish: 'Your book is live' shows once — the card heading names the next step after a publish", () => {
    const count = (h: string) => h.split("Your book is live").length - 1;
    const justShared = shared("live", "live");
    expect(count(justShared)).toBe(1);
    expect(justShared).toMatch(/data-testid="publish-message">Your book is live</);
    expect(justShared).toMatch(/data-testid="publish-live-heading">.*Share your link<\/h2>/);
    // Later visit (no notice) or a changes publish: the card itself says the book is live.
    expect(count(shared("live", null))).toBe(1);
    expect(shared("live", null)).toMatch(/data-testid="publish-live-heading">.*Your book is live<\/h2>/);
    expect(shared("live", "changes")).toMatch(/data-testid="publish-live-heading">.*Your book is live<\/h2>/);
  });

  it("?shared= celebrates: data-celebrate on the panel + live card (badge hop); the burst lives only in the preview (M21 T5)", () => {
    for (const flag of ["live", "changes"] as const) {
      const html = shared("live", flag);
      expect(html).toMatch(/data-testid="publish-panel" data-state="published" data-celebrate="on"/);
      const card = html.match(/<section[^>]*data-testid="publish-live-card"[^>]*>/)?.[0] ?? "";
      expect(card).toContain('data-celebrate="on"');
      expect(has(html, "share-burst")).toBe(false); // no preview passed → no burst anywhere
    }
    const calm = shared("live", null);
    expect(calm).not.toContain("data-celebrate");
  });

  it("with a preview (M21 T5 slot): the panel root celebrates the preview's burst; it carries Open flipbook (one publish-open, no card burst)", () => {
    const html = renderToStaticMarkup(
      <SharePanel
        bookId={BOOK}
        title="سارة وعمر"
        state={devPublishState("live")}
        actions={actions}
        paymentsEnabled
        compare={publishCompare()}
        refresh={() => {}}
        now={NOW}
        shared="live"
        preview={{ coverThumbUrl: null, format: "A5_PORTRAIT", designStyle: "classic" }}
      />,
    );
    expect(html).toMatch(/<div class="[^"]*lg:grid[^"]*" data-testid="publish-panel" data-state="published" data-celebrate="on"/);
    const tile = html.match(/<figure[^>]*data-testid="share-preview"[^>]*>/)?.[0] ?? "";
    expect(tile).toContain('data-variant="responsive"');
    expect(html.match(/data-testid="share-burst"/g)?.length).toBe(1);
    expect(html.indexOf('data-testid="share-burst"')).toBeLessThan(html.indexOf('data-testid="publish-live-card"'));
    expect(html.match(/data-testid="publish-open"/g)?.length).toBe(1);
    expect(html).toMatch(/<a href="\/b\/sara-and-omar-wedding-7Hq2xYp9Kd" target="_blank" rel="noopener noreferrer"[^>]*data-testid="publish-open"/);
    expect(html).toContain("Open flipbook");
    expect(html).toMatch(/<span dir="auto"[^>]*>سارة وعمر<\/span>/);
    expect(html.indexOf('data-testid="share-preview"')).toBeLessThan(html.indexOf('data-testid="publish-live-card"'));
  });

  it("draft / expired never celebrate, even with ?shared=", () => {
    expect(shared("draft", "live")).not.toContain('data-celebrate="on"');
    expect(shared("expired", "live")).not.toContain('data-celebrate="on"');
  });

  it("live free: WhatsApp leads, then Copy, then the free vs paid card + Upgrade; copy says the link is public", () => {
    const html = shared("live", "live");
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at("share-whatsapp")).toBeGreaterThan(-1);
    expect(at("share-whatsapp")).toBeLessThan(at("share-copy"));
    expect(at("share-copy")).toBeLessThan(at("publish-free-notice"));
    expect(at("publish-free-notice")).toBeLessThan(at("publish-upgrade"));
    expect(html).toContain("Anyone with the link can see it");
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

  it("published with changes (M21): 'Your edits aren't live yet' + last published + gold Update link, above the link card", () => {
    const html = panel("changes");
    expect(has(html, "publish-changes")).toBe(true);
    expect(html).toContain("Your edits aren&#x27;t live yet");
    expect(html).toContain('data-testid="publish-last-published">Last published 12 Nov<');
    expect(html).toMatch(/<button type="button" class="[^"]*home-foil-fill[^"]*" data-testid="publish-changes-button"><svg[^>]*>.*<\/svg>Update link<\/button>/);
    // The changes card replaces the calm live card and sits above the link card.
    expect(has(html, "publish-live-card")).toBe(false);
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at("publish-changes")).toBeGreaterThan(-1);
    expect(at("publish-changes")).toBeLessThan(at("publish-live"));
    expect(at("publish-changes-button")).toBeLessThan(at("share-whatsapp"));
    expect(has(html, "publish-url")).toBe(true);
  });

  it("changes on a paid book: same card, chip stays paid-only via state.isPaid (no free notice)", () => {
    const html = renderToStaticMarkup(
      <SharePanel
        bookId={BOOK}
        title="Sara & Omar"
        state={{ ...devPublishState("live-paid"), hasChanges: true }}
        actions={actions}
        paymentsEnabled
        compare={publishCompare()}
        refresh={() => {}}
        now={NOW}
      />,
    );
    expect(has(html, "publish-changes-button")).toBe(true);
    expect(has(html, "publish-free-notice")).toBe(false);
  });

  it("changes card blocked: reason + disabled Update link", () => {
    const html = renderToStaticMarkup(
      <SharePanel
        bookId={BOOK}
        title="Sara & Omar"
        state={{ ...devPublishState("changes"), canPublishReason: "page_limit", pageCount: 24 }}
        actions={actions}
        paymentsEnabled
        compare={publishCompare()}
        refresh={() => {}}
        now={NOW}
      />,
    );
    expect(html).toContain(`data-testid="publish-blocked">${blockReasonCopy("page_limit", 20)}</p>`);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*data-testid="publish-changes-button"/);
  });

  it("draft: Publish is the gold CTA", () => {
    const html = panel("draft");
    expect(html).toMatch(/<button type="button" class="[^"]*home-foil-fill[^"]*" data-testid="publish-button"/);
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

  it("live: Send on WhatsApp is the big WhatsApp-green cta; then the link field + Copy; Open flipbook in the preview", () => {
    const html = panel("live");
    expect(html).toContain("Send on WhatsApp");
    // User decision 2026-11-11: WhatsApp green (white text ≥ 4.5:1), not the terracotta accent.
    const wa = html.match(/<a[^>]*data-testid="share-whatsapp"[^>]*>/)?.[0] ?? "";
    expect(wa).toContain("bg-[#0F7A40] text-white");
    expect(wa).toContain("h-12");
    expect(wa).toContain("focus-visible:ring-2");
    expect(html.match(/class="[^"]*\bbg-accent-strong\b/g)?.length ?? 0).toBe(0);
    const order = ["share-whatsapp", "publish-url", "share-copy"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // M21 T5: the one "Open flipbook" lives in the preview (aside, before the cards), not the link card.
    expect(html.match(/data-testid="publish-open"/g)?.length).toBe(1);
    expect(html.indexOf('data-testid="publish-open"')).toBeLessThan(html.indexOf('data-testid="publish-live"'));
    expect(html.indexOf('data-testid="publish-open"')).toBeGreaterThan(html.indexOf('data-testid="share-preview"'));
    // Copy: emerald pill with the copy-pulse hook, accessible name "Copy link", no feedback yet.
    const copy = html.match(/<button[^>]*data-testid="share-copy"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(copy).toContain("share-copy-pulse");
    expect(copy).not.toContain("data-copied");
    expect(copy).toMatch(/Copy<span class="sr-only"> link<\/span>/);
    // The calm live card sits above the link card; no native share before mount (feature-detected).
    expect(html.indexOf('data-testid="publish-live-card"')).toBeLessThan(html.indexOf('data-testid="publish-live"'));
    expect(has(html, "share-native")).toBe(false);
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
    const src = ["src/components/publish/PublishPanel.tsx", "src/components/publish/PlanCard.tsx", "src/components/publish/PdfCard.tsx", "src/components/publish/share-slots.tsx", "src/lib/publish/compare.ts"]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
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
    // M18 chip: "Live · N days left" (expires 12 Dec 08:00, now 10 Nov 10:00 → 31.9 days → 32).
    expect(html).toContain("Live · 32 days left");
    expect(html).toContain("Draft");
    expect(html.match(/data-testid="book-share"/g)?.length).toBe(1);
    // The built draft's Share is the publish entry (D-070) under its own testid.
    expect(html.match(/data-testid="book-publish"/g)?.length).toBe(1);
    expect(html).toContain(`href="/books/${BOOK}/publish"`);
    expect(html).toMatch(/<span dir="auto"[^>]*>عطلتنا<\/span>/);
    // No nested anchors.
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<a /);
  });
});

describe("editor header: Publish changes folded into Share (M13 T9)", () => {
  it("Share shows 'Publish changes' when published and the loaded rev is past the snapshot", () => {
    const data = { ...devEditorData("ok"), docRev: 4, publishedRev: 3 };
    const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} tools={[]} />);
    expect(html).toMatch(/<button[^>]*data-testid="editor-done"[^>]*data-changes="true"/);
    expect(html).toMatch(/<span[^>]*data-testid="editor-publish-changes"[^>]*>Publish changes<\/span>/);
  });
  it("no 'Publish changes' when unpublished or up to date", () => {
    for (const publishedRev of [null, 1]) {
      const data = { ...devEditorData("ok"), docRev: 1, publishedRev };
      const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} tools={[]} />);
      expect(html).not.toContain('data-testid="editor-publish-changes"');
      expect(html).toContain('data-testid="editor-share-note"');
    }
  });
});

describe("share page shell (M21 T5; replaces PublishHeader)", () => {
  it("band: publish-back → editor, the title as the h1 in dir=auto (publish-title), status chip; plain library header", async () => {
    const { ShareBand } = await import("@/components/publish/ShareBand");
    const { SHARE_BACK_LINK } = await import("@/components/publish/share-page-classes");
    const html = renderToStaticMarkup(
      <ShareBand
        title="سارة وعمر"
        chip={{ text: "Draft", kind: "draft" }}
        back={
          <a href="/books/b1/edit" className={SHARE_BACK_LINK} data-testid="publish-back">
            Back to editor
          </a>
        }
      />,
    );
    expect(html).toMatch(/<a href="\/books\/b1\/edit"[^>]*data-testid="publish-back"/);
    expect(html).toMatch(/<h1[^>]*><span dir="auto" data-testid="publish-title">سارة وعمر<\/span><\/h1>/);
    expect(html).toContain('data-testid="publish-status-chip"');
    const page = readFileSync("src/app/books/[id]/publish/page.tsx", "utf8");
    expect(page).toContain('<AppHeader displayName={displayName} variant="plain" width="library" />');
    expect(page).toMatch(/href=\{`\/books\/\$\{id\}\/edit`\} className=\{SHARE_BACK_LINK\} data-testid="publish-back"/);
    expect(page).toContain('<h2 className="sr-only">Share your book</h2>');
    expect(page).toContain("shareChipKind(status)");
    expect(page).toContain("preview={slots.preview}");
    expect(page).not.toMatch(/console\.(log|info|warn|error)/);
  });
});

// M9 T10: deletion chips + their date formatting, dashboard "Delete book" menu / dialog body,
// publish-screen "Deletes on" line, settings reminders toggle + delete-account danger zone.
// Static renders (no DOM); server actions are mocked or passed as props.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/settings/actions", () => ({ setEmailRemindersAction: vi.fn(), deleteAccountAction: vi.fn() }));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
// BookList renders the router-wired <BookCardMenu>; static renders have no app router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { BookList } = await import("@/components/dashboard/BookList");
const { BookCardMenuView, DeleteBookConfirmContent } = await import("@/components/dashboard/BookCardMenu");
const { PublishPanelView } = await import("@/components/publish/PublishPanel");
const { EmailRemindersToggleView } = await import("@/components/settings/EmailRemindersToggle");
const { DeleteAccountView } = await import("@/components/settings/DeleteAccount");
const { AccountDeletedNotice } = await import("@/components/settings/AccountDeletedNotice");
const { bookDeletionChip, deletesOnLabel, expiredBookDeleteDate } = await import("@/lib/dashboard/deletion-chip");
const { devPublishState, DEV_PUBLISH_URL } = await import("@/lib/publish/dev-fixture");
const { FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY, DRAFT_IDLE_DAYS } = await import("@/lib/cleanup/rules");
type BookListItem = import("@/lib/db/books").BookListItem;

const NOW = new Date("2026-11-10T10:00:00.000Z");
const BOOK = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400_000;
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

const base: BookListItem = {
  id: BOOK,
  title: "عطلتنا في العين",
  updated_at: "2026-11-09T10:00:00Z",
  page_count: 12,
  published_at: null,
  is_paid: false,
  ai_status: "done",
  slug: null,
  expires_at: null,
  draft_warning_sent_at: null,
  published: false,
  photo_count: 30,
  user_edited: true,
  format: "A5_PORTRAIT",
  designStyle: "classic",
  coverThumbUrl: null,
};

describe("deletion chip — dates", () => {
  it("expired free book: expires_at + 14 days, en-GB short date in Asia/Dubai", () => {
    expect(FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY).toBe(14);
    const chip = bookDeletionChip({ ...base, published: true, published_at: "2026-10-02T08:00:00Z", expires_at: "2026-11-01T08:00:00Z" }, NOW);
    expect(chip).toMatchObject({ kind: "expired", label: "Deletes on 15 Nov" });
    expect(chip?.date.toISOString()).toBe("2026-11-15T08:00:00.000Z");
  });

  it("uses the UAE calendar day (21:00 UTC is already the next day in Dubai)", () => {
    const chip = bookDeletionChip({ ...base, published: true, expires_at: "2026-11-01T21:00:00Z" }, NOW);
    expect(chip?.label).toBe("Deletes on 16 Nov");
  });

  it("adds the year when the date is in another UAE year", () => {
    const now = new Date("2026-12-28T10:00:00Z");
    const chip = bookDeletionChip({ ...base, published: true, expires_at: "2026-12-25T08:00:00Z" }, now);
    expect(chip?.label).toBe("Deletes on 8 Jan 2027");
  });

  it("past the deletion date (cron not run yet) → Deleting soon", () => {
    const chip = bookDeletionChip({ ...base, published: true, expires_at: "2026-10-01T08:00:00Z" }, NOW);
    expect(chip?.label).toBe("Deleting soon");
  });

  it("expired but unpublished free book is deleted too (same SQL rule)", () => {
    expect(bookDeletionChip({ ...base, published: false, published_at: "2026-10-01T00:00:00Z", expires_at: "2026-11-01T08:00:00Z" }, NOW)?.kind).toBe("expired");
  });

  it("no chip: paid, live free link, plain draft, invalid expiry", () => {
    expect(bookDeletionChip({ ...base, is_paid: true, published: true, expires_at: "2026-11-01T08:00:00Z" }, NOW)).toBeNull();
    expect(bookDeletionChip({ ...base, published: true, expires_at: "2026-12-01T08:00:00Z" }, NOW)).toBeNull();
    expect(bookDeletionChip(base, NOW)).toBeNull();
    expect(expiredBookDeleteDate({ is_paid: false, expires_at: "nope" }, NOW)).toBeNull();
  });

  it("idle draft: chip only after a warning claimed after the last activity", () => {
    const updated = "2026-09-25T10:00:00Z";
    const warned = "2026-11-02T01:00:00Z"; // day 38
    const draft = { ...base, updated_at: updated, draft_warning_sent_at: warned };
    const chip = bookDeletionChip(draft, NOW);
    expect(chip?.kind).toBe("inactive");
    // max(updated + 45 d = 9 Nov 10:00, warned + 7 d = 9 Nov 01:00) → 9 Nov … already passed at NOW
    expect(new Date(updated).getTime() + DRAFT_IDLE_DAYS * DAY).toBe(chip?.date.getTime());
    expect(chip?.label).toBe("Inactive — deleting soon");

    const fresh = { ...base, updated_at: "2026-10-01T10:00:00Z", draft_warning_sent_at: "2026-11-08T01:00:00Z" };
    expect(bookDeletionChip(fresh, NOW)?.label).toBe("Inactive — deletes on 15 Nov");
  });

  it("idle draft: no chip without a warning, with a stale warning, when published, or without photos", () => {
    const warned = { ...base, updated_at: "2026-10-01T10:00:00Z", draft_warning_sent_at: "2026-11-08T01:00:00Z" };
    expect(bookDeletionChip({ ...warned, draft_warning_sent_at: null }, NOW)).toBeNull();
    expect(bookDeletionChip({ ...warned, updated_at: "2026-11-09T10:00:00Z" }, NOW)).toBeNull(); // edited after warning
    expect(bookDeletionChip({ ...warned, published_at: "2026-10-02T00:00:00Z" }, NOW)).toBeNull();
    expect(bookDeletionChip({ ...warned, photo_count: 0 }, NOW)).toBeNull();
    expect(bookDeletionChip({ ...warned, is_paid: true }, NOW)).toBeNull();
  });

  it("deletesOnLabel rejects invalid dates", () => {
    expect(deletesOnLabel(new Date("nope"), NOW)).toBeNull();
    expect(deletesOnLabel(new Date("2026-12-01T00:00:00Z"), NOW, "inactive")).toBe("Inactive — deletes on 1 Dec");
  });
});

describe("dashboard: BookList + delete menu", () => {
  const expired = { ...base, id: "x1", published: true, published_at: "2026-10-02T08:00:00Z", expires_at: "2026-11-01T08:00:00Z" };

  it("renders the deletion chip and a menu per card when deleteBook is passed", () => {
    const html = renderToStaticMarkup(<BookList books={[base, expired]} now={NOW} deleteBook={async () => ({ ok: true })} />);
    expect(html.match(/data-testid="book-menu"/g)?.length).toBe(2);
    expect(html.match(/data-testid="book-delete-chip"/g)?.length).toBe(1);
    expect(html).toContain("Deletes on 15 Nov");
    expect(html).toContain('aria-label="Book options: عطلتنا في العين"');
  });

  it("no menu without the action (read-only render)", () => {
    const html = renderToStaticMarkup(<BookList books={[base]} now={NOW} />);
    expect(has(html, "book-menu")).toBe(false);
  });

  it("menu trigger is a 44 px target; dialog closed by default", () => {
    const html = renderToStaticMarkup(
      <BookCardMenuView bookId={BOOK} title={null} deleteBook={async () => ({ ok: true })} refresh={() => {}} />,
    );
    expect(html).toMatch(/data-testid="book-menu"/);
    expect(html).toContain("min-h-11 w-11");
    expect(html).toContain('aria-label="Book options: Untitled book"');
    expect(has(html, "delete-book-dialog")).toBe(false);
  });

  it("dialog body: title with dir=auto, destructive copy, cancel + confirm", () => {
    const html = renderToStaticMarkup(
      <DeleteBookConfirmContent title="عطلتنا" error={null} pending={false} onCancel={() => {}} onConfirm={() => {}} titleId="t" detailId="d" />,
    );
    expect(html).toContain("Delete this book?");
    expect(html).toMatch(/<p dir="auto"[^>]*data-testid="delete-book-title"[^>]*>عطلتنا<\/p>/);
    expect(html).toContain("can&#x27;t be undone");
    expect(has(html, "delete-book-cancel")).toBe(true);
    expect(html).toMatch(/data-testid="delete-book-confirm"[^>]*>(<[^>]+>)*Delete book/);
    expect(has(html, "delete-book-error")).toBe(false);
  });

  it("dialog body: busy + error states", () => {
    const html = renderToStaticMarkup(
      <DeleteBookConfirmContent
        title="Trip"
        error="This book has a payment — contact support to delete it."
        pending
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain("Deleting…");
    expect(html).toContain('aria-busy="true"');
    for (const id of ["delete-book-cancel", "delete-book-confirm"]) {
      expect(html).toMatch(new RegExp(`<button[^>]* disabled=""[^>]*data-testid="${id}"`));
    }
    expect(html).toMatch(/role="alert"[^>]*data-testid="delete-book-error"[^>]*>This book has a payment — contact support to delete it\./);
  });
});

describe("publish screen: expired free book shows its deletion date", () => {
  const render = (state: ReturnType<typeof devPublishState>) =>
    renderToStaticMarkup(
      <PublishPanelView
        bookId={BOOK}
        title="Trip"
        state={state}
        actions={{
          publish: async () => ({ ok: true, slug: "s", url: DEV_PUBLISH_URL, expiresAt: null }),
          unpublish: async () => ({ ok: true }),
          setPassword: async () => ({ ok: true, hasPassword: false }),
        }}
        paymentsEnabled
        refresh={() => {}}
        now={NOW}
      />,
    );

  it("near the upgrade button", () => {
    const html = render(devPublishState("expired"));
    expect(html).toContain("Deletes on 15 Nov. Upgrade to keep it.");
    expect(html.indexOf("publish-deletes-on")).toBeLessThan(html.indexOf("publish-upgrade"));
  });

  it("not on a live or draft book", () => {
    expect(has(render(devPublishState("draft")), "publish-deletes-on")).toBe(false);
    expect(has(render(devPublishState("live")), "publish-deletes-on")).toBe(false);
  });
});

describe("settings: email reminders + delete account", () => {
  it("toggle reflects the saved value as an accessible switch", () => {
    const on = renderToStaticMarkup(<EmailRemindersToggleView initialOn save={async () => ({ ok: true, on: false })} />);
    expect(on).toMatch(/role="switch" aria-checked="true"/);
    expect(on).toContain('data-testid="settings-reminders-toggle"');
    expect(on).toContain('data-state="on"');
    expect(on).toContain("min-h-11");
    const off = renderToStaticMarkup(<EmailRemindersToggleView initialOn={false} save={async () => ({ ok: true, on: true })} />);
    expect(off).toMatch(/aria-checked="false"/);
  });

  it("toggle: load failure shows a friendly error instead of a possibly wrong switch", () => {
    const html = renderToStaticMarkup(<EmailRemindersToggleView initialOn={null} save={async () => ({ ok: true, on: true })} />);
    expect(has(html, "settings-reminders-toggle")).toBe(false);
    expect(has(html, "settings-reminders-load-error")).toBe(true);
  });

  it("danger zone explains what is deleted; button disabled until DELETE is typed", () => {
    const html = renderToStaticMarkup(<DeleteAccountView deleteAccount={async () => undefined} />);
    expect(html).toContain("all your books (paid books too)");
    expect(html).toContain("Type DELETE to confirm");
    expect(html).toMatch(/<label for="settings-delete-confirm"/);
    expect(html).toMatch(/data-testid="settings-delete-button"/);
    expect(html).toMatch(/disabled=""[^>]*data-testid="settings-delete-button"|data-testid="settings-delete-button"[^>]*disabled=""/);
    const ready = renderToStaticMarkup(<DeleteAccountView deleteAccount={async () => undefined} initialText="DELETE" />);
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="settings-delete-button"/);
  });

  it("account-deleted notice renders nothing on the server (reads the URL on mount)", () => {
    expect(renderToStaticMarkup(<AccountDeletedNotice />)).toBe("");
  });
});

// M9 review fixes S2 / S4 / N3: chips for owners who get no warning email, "reminders off" copy on
// the unsubscribe pages and in Settings, accurate privacy wording, delete-account error lookup.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/settings/actions", () => ({ setEmailRemindersAction: vi.fn(), deleteAccountAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { BookList } = await import("@/components/dashboard/BookList");
const { EmailRemindersToggleView } = await import("@/components/settings/EmailRemindersToggle");
const { bookDeletionChip } = await import("@/lib/dashboard/deletion-chip");
const { DRAFT_IDLE_DAYS, DRAFT_WARNING_DAYS, REMINDERS_OFF_NOTICE } = await import("@/lib/cleanup/rules");
const { unsubscribePage } = await import("@/lib/email/unsubscribe-page");
const { escapeHtml } = await import("@/lib/email/templates/layout");
const { deleteAccountErrorCopy } = await import("@/lib/settings/account");
const { default: PrivacyPage } = await import("@/app/(marketing)/privacy/page");
type BookListItem = import("@/lib/db/books").BookListItem;

const DAY = 86_400_000;
const UPDATED = "2026-10-01T10:00:00.000Z";
const draft: BookListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Eid",
  updated_at: UPDATED,
  page_count: 12,
  published_at: null,
  is_paid: false,
  ai_status: "done",
  slug: null,
  expires_at: null,
  draft_warning_sent_at: null,
  published: false,
  photo_count: 30,
  user_edited: false,
  format: "A5_PORTRAIT",
  designStyle: "classic",
  coverThumbUrl: null,
};
const at = (days: number) => new Date(Date.parse(UPDATED) + days * DAY);

describe("S2: deletion chip when the owner gets no warning email", () => {
  it("rules: 38 / 45 days", () => {
    expect(DRAFT_WARNING_DAYS).toBe(38);
    expect(DRAFT_IDLE_DAYS).toBe(45);
  });

  it("reminders off: no chip before day 38, then updated_at + 45 days", () => {
    expect(bookDeletionChip(draft, at(37.9), { emailable: false })).toBeNull();
    const chip = bookDeletionChip(draft, at(38), { emailable: false });
    expect(chip?.kind).toBe("inactive");
    expect(chip?.date.toISOString()).toBe(at(45).toISOString());
    expect(chip?.label).toBe("Inactive — deletes on 15 Nov");
    expect(bookDeletionChip(draft, at(46), { emailable: false })?.label).toBe("Inactive — deleting soon");
  });

  it("reminders off: ignores a warning claimed earlier (deleted at idle 45 regardless)", () => {
    const warned = { ...draft, draft_warning_sent_at: at(44).toISOString() };
    expect(bookDeletionChip(warned, at(44.5), { emailable: false })?.date.toISOString()).toBe(at(45).toISOString());
  });

  it("unknown setting (null) uses the no-email rule", () => {
    expect(bookDeletionChip(draft, at(40), { emailable: null })?.label).toBe("Inactive — deletes on 15 Nov");
  });

  it("reminders on (and default): still no chip without a warning", () => {
    expect(bookDeletionChip(draft, at(40), { emailable: true })).toBeNull();
    expect(bookDeletionChip(draft, at(40))).toBeNull();
    const warned = { ...draft, draft_warning_sent_at: at(38).toISOString() };
    expect(bookDeletionChip(warned, at(40), { emailable: true })?.label).toBe("Inactive — deletes on 15 Nov");
  });

  it("reminders off: no chip for drafts without photos, published, or paid books", () => {
    const now = at(40);
    expect(bookDeletionChip({ ...draft, photo_count: 0 }, now, { emailable: false })).toBeNull();
    expect(bookDeletionChip({ ...draft, published_at: UPDATED }, now, { emailable: false })).toBeNull();
    expect(bookDeletionChip({ ...draft, is_paid: true }, now, { emailable: false })).toBeNull();
  });

  it("BookList passes emailable through", () => {
    const off = renderToStaticMarkup(<BookList books={[draft]} now={at(40)} emailable={false} />);
    expect(off).toContain("Inactive — deletes on 15 Nov");
    const on = renderToStaticMarkup(<BookList books={[draft]} now={at(40)} />);
    expect(on).not.toContain('data-testid="book-delete-chip"');
  });
});

describe("S2 copy: reminders off notice", () => {
  const expected =
    "You won't get reminder emails. Unpublished drafts are still deleted after 45 days without changes, and free links still expire — you'll see the dates on your dashboard.";

  it("constant reads exactly as agreed", () => {
    expect(REMINDERS_OFF_NOTICE).toBe(expected);
  });

  it("unsubscribe confirm + done pages show it", () => {
    for (const kind of ["confirm", "done"] as const) {
      expect(unsubscribePage(kind, "/api/email/unsubscribe?t=x")).toContain(escapeHtml(expected));
    }
    expect(unsubscribePage("done")).not.toContain("any more reminder emails about expiring links");
  });

  it("Settings shows it while reminders are off (and when the setting is unknown)", () => {
    const esc = (s: string) => s.replace(/'/g, "&#x27;");
    const off = renderToStaticMarkup(<EmailRemindersToggleView initialOn={false} save={async () => ({ ok: true, on: true })} />);
    expect(off).toContain(esc(expected));
    const unknown = renderToStaticMarkup(<EmailRemindersToggleView initialOn={null} save={async () => ({ ok: true, on: true })} />);
    expect(unknown).toContain(esc(expected));
    const on = renderToStaticMarkup(<EmailRemindersToggleView initialOn save={async () => ({ ok: true, on: false })} />);
    expect(on).not.toContain(esc(expected));
    expect(on).toContain("Turn this off to stop these emails.");
  });
});

describe("S4: privacy page says how deletion really works", () => {
  const html = renderToStaticMarkup(<PrivacyPage />);
  it("free books from the dashboard menu; paid ones via account deletion or email", () => {
    expect(html).toContain("Delete a free book from its ⋯ menu on your dashboard.");
    expect(html).toContain("Books with a payment can&#x27;t be deleted");
    expect(html).toContain("delete your account in Settings (which removes all your books) or email us");
    expect(html).not.toContain("at any time in Settings");
    expect(html).not.toContain("delete a book or your account in Settings");
  });
});

describe("N3: delete-account error copy lookup", () => {
  it("unknown codes fall back to the generic error", () => {
    expect(deleteAccountErrorCopy("something_new")).toBe("We couldn't delete your account. Please try again.");
  });
});

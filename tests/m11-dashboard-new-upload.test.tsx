// M11 T8–T10 (D-067): dashboard cards, New book form and Upload screen take the app look.
// No DOM environment: markup via renderToStaticMarkup, page copy via the route source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/books/actions", () => ({ createBookAction: vi.fn(), deleteUnfinishedAction: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

const { BookList } = await import("@/components/dashboard/BookList");
const { BookCover } = await import("@/components/dashboard/BookCover");
const { EmptyState } = await import("@/components/dashboard/EmptyState");
const { NewBookForm } = await import("@/components/books/NewBookForm");
const { Uploader } = await import("@/components/upload/Uploader");
const { UploadSummary } = await import("@/components/upload/UploadSummary");
const { UploadProgress } = await import("@/components/upload/UploadProgress");
type BookListItem = import("@/lib/db/books").BookListItem;
type QueueSummary = import("@/lib/upload/queue").QueueSummary;

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const NOW = new Date("2026-11-11T08:00:00Z");
const book: BookListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "عطلتنا في العين",
  updated_at: "2026-11-09T10:00:00Z",
  page_count: 12,
  published_at: "2026-11-10T08:00:00Z",
  is_paid: true,
  ai_status: "done",
  slug: "s-1",
  expires_at: null,
  draft_warning_sent_at: null,
  published: true,
  photo_count: 30,
  user_edited: false,
  format: "A5_PORTRAIT",
  designStyle: "classic",
  coverThumbUrl: "https://example.supabase.co/storage/v1/object/sign/photos/u/b/p/thumb.jpg?token=t",
};

describe("T8 dashboard cards", () => {
  const html = renderToStaticMarkup(
    <BookList
      books={[book, { ...book, id: "x", coverThumbUrl: null, format: "A5_LANDSCAPE", designStyle: "modern", published: false, is_paid: false }]}
      now={NOW}
      deleteBook={async () => ({ ok: true })}
    />,
  );

  it("shows the real cover thumb, and a styled placeholder when there is none", () => {
    expect(html).toContain(`src="${book.coverThumbUrl!.replace(/&/g, "&amp;")}"`);
    expect(html).toMatch(/<img[^>]*alt=""/);
    expect(html.match(/data-cover="photo"/g)?.length).toBe(1);
    expect(html.match(/data-cover="placeholder"/g)?.length).toBe(1);
    expect(html.match(/data-testid="book-cover-placeholder"/g)?.length).toBe(1);
  });

  it("cover aspect follows the book format; the cover is decorative", () => {
    expect(html).toMatch(/aria-hidden="true"[^>]*data-testid="book-cover"[^>]*data-format="A5_PORTRAIT"[^>]*aspect-\[148\/210\]/);
    expect(html).toMatch(/data-format="A5_LANDSCAPE"[^>]*aspect-\[210\/148\]/);
  });

  it("placeholder differs per design style", () => {
    const classic = renderToStaticMarkup(<BookCover url={null} format="A5_PORTRAIT" designStyle="classic" />);
    const modern = renderToStaticMarkup(<BookCover url={null} format="A5_PORTRAIT" designStyle="modern" />);
    expect(classic).toContain("outline");
    expect(modern).not.toContain("outline");
    expect(classic).not.toContain("<img");
  });

  it("title keeps dir=auto; chips use status tokens, not raw palette colours", () => {
    expect(html).toMatch(/<p dir="auto"[^>]*>عطلتنا في العين<\/p>/);
    expect(html).toMatch(/bg-success-soft[^"]*"[^>]*data-testid="book-publish-chip"/);
    expect(html).toContain("bg-info-soft");
    expect(html).not.toMatch(/(emerald|amber)-\d/);
  });

  it("Share and ⋯ are ≥ 44 px targets outside the card link", () => {
    const tag = (id: string) => html.match(new RegExp(`<(?:a|button)[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
    expect(tag("book-share")).toContain("min-h-11");
    expect(tag("book-menu")).toContain("min-h-11 min-w-11");
    expect(html.match(/data-testid="book-share"/g)?.length).toBe(1);
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>)[\s\S])*<a /);
  });

  it("empty state uses the shared EmptyState with an accent call to action", () => {
    const empty = renderToStaticMarkup(<EmptyState />);
    expect(empty).toMatch(/<section[^>]*data-testid="dashboard-empty"/);
    expect(empty).toMatch(/<h2 dir="auto"[^>]*>No books yet<\/h2>/);
    expect(empty).toMatch(/bg-accent-strong[^"]*"[^>]*data-testid="create-first-book"[^>]*>Create your first book/);
  });

  it("page: heading testid kept, error as an error Notice", () => {
    const page = src("src/app/dashboard/page.tsx");
    expect(page).toContain('data-testid="dashboard-heading"');
    expect(page).toContain('<Notice tone="error" data-testid="dashboard-error">');
  });
});

describe("T9 New book form", () => {
  const html = renderToStaticMarkup(<NewBookForm />);

  it("groups fields under About the book / Look of the book, in that order", () => {
    const about = html.indexOf(">About the book<");
    const look = html.indexOf(">Look of the book<");
    expect(about).toBeGreaterThan(-1);
    expect(look).toBeGreaterThan(about);
    for (const id of ["occasion-wedding", "tone-minimal", "lang-en", "book-title"]) {
      const at = html.indexOf(`data-testid="${id}"`);
      expect(at, id).toBeGreaterThan(about);
      expect(at, id).toBeLessThan(look);
    }
    for (const id of ["format-A5_PORTRAIT", "style-classic"]) expect(html.indexOf(`data-testid="${id}"`)).toBeGreaterThan(look);
  });

  it("both design fieldsets point at the fixed-at-creation note", () => {
    const note = html.match(/<p id="([^"]+)"[^>]*>Set when the book is created/)?.[1];
    expect(note).toBeTruthy();
    expect(html.match(new RegExp(`<fieldset[^>]*aria-describedby="${note}`, "g"))?.length).toBe(2);
  });

  it("create-book is a sticky accent call to action", () => {
    expect(html).toMatch(/role="group" aria-label="Create book"[^>]*class="[^"]*sticky bottom-0/);
    const submit = html.match(/<button type="submit"[^>]*data-testid="create-book"[^>]*>Continue to photos</)?.[0] ?? "";
    expect(submit).toContain("bg-accent-strong");
    expect(submit).toContain("h-12 w-full");
  });

  it("page: step 1 progress and the D-063 copy", () => {
    const page = src("src/app/books/new/page.tsx");
    expect(page).toContain('<StepProgress current="new" />');
    expect(page).toContain("Page shape and style are set now. Everything else can change later.");
    expect(page).not.toContain("change most of this later");
  });
});

describe("T10 Upload", () => {
  const summary: QueueSummary = {
    total: 3,
    uploaded: 3,
    skipped: 0,
    failed: 0,
    notStarted: 0,
    pendingLeft: 0,
    skippedBy: {},
    cancelled: false,
    fatal: null,
  } as unknown as QueueSummary;

  it("idle: a large drop-zone style Choose photos area (≥ 120 px), no keep-open notice yet", () => {
    const html = renderToStaticMarkup(
      <Uploader bookId="b1" userId="u1" isPaid={false} existing={[]} maxUpload={150} readyCount={0} pendingCount={0} hasDoc={false} />,
    );
    const pick = html.match(/<button[^>]*data-testid="upload-pick"[^>]*>/)?.[0] ?? "";
    expect(pick).toContain("min-h-40"); // 160 px
    expect(pick).toContain("border-dashed");
    expect(pick).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toMatch(/data-testid="upload-pick"[\s\S]*Choose photos/);
    expect(html).toContain("Up to 150 photos in this book · 0 added");
    expect(html).not.toContain("upload-keep-open");
  });

  it("resume state is a warn Notice with the remove button", () => {
    const html = renderToStaticMarkup(
      <Uploader bookId="b1" userId="u1" isPaid={false} existing={[]} maxUpload={150} readyCount={2} pendingCount={1} hasDoc={false} />,
    );
    expect(html).toMatch(/data-tone="warn" data-testid="upload-resume"/);
    expect(html).toContain('data-testid="remove-unfinished"');
  });

  it("progress card no longer carries the keep-open line (the Uploader's info Notice does)", () => {
    const html = renderToStaticMarkup(
      <UploadProgress progress={{ type: "progress", done: 1, total: 3, uploaded: 1, skipped: 0, failed: 0 } as never} paused={false} onTogglePause={() => {}} />,
    );
    expect(html).not.toContain("Keep this screen open");
    expect(src("src/components/upload/Uploader.tsx")).toMatch(/<Notice tone="info" title="Keep this screen open"/);
  });

  it("summary: Build my album is the cta, Add more photos secondary, in a sticky next-step bar", () => {
    const html = renderToStaticMarkup(<UploadSummary bookId="b1" summary={summary} finalize={null} onAddMore={() => {}} />);
    expect(html).toMatch(/role="group" aria-label="Next step"[^>]*sticky/);
    const build = html.match(/<a[^>]*data-testid="build-album"[^>]*>/)?.[0] ?? "";
    expect(build).toContain('href="/books/b1/build"');
    expect(build).toContain("bg-accent-strong");
    expect(build).toContain("h-12 w-full");
    const more = html.match(/<button[^>]*data-testid="upload-add-more"[^>]*>/)?.[0] ?? "";
    expect(more).toContain("border-border bg-background"); // outline
    expect(more).toContain("h-11");
    expect(html.indexOf("build-album")).toBeLessThan(html.indexOf("upload-add-more"));
    expect(html).toMatch(/data-testid="summary-added">3 photos added</);
  });

  it("upload_done analytics still fires from the Uploader", () => {
    expect(src("src/components/upload/Uploader.tsx")).toContain('track("upload_done", { photos: s.uploaded, failed: s.failed, skipped: s.skipped });');
  });

  it("page: step 2 progress, occasion + title testids", () => {
    const page = src("src/app/books/[id]/upload/page.tsx");
    expect(page).toContain('<StepProgress current="photos" />');
    expect(page).toContain('data-testid="upload-occasion"');
    expect(page).toMatch(/<h1 dir="auto"[^>]*data-testid="upload-book-title"/);
  });
});

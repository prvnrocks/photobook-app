// M11 T8–T10 (D-067): dashboard cards, New book form and Upload screen take the app look.
// No DOM environment: markup via renderToStaticMarkup, page copy via the route source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/books/actions", () => ({
  createBookAction: vi.fn(),
  deleteUnfinishedAction: vi.fn(),
  updateBookSetupAction: vi.fn(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const { BookList } = await import("@/components/dashboard/BookList");
const { BookCover } = await import("@/components/dashboard/BookCover");
const { EmptyState } = await import("@/components/dashboard/EmptyState");
const { Uploader } = await import("@/components/upload/Uploader");
const { UploadSummary } = await import("@/components/upload/UploadSummary");
const { UploadProgress } = await import("@/components/upload/UploadProgress");
type BookListItem = import("@/lib/db/books").BookListItem;
type QueueSummary = import("@/lib/upload/queue").QueueSummary;
type UploaderProps = import("@/components/upload/Uploader").UploaderProps;

const uploaderProps: UploaderProps = {
  bookId: "b1",
  userId: "u1",
  isPaid: false,
  existing: [],
  maxUpload: 150,
  readyCount: 0,
  pendingCount: 0,
  hasDoc: false,
  firstRun: "none",
  dailyCap: 3,
};

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
    // M18: the title is the card's (stretched) link text, inside a card heading.
    expect(html).toMatch(/<h2[^>]*><a [^>]*data-testid="book-card"[^>]*><span class="line-clamp-2"><span dir="auto">عطلتنا في العين<\/span><\/span><\/a><\/h2>/);
    expect(html).toMatch(/bg-success-soft[^"]*"[^>]*data-testid="book-publish-chip"/);
    // Paid: gold on deep emerald (brand foil), exact text "Paid" (live specs assert it).
    expect(html).toMatch(/bg-primary text-accent-strong"[^>]*data-testid="book-paid-chip">Paid</);
    expect(html).not.toMatch(/(emerald|amber)-\d/);
  });

  it("quick actions and Options are ≥ 44 px targets outside the card link", () => {
    const tag = (id: string) => html.match(new RegExp(`<(?:a|button)[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
    expect(tag("book-share")).toContain("min-h-11");
    expect(tag("book-open")).toContain("min-h-11 min-w-11");
    expect(tag("book-card")).toContain("min-h-11");
    expect(tag("book-menu")).toContain("min-h-11 min-w-11");
    expect(html.match(/data-testid="book-share"/g)?.length).toBe(1);
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<a /);
  });

  it("empty state: emerald & gold shelf with the gold call to action into the wizard", () => {
    const empty = renderToStaticMarkup(<EmptyState />);
    expect(empty).toMatch(/<section[^>]*data-testid="dashboard-empty"/);
    expect(empty).toMatch(/<h2 dir="auto"[^>]*>No books yet<\/h2>/);
    // M19 (D-071): a plain link to the creation wizard (no photo picker, no "Choose style first").
    const cta = empty.match(/<a [^>]*data-testid="create-first-book"[^>]*>Make your first book<\/a>/)?.[0] ?? "";
    expect(cta).toContain('href="/books/new"');
    expect(cta).toContain("bg-accent-strong");
    expect(cta).toContain("h-12 w-full");
    expect(empty).not.toContain("empty-choose-style");
    expect(empty).not.toContain('type="file"');
  });

  it("empty state copy follows the wizard: name it → pick the style → add photos → we lay it out (M19)", () => {
    const empty = renderToStaticMarkup(<EmptyState />);
    const titles = [...empty.matchAll(/<span class="text-sm font-semibold text-heading">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(titles).toEqual(["Name it", "Pick the style", "Add your photos", "We lay it out"]);
    expect(empty).toContain("Name it, pick a style and add your photos");
    expect(empty).not.toContain("Choose your photos");
    expect(empty).toMatch(/<ol class="grid[^"]*sm:grid-cols-2/);
  });

  it("page: library header band keeps the heading testid + gold New book link, error as an error Notice", () => {
    const page = src("src/app/dashboard/page.tsx");
    expect(page).toContain("<LibraryHeader");
    expect(src("src/components/dashboard/LibraryHeader.tsx")).toContain('data-testid="dashboard-heading"');
    expect(page).toMatch(/<Link href="\/books\/new" className=\{buttonVariants\(\{ variant: "accent", size: "touch" \}\)\} data-testid="new-book">/);
    expect(page).not.toContain("StartPicker");
    expect(page).toContain('<Notice tone="error" data-testid="dashboard-error">');
  });
});

// T9's New book form became the M19 creation wizard (tests/m19-new-book-wizard.test.tsx).
describe("T9 New book page (M19 wizard)", () => {
  it("page: wizard shell with a client step header, signed-out → login, step-1 Back to the dashboard", () => {
    const page = src("src/app/books/new/page.tsx");
    expect(page).toContain("<WizardShell displayName={displayName}>");
    expect(page).toContain('redirect(`/login?next=${encodeURIComponent(next)}`)');
    expect(page).toContain('<Link href="/dashboard" className={WIZARD_BACK_CLASS} data-testid="wizard-back">');
    expect(page).not.toContain("NewBookForm");
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
    const html = renderToStaticMarkup(<Uploader {...uploaderProps} />);
    const pick = html.match(/<button[^>]*data-testid="upload-pick"[^>]*>/)?.[0] ?? "";
    expect(pick).toContain("min-h-40"); // 160 px
    expect(pick).toContain("border-dashed");
    expect(pick).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toMatch(/data-testid="upload-pick"[\s\S]*Choose photos/);
    expect(html).toContain("Up to 150 photos in this book · 0 added");
    expect(html).not.toContain("upload-keep-open");
  });

  it("resume state is a warn Notice with the remove button", () => {
    const html = renderToStaticMarkup(<Uploader {...uploaderProps} readyCount={2} pendingCount={1} />);
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

  it("summary fallback: Make my book now is the cta, Add more photos secondary, in a sticky next-step bar", () => {
    const html = renderToStaticMarkup(
      <UploadSummary bookId="b1" summary={summary} finalize={null} onAddMore={() => {}} next={{ kind: "build" }} />,
    );
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

  it("finalize retry countdown sits outside the role=alert notice (M11 review N8)", () => {
    const u = src("src/components/upload/Uploader.tsx");
    const notice = u.slice(u.indexOf('<Notice tone="error" data-testid="finalize-error">'));
    const close = notice.indexOf("</Notice>");
    expect(close).toBeGreaterThan(0);
    expect(notice.indexOf('data-testid="finalize-retry"')).toBeGreaterThan(close);
  });

  it("drag/drop: leave ignores moves onto the zone's children; stray window drops are swallowed and cleaned up (N9)", () => {
    const u = src("src/components/upload/Uploader.tsx");
    expect(u).toContain("onDragLeave={onDragLeave}");
    expect(u).toMatch(/e\.currentTarget\.contains\(to\)\) return;/);
    expect(u).toContain('window.addEventListener("dragover", onWindowDragOver);');
    expect(u).toContain('window.addEventListener("drop", onWindowDrop);');
    expect(u).toContain('window.removeEventListener("dragover", onWindowDragOver);');
    expect(u).toContain('window.removeEventListener("drop", onWindowDrop);');
    expect(u).toMatch(/if \(!hasFiles\(e\) \|\| e\.defaultPrevented\) return;/);
  });

  it("upload_done analytics still fires from the Uploader", () => {
    expect(src("src/components/upload/Uploader.tsx")).toContain('track("upload_done", { photos: s.uploaded, failed: s.failed, skipped: s.skipped });');
  });

  it("page: shared PageHeader with step 2, occasion + title testids", () => {
    const page = src("src/app/books/[id]/upload/page.tsx");
    expect(page).toContain("<PageHeader");
    expect(page).toContain('step="photos"');
    expect(page).toContain('eyebrowTestId="upload-occasion"');
    expect(page).toContain('titleTestId="upload-book-title"');
    expect(page).toContain("pb-0 sm:pt-6 sm:pb-6");
  });
});

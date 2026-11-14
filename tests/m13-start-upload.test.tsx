// M13 T5 + T6 (D-070): photos-first start + automatic first build (the setup card was removed in M19, D-071).
// Node environment: pure helpers directly, components via renderToStaticMarkup, pages via source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/books/actions", () => ({
  updateBookSetupAction: vi.fn(),
  deleteUnfinishedAction: vi.fn(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const { readImageSizeFromBytes, probeFormat } = await import("@/lib/upload/image-size");
const auto = await import("@/lib/upload/auto-build-client");
const { displayBookTitle, UNTITLED_BOOK_LABEL } = await import("@/lib/book/display-title");
const { UploadSummary } = await import("@/components/upload/UploadSummary");
const { Uploader } = await import("@/components/upload/Uploader");
const { EmptyState } = await import("@/components/dashboard/EmptyState");
const copy = await import("@/lib/marketing/copy");
type UploaderProps = import("@/components/upload/Uploader").UploaderProps;
type QueueSummary = import("@/lib/upload/queue").QueueSummary;

/** The opening tag carrying data-testid="id" (attribute order independent). */
const tag = (html: string, id: string) => html.match(new RegExp(`<[a-z]+ [^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const BOOK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

// --- fixtures ------------------------------------------------------------------------------------

/** Minimal JPEG: SOI, optional APP1 Exif (little-endian, IFD0 orientation), SOF0 w × h. */
function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
    const len = body.length + 2;
    parts.push(0xff, 0xe1, len >> 8, len & 0xff, ...body);
  }
  // APP0 JFIF filler before the frame
  parts.push(0xff, 0xe0, 0x00, 0x07, 0x4a, 0x46, 0x49, 0x46, 0x00);
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xff, 0xda, 0x00, 0x02);
  return new Uint8Array(parts);
}

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

const blob = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

// --- T5: page-shape hint from file headers -------------------------------------------------------

describe("image-size (start format hint)", () => {
  it("reads JPEG frame size and EXIF orientation", () => {
    expect(readImageSizeFromBytes(jpeg(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(readImageSizeFromBytes(jpeg(4000, 3000, 6))).toEqual({ width: 4000, height: 3000, exifOrientation: 6 });
  });

  it("reads PNG IHDR; anything else / truncated is null", () => {
    expect(readImageSizeFromBytes(png(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(readImageSizeFromBytes(new Uint8Array([0, 1, 2, 3, 4]))).toBeNull();
    expect(readImageSizeFromBytes(jpeg(4000, 3000).slice(0, 12))).toBeNull();
    // HEIC (ftyp box) → unknown
    expect(readImageSizeFromBytes(new TextEncoder().encode("\0\0\0\x18ftypheic\0\0\0\0mif1heic"))).toBeNull();
  });

  it("probeFormat: landscape majority → A5 landscape; EXIF-rotated → portrait; unreadable → undefined", async () => {
    const land = Array.from({ length: 5 }, () => blob(jpeg(4000, 3000)));
    expect(await probeFormat(land)).toBe("A5_LANDSCAPE");
    const rotated = Array.from({ length: 5 }, () => blob(jpeg(4000, 3000, 6)));
    expect(await probeFormat(rotated)).toBe("A5_PORTRAIT");
    expect(await probeFormat([blob(new Uint8Array([1, 2, 3]))])).toBeUndefined();
    expect(await probeFormat([])).toBeUndefined();
    // Unknowns count against landscape (60 % of ALL photos).
    const mixed = [...land.slice(0, 3), blob(new Uint8Array([1])), blob(new Uint8Array([1]))];
    expect(await probeFormat(mixed)).toBe("A5_LANDSCAPE");
    const mostlyUnknown = [...land.slice(0, 2), ...Array.from({ length: 3 }, () => blob(new Uint8Array([1])))];
    expect(await probeFormat(mostlyUnknown)).toBe("A5_PORTRAIT");
  });

  it("probeFormat gives up after the time box (portrait default on the server)", async () => {
    const slow = { slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }) } as unknown as Blob;
    expect(await probeFormat([slow], { timeoutMs: 5 })).toBeUndefined();
  });
});

// --- T6: automatic first build -------------------------------------------------------------------

describe("auto-build client", () => {
  const respond = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("POSTs { bookId, auto: true } and maps every answer", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ runId: RUN, mode: "replay", state: "queued", auto: true }), { status: 201 });
    };
    expect(await auto.requestAutoBuild(BOOK, { fetchImpl })).toEqual({ kind: "started", runId: RUN, mode: "replay", state: "queued" });
    expect(calls).toEqual([{ url: "/api/ai/runs", body: { bookId: BOOK, auto: true } }]);

    const cases: [number, unknown, unknown][] = [
      [409, { error: "not_first" }, { kind: "not_first" }],
      [409, { error: "not_ready" }, { kind: "not_ready" }],
      [409, { error: "user_edited" }, { kind: "user_edited" }],
      [409, { error: "already_running", runId: RUN }, { kind: "already_running", runId: RUN }],
      [409, { error: "already_running", runId: null }, { kind: "already_running", runId: null }],
      [429, { error: "limit", limit: "budget_exhausted" }, { kind: "limit", limit: "budget_exhausted" }],
      [429, { error: "limit", limit: "weird" }, { kind: "limit", limit: "daily_builds" }],
      [401, { error: "unauthenticated" }, { kind: "signed_out" }],
      [503, { error: "unavailable" }, { kind: "error" }],
      [422, { error: "unsupported_design" }, { kind: "error" }],
      [201, { runId: "nope" }, { kind: "error" }],
    ];
    for (const [status, body, want] of cases) {
      expect(await auto.requestAutoBuild(BOOK, { fetchImpl: respond(status, body) })).toEqual(want);
    }
    expect(await auto.requestAutoBuild(BOOK, { fetchImpl: async () => { throw new Error("offline"); } })).toEqual({ kind: "error" });
    expect(await auto.requestAutoBuild("not-a-uuid")).toEqual({ kind: "error" });
  });

  it("only asks for a fresh book whose upload settled with ≥ 5 photos", () => {
    const base = { firstRun: "none" as const, ready: 5, pendingLeft: 0, fatal: false, cancelled: false };
    expect(auto.shouldAutoStart(base)).toBe(true);
    expect(auto.shouldAutoStart({ ...base, ready: 4 })).toBe(false);
    expect(auto.shouldAutoStart({ ...base, pendingLeft: 1 })).toBe(false);
    expect(auto.shouldAutoStart({ ...base, firstRun: "done" })).toBe(false);
    expect(auto.shouldAutoStart({ ...base, firstRun: "active" })).toBe(false);
    expect(auto.shouldAutoStart({ ...base, fatal: true })).toBe(false);
    expect(auto.shouldAutoStart({ ...base, cancelled: true })).toBe(false);
  });

  it("maps answers to the next screen (auto=1 only for a run we started)", () => {
    const ctx = { retried: false, activeAtLoad: false };
    const next = (o: Parameters<typeof auto.autoStartNext>[1], c = ctx) => auto.autoStartNext(BOOK, o, c);
    expect(next({ kind: "started", runId: RUN, mode: "live", state: "queued" })).toEqual({ kind: "go", href: `/books/${BOOK}/build?auto=1` });
    expect(next({ kind: "started", runId: RUN, mode: "rule", state: "done" })).toEqual({
      kind: "go",
      href: `/books/${BOOK}/edit`,
      rules: { outcome: "ok" },
    });
    expect(next({ kind: "started", runId: RUN, mode: "rule", state: "failed" })).toMatchObject({ rules: { outcome: "failed" } });
    expect(next({ kind: "already_running", runId: RUN })).toEqual({ kind: "go", href: `/books/${BOOK}/build` });
    expect(next({ kind: "not_first" })).toEqual({ kind: "go", href: `/books/${BOOK}/edit` });
    expect(next({ kind: "not_first" }, { retried: false, activeAtLoad: true })).toEqual({ kind: "go", href: `/books/${BOOK}/build` });
    expect(next({ kind: "user_edited" })).toEqual({ kind: "go", href: `/books/${BOOK}/edit` });
    expect(next({ kind: "not_ready" })).toEqual({ kind: "retry" });
    expect(next({ kind: "not_ready" }, { retried: true, activeAtLoad: false })).toEqual({ kind: "fallback" });
    expect(next({ kind: "limit", limit: "daily_builds" })).toEqual({ kind: "fallback", limit: "daily_builds" });
    expect(next({ kind: "error" })).toEqual({ kind: "fallback" });
    expect(next({ kind: "signed_out" })).toEqual({ kind: "fallback" });
  });

  it("Uploader: no Build tap — auto start after finalize, ai_build_done{auto} for a finished rule run, analytics kept", () => {
    const u = src("src/components/upload/Uploader.tsx");
    expect(u).toContain('track("upload_done", { photos: s.uploaded, failed: s.failed, skipped: s.skipped });');
    expect(u).toMatch(/if \(settled\) await autoStart\(ready, s\);/);
    // M19 (D-071): the setup card is gone — nothing to flush before the auto start.
    expect(u).not.toContain("setupCtl");
    expect(u).toMatch(/track\("ai_build_done", \{\s*mode: "rules",[\s\S]*auto: true,/);
    expect(u).toContain("router.push(next.href);");
  });
});

describe("displayBookTitle (no more 'Untitled book' vs cover mismatch)", () => {
  it("user title, else the album's cover title (rule draft, AI or edited), else 'Your book'", () => {
    expect(displayBookTitle("  عطلتنا  ", null)).toBe("عطلتنا");
    expect(displayBookTitle(null, { meta: { generator: "ai" }, cover: { title: "Desert Days" } })).toBe("Desert Days");
    expect(displayBookTitle(null, { meta: { generator: "rule", userEdited: true }, cover: { title: "Ours" } })).toBe("Ours");
    // M13 polish: the rule draft's cover title is what the book shows — the chrome uses it too.
    expect(displayBookTitle(null, { meta: { generator: "rule" }, cover: { title: "Our Photobook" } })).toBe("Our Photobook");
    expect(displayBookTitle("Trip", { meta: { generator: "ai" }, cover: { title: "Desert Days" } })).toBe("Trip");
    // No album yet (books.doc is '{}' or has no generator) → neutral label.
    expect(displayBookTitle(null, { cover: { title: "Stray" } })).toBe(UNTITLED_BOOK_LABEL);
    expect(displayBookTitle(null, { meta: { generator: "ai" }, cover: { title: "  " } })).toBe(UNTITLED_BOOK_LABEL);
    expect(displayBookTitle("", {})).toBe("Your book");
  });
});

// --- Markup --------------------------------------------------------------------------------------

// M19 (D-071): the photos-first StartPicker is gone — every entry point opens the creation wizard.
describe("dashboard / start page", () => {
  it("empty state: a plain link to the wizard (no file input)", () => {
    const html = renderToStaticMarkup(<EmptyState />);
    expect(html).not.toContain('type="file"');
    expect(html).toMatch(/data-testid="create-first-book" href="\/books\/new"/);
  });

  it("start page (M19, D-071): redirects to /books/new; signed-out → login with next=/books/new", () => {
    const page = src("src/app/books/start/page.tsx");
    expect(page).toContain('redirect("/login?next=%2Fbooks%2Fnew")');
    expect(page).toContain('redirect("/books/new")');
  });

  it("landing CTA goes to login → /books/new (M19, D-071)", () => {
    expect(copy.CTA_HREF).toBe("/login?next=%2Fbooks%2Fnew");
    expect(copy.CTA_LABEL).toBe("Make my book");
  });
});

describe("UploadSummary next step + Uploader", () => {
  const summary = {
    total: 6, uploaded: 6, skipped: 0, failed: 0, notStarted: 0, pendingLeft: 0, skippedBy: {}, cancelled: false, fatal: null,
  } as unknown as QueueSummary;
  const render = (next: Parameters<typeof UploadSummary>[0]["next"]) =>
    renderToStaticMarkup(<UploadSummary bookId="b1" summary={summary} finalize={null} onAddMore={() => {}} next={next} />);

  it("starting: a polite status, no Build tap and no Add more", () => {
    const html = render({ kind: "starting" });
    expect(html).toMatch(/role="status"[^>]*data-testid="upload-auto-starting"/);
    expect(html).toContain("Starting your book…");
    expect(html).not.toContain("build-album");
    expect(html).not.toContain("upload-add-more");
  });

  it("fallback: Make my book now (build-album) with the reason; continue for built books", () => {
    const fb = render({ kind: "build", note: "You've used today's 3 free AI builds — try again tomorrow." });
    expect(fb).toMatch(/data-testid="upload-auto-fallback"[\s\S]*today&#x27;s 3 free AI builds/);
    expect(tag(fb, "build-album")).toContain('href="/books/b1/build"');
    expect(fb).toMatch(/data-testid="build-album"[^>]*>Make my book now/);
    const cont = render({ kind: "continue", href: "/books/b1/review", label: "Add them to your book" });
    expect(tag(cont, "upload-continue")).toContain('href="/books/b1/review"');
    expect(cont).toMatch(/data-testid="upload-continue"[^>]*>Add them to your book/);
    expect(cont).toContain("upload-add-more");
  });

  const props: UploaderProps = {
    bookId: "b1", userId: "u1", isPaid: false, existing: [], maxUpload: 150, readyCount: 0, pendingCount: 0, hasDoc: false,
    firstRun: "none", dailyCap: 3,
  };

  it("fresh book: picker, no setup card (M19: setup = wizard steps 1–4); built book: continue", () => {
    const fresh = renderToStaticMarkup(<Uploader {...props} />);
    expect(fresh).toContain('data-testid="upload-pick"');
    expect(fresh).not.toContain('data-testid="setup-card"');
    const built = renderToStaticMarkup(<Uploader {...props} firstRun="done" readyCount={8} />);
    expect(built).not.toContain('data-testid="setup-card"');
    expect(tag(built, "upload-continue")).toContain('href="/books/b1/edit"');
  });

  it("return visit with photos and no build: Make my book now; active build: watch it", () => {
    const back = renderToStaticMarkup(<Uploader {...props} readyCount={7} />);
    expect(tag(back, "build-album")).toContain('href="/books/b1/build"');
    const active = renderToStaticMarkup(<Uploader {...props} firstRun="active" readyCount={7} />);
    expect(tag(active, "upload-continue")).toContain('href="/books/b1/build"');
    expect(active).toMatch(/data-testid="upload-continue"[^>]*>See your book being made/);
  });

  it("upload page: consistent title, wizard rule from the server, auto start context", () => {
    const page = src("src/app/books/[id]/upload/page.tsx");
    expect(page).toContain("const title = displayBookTitle(book.title, book.doc);");
    expect(page).toContain("title={title}");
    expect(page).not.toContain("Untitled book");
    expect(page).toContain("isWizardUpload(firstRun, detailsLockReason({ hasRun, doc: book.doc }))");
    expect(page).toContain('const firstRun: FirstRunState = active ? "active" : hasRun ? "done" : "none";');
  });
});

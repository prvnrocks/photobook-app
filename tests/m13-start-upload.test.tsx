// M13 T5 + T6 (D-070): photos-first start + upload screen setup card and automatic first build.
// Node environment: pure helpers directly, components via renderToStaticMarkup, pages via source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/books/actions", () => ({
  startBookAction: vi.fn(),
  updateBookSetupAction: vi.fn(),
  deleteUnfinishedAction: vi.fn(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const { readImageSizeFromBytes, probeFormat } = await import("@/lib/upload/image-size");
const pending = await import("@/components/upload/pending-files");
const auto = await import("@/lib/upload/auto-build-client");
const setupUi = await import("@/lib/upload/setup-ui");
const { displayBookTitle, UNTITLED_BOOK_LABEL } = await import("@/lib/book/display-title");
const { StartPicker } = await import("@/components/upload/StartPicker");
const { SetupCard } = await import("@/components/upload/SetupCard");
const { UploadSummary } = await import("@/components/upload/UploadSummary");
const { Uploader } = await import("@/components/upload/Uploader");
const { EmptyState } = await import("@/components/dashboard/EmptyState");
const copy = await import("@/lib/marketing/copy");
type BookSetup = import("@/lib/book/setup").BookSetup;
type UploaderProps = import("@/components/upload/Uploader").UploaderProps;
type BookSetupController = import("@/components/upload/use-book-setup").BookSetupController;
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

const SETUP: BookSetup = {
  occasion: "other",
  tone: "minimal",
  captionLang: "en",
  title: null,
  format: "A5_PORTRAIT",
  designStyle: "modern",
};

function controller(over: Partial<BookSetupController> = {}): BookSetupController {
  const noop = () => {};
  return {
    setup: SETUP,
    titleDraft: "",
    titleError: null,
    locks: { details: null, design: null },
    status: { kind: "idle" },
    frozen: false,
    setOccasion: noop,
    setTone: noop,
    setCaptionLang: noop,
    setFormat: noop,
    setStyle: noop,
    setTitle: noop,
    flush: async () => {},
    freeze: noop,
    unfreeze: noop,
    ...over,
  } as BookSetupController;
}

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

// --- T5: in-memory hand-off ----------------------------------------------------------------------

describe("pending-files store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const file = (name: string) => new File([new Uint8Array([1])], name, { type: "image/jpeg" });

  it("is a no-op on the server (no window)", () => {
    pending.stashPendingFiles(BOOK, { files: [file("a.jpg")] });
    expect(pending.takePendingFiles(BOOK)).toBeNull();
    expect(pending.hasPendingFiles(BOOK)).toBe(false);
  });

  it("hands the files over once, for that book only", () => {
    vi.stubGlobal("window", {});
    const files = [file("a.jpg"), file("b.jpg")];
    pending.stashPendingFiles(BOOK, { files, suggestedFormat: "A5_LANDSCAPE" }, 1000);
    expect(pending.hasPendingFiles("other", 1000)).toBe(false);
    expect(pending.hasPendingFiles(BOOK, 1000)).toBe(true);
    const got = pending.takePendingFiles(BOOK, 1001);
    expect(got?.files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(got?.suggestedFormat).toBe("A5_LANDSCAPE");
    expect(pending.takePendingFiles(BOOK, 1002)).toBeNull();
  });

  it("drops stale hand-offs and replaces an older book's", () => {
    vi.stubGlobal("window", {});
    pending.stashPendingFiles(BOOK, { files: [file("a.jpg")] }, 0);
    expect(pending.takePendingFiles(BOOK, pending.PENDING_MAX_AGE_MS + 1)).toBeNull();
    pending.stashPendingFiles("first", { files: [file("a.jpg")] }, 0);
    pending.stashPendingFiles(BOOK, { files: [file("b.jpg")] }, 0);
    expect(pending.takePendingFiles("first", 1)).toBeNull();
    expect(pending.takePendingFiles(BOOK, 1)?.files).toHaveLength(1);
    pending.stashPendingFiles(BOOK, { files: [] }, 0);
    expect(pending.hasPendingFiles(BOOK, 0)).toBe(false);
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
    expect(u).toContain("await setupCtl.flush();");
    expect(u).toMatch(/track\("ai_build_done", \{\s*mode: "rules",[\s\S]*auto: true,/);
    expect(u).toContain("router.push(next.href);");
  });
});

// --- T6: setup card rules ------------------------------------------------------------------------

describe("setup-ui", () => {
  it("feel and style follow the occasion until picked; locked design is never sent", () => {
    const follow = setupUi.initialFollow(SETUP);
    expect(follow).toEqual({ manualTone: false, manualStyle: false });
    const open = { details: null, design: null };
    expect(setupUi.occasionPatch("travel", follow, open)).toEqual({ occasion: "travel", tone: "fun", designStyle: "geometric" });
    expect(setupUi.occasionPatch("wedding", { manualTone: true, manualStyle: false }, open)).toEqual({ occasion: "wedding", designStyle: "modern" });
    expect(setupUi.occasionPatch("baby", follow, { details: null, design: "user_edited" })).toEqual({ occasion: "baby", tone: "nostalgic" });
    // A remembered tone / earlier style pick counts as picked.
    expect(setupUi.initialFollow({ ...SETUP, tone: "romantic", designStyle: "classic" })).toEqual({ manualTone: true, manualStyle: true });
  });

  it("withoutDesign / hasFields / summary", () => {
    expect(setupUi.withoutDesign({ occasion: "baby", format: "A5_LANDSCAPE", designStyle: "classic" })).toEqual({ occasion: "baby" });
    expect(setupUi.hasFields({})).toBe(false);
    expect(setupUi.hasFields({ title: null })).toBe(true);
    expect(setupUi.setupSummary(SETUP)).toBe("Modern style · Portrait · English captions · Minimal feel");
    expect(setupUi.setupSummary({ ...SETUP, captionLang: "ar", format: "A5_LANDSCAPE" })).toContain("Landscape · Arabic captions");
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

describe("StartPicker / dashboard / start page", () => {
  it("hero: the whole card is the file input's label (iOS opens the picker from a direct tap)", () => {
    const html = renderToStaticMarkup(<StartPicker variant="hero" testId="start-pick" />);
    expect(html).toMatch(/^<div[^>]*><label[^>]*data-testid="start-pick"/);
    expect(html).toMatch(/<label[^>]*min-h-56[\s\S]*<input type="file" multiple="" accept="image\/\*,\.heic,\.heif" class="sr-only" data-testid="start-pick-input"\/>/);
    expect(html).toContain("has-focus-visible:ring-2");
    expect(html).toContain("Choose photos");
    expect(html).not.toContain('tabindex="-1"');
  });

  it("dashboard button keeps the new-book testid at 44 px", () => {
    const html = renderToStaticMarkup(<StartPicker variant="button" testId="new-book" />);
    expect(html).toMatch(/<label[^>]*h-11[^>]*data-testid="new-book"/);
    expect(html).toContain('data-testid="new-book-input"');
    expect(html).toContain("New book");
  });

  it("empty state: picker cta + Choose style first", () => {
    const html = renderToStaticMarkup(<EmptyState />);
    expect(html).toContain('data-testid="create-first-book-input"');
    expect(html).toContain('href="/books/new"');
  });

  it("start page: signed-out → login with next=/books/start; Choose style first link", () => {
    const page = src("src/app/books/start/page.tsx");
    expect(page).toContain('redirect("/login?next=%2Fbooks%2Fstart")');
    expect(page).toContain('<StartPicker variant="hero" testId="start-pick" />');
    expect(page).toContain('href="/books/new"');
    expect(page).toContain('data-testid="start-choose-style"');
    const picker = src("src/components/upload/StartPicker.tsx");
    expect(picker).toContain('export const START_LOGIN_HREF = "/login?next=%2Fbooks%2Fstart";');
    expect(picker).toMatch(/stashPendingFiles\(res\.bookId[\s\S]*router\.push\(res\.next\)/);
  });

  it("landing CTA goes to login → /books/start", () => {
    expect(copy.CTA_HREF).toBe("/login?next=%2Fbooks%2Fstart");
    expect(copy.CTA_LABEL).toBe("Make your book");
  });
});

describe("SetupCard", () => {
  it("occasion chips (Other checked), summary, Change disclosure collapsed", () => {
    const html = renderToStaticMarkup(<SetupCard controller={controller()} />);
    expect(html).toContain("What&#x27;s this book for?");
    for (const id of ["wedding", "travel", "baby", "graduation", "family", "other"]) {
      expect(html).toContain(`data-testid="setup-occasion-${id}"`);
    }
    expect(tag(html, "setup-occasion-other")).toContain('checked=""');
    expect(tag(html, "setup-occasion-wedding")).not.toContain("checked");
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+"[^>]*data-testid="setup-change"/);
    expect(html).toMatch(/<div id="[^"]+" hidden=""[^>]*data-testid="setup-panel"/);
    expect(html).toContain("Modern style · Portrait · English captions · Minimal feel");
    expect(html).toContain("Title: we&#x27;ll suggest one");
    // title input is dir=auto (Arabic titles); Arabic chip label renders RTL in the Arabic font
    expect(html).toMatch(/<input id="[^"]+" type="text" dir="auto"[^>]*data-testid="setup-title"/);
    expect(html).toMatch(/<span lang="ar" dir="rtl" class="font-arabic">العربية<\/span>/);
    for (const m of html.match(/<label class="relative inline-flex[^"]*"/g) ?? []) expect(m).toContain("min-h-11");
  });

  it("selection snaps: radio chips / cards / segments have no colour transition (ring and fill change together)", () => {
    const html = renderToStaticMarkup(<SetupCard controller={controller()} />);
    const labels = html.match(/<label class="relative [^"]*"/g) ?? [];
    expect(labels.length).toBeGreaterThan(10);
    for (const l of labels) expect(l).not.toContain("transition");
    expect(html).toMatch(/class="[^"]*transition-transform motion-reduce:transition-none[^"]*"/);
    expect(renderToStaticMarkup(<SetupCard controller={controller()} aiOn={false} />)).toContain("Title: Our Photobook");
  });

  it("suggested shape hint; locked states say why", () => {
    const hinted = renderToStaticMarkup(<SetupCard controller={controller()} suggestedFormat="A5_LANDSCAPE" />);
    expect(hinted).toContain("Suggested for your photos");
    const started = renderToStaticMarkup(<SetupCard controller={controller({ locks: { details: "ai_started", design: "ai_started" } })} />);
    expect(started).toMatch(/data-locked="ai_started"/);
    expect(started).toContain('data-testid="setup-locked"');
    expect(started.match(/<fieldset[^>]*disabled=""/g)?.length).toBe(5);
    const edited = renderToStaticMarkup(<SetupCard controller={controller({ locks: { details: null, design: "user_edited" } })} />);
    expect(edited).toContain('data-testid="setup-design-locked"');
    expect(edited.match(/<fieldset[^>]*disabled=""/g)?.length).toBe(2);
    const frozen = renderToStaticMarkup(<SetupCard controller={controller({ frozen: true })} />);
    expect(frozen).toContain('data-testid="setup-locked"');
  });

  it("status line is polite: saving / saved / error", () => {
    expect(renderToStaticMarkup(<SetupCard controller={controller({ status: { kind: "saving" } })} />)).toMatch(/aria-live="polite"[^>]*data-testid="setup-status">Saving…/);
    expect(renderToStaticMarkup(<SetupCard controller={controller({ status: { kind: "error", message: "Nope" } })} />)).toContain('data-testid="setup-error">Nope');
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
    setup: SETUP, locks: { details: null, design: null }, firstRun: "none", dailyCap: 3,
  };

  it("fresh book: picker + setup card; built book: no setup card", () => {
    const fresh = renderToStaticMarkup(<Uploader {...props} />);
    expect(fresh).toContain('data-testid="upload-pick"');
    expect(fresh).toContain('data-testid="setup-card"');
    const built = renderToStaticMarkup(<Uploader {...props} firstRun="done" locks={{ details: "ai_started", design: "ai_started" }} readyCount={8} />);
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

  it("upload page: consistent title, setup + locks from the server, auto start context", () => {
    const page = src("src/app/books/[id]/upload/page.tsx");
    expect(page).toContain("title={displayBookTitle(book.title, book.doc)}");
    expect(page).not.toContain("Untitled book");
    expect(page).toContain("designLockReason({ hasRun, doc: book.doc })");
    expect(page).toContain('const firstRun: FirstRunState = active ? "active" : hasRun ? "done" : "none";');
  });
});

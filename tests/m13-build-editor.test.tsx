// M13 T7 (D-070 (3)): build screen shows the draft book, then goes straight to the editor; the
// editor's "AI kept X of Y · See left out" chip links to review. Static renders + pure helpers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }) }));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

const { BuildProgress } = await import("@/components/review/BuildProgress");
const { BuildDraftPreview } = await import("@/components/review/BuildDraftPreview");
const { AiSummaryChip, AiSummaryChipView } = await import("@/components/editor/AiSummaryChip");
const { EditorShell } = await import("@/components/editor/EditorShell");
const { devEditorData, devTransport } = await import("@/lib/editor/dev-fixture");
const { devPreviewDoc, devPreviewPhotos } = await import("@/lib/book/dev-preview");
const {
  aiSummary,
  aiSummaryDismissed,
  aiSummaryDismissKey,
  dismissAiSummary,
  resetAiSummaryMemoryForTests,
} = await import("@/lib/editor/ai-summary");
const { DRAFT_PREVIEW_PAGES, draftPreviewItems, draftPreviewPhotoIds, draftPreviewPhotos } = await import(
  "@/lib/runs/draft-preview"
);

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("draft preview helpers", () => {
  const doc = devPreviewDoc();

  it("cover first, then at most DRAFT_PREVIEW_PAGES pages in order", () => {
    const items = draftPreviewItems(doc);
    expect(items[0]).toBe("cover");
    expect(items.slice(1)).toEqual(Array.from({ length: Math.min(doc.pages.length, DRAFT_PREVIEW_PAGES) }, (_, i) => i));
    expect(draftPreviewItems(doc, 2)).toEqual(["cover", 0, 1]);
    expect(draftPreviewItems({ ...doc, pages: [] })).toEqual(["cover"]);
  });

  it("collects only the shown pages' photos (+ cover, backgrounds)", () => {
    const items = draftPreviewItems(doc, 1);
    const ids = draftPreviewPhotoIds(doc, items);
    const page0 = doc.pages[0].slots.map((s) => s.photoId).filter(Boolean);
    for (const id of page0) expect(ids).toContain(id);
    if (doc.cover.photoId) expect(ids).toContain(doc.cover.photoId);
    const later = doc.pages.slice(1).flatMap((p) => p.slots.map((s) => s.photoId)).filter((id): id is string => !!id && !page0.includes(id) && id !== doc.cover.photoId);
    for (const id of later) expect(ids).not.toContain(id);
  });

  it("maps thumbs for wanted ids only and skips unsigned photos", () => {
    const out = draftPreviewPhotos(["a", "b"], [
      { id: "a", thumbUrl: "https://x.test/a", width: 4, height: 3 },
      { id: "b", thumbUrl: null, width: 4, height: 3 },
      { id: "c", thumbUrl: "https://x.test/c", width: 4, height: 3 },
    ]);
    expect(out).toEqual({ a: { url: "https://x.test/a", width: 4, height: 3 } });
  });
});

describe("BuildDraftPreview", () => {
  it("renders the shared BookPage (view mode) per item, read-only, with book fonts", () => {
    const doc = devPreviewDoc();
    const items = draftPreviewItems(doc, 3);
    const html = renderToStaticMarkup(<BuildDraftPreview doc={doc} items={items} photos={devPreviewPhotos()} captionLang="en" />);
    expect(html).toContain('data-testid="build-draft"');
    expect(count(html, 'data-testid="build-draft-page"')).toBe(4);
    expect(html).toContain('data-mode="view"');
    expect(html).toContain("data-book-fonts");
    expect(html).toContain(">Cover<");
    expect(html).toContain(">Page 3<");
    expect(html).not.toContain("<button");
    // Scrollable strip is keyboard reachable with a visible focus ring; never page-wide overflow.
    expect(html).toMatch(/<ol tabindex="0"[^>]*focus-visible:ring-2[^>]*overflow-x-auto|<ol tabindex="0"[^>]*overflow-x-auto[^>]*focus-visible:ring-2/);
  });
});

describe("BuildProgress (T7)", () => {
  const base = { bookId: "b1", activeRunId: null, trigger: "build" as const, isPaid: false, dailyCap: 3 };

  it("with a draft: preview + AI note + compact checklist, testids kept", () => {
    const html = renderToStaticMarkup(<BuildProgress {...base} preview={<div data-testid="draft-slot" />} />);
    for (const id of ["build-progress", "build-stage", "build-bar", "build-checklist", "build-ai-note", "draft-slot"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("AI is choosing your best photos and writing captions…");
    expect(html).toContain('data-compact="true"');
    expect(html.indexOf("draft-slot")).toBeLessThan(html.indexOf('data-testid="build-checklist"'));
  });

  it("without a draft: checklist only (full-size rows)", () => {
    const html = renderToStaticMarkup(<BuildProgress {...base} />);
    expect(html).toContain('data-testid="build-checklist"');
    expect(html).not.toContain('data-testid="build-ai-note"');
    expect(html).not.toContain("data-compact");
    expect(html).toContain("min-h-11");
  });

  it("finishes into the editor (not review); stop states link to the editor; ai_build_done carries auto", () => {
    const s = src("src/components/review/BuildProgress.tsx");
    expect(s).toContain("const editorHref = `/books/${bookId}/edit`;");
    expect(s).toContain("router.replace(editorHref)");
    expect(s).not.toMatch(/\/review`/);
    expect(s).not.toContain("build-to-review");
    expect(count(s, 'data-testid="build-to-editor"')).toBe(3);
    expect(s).toMatch(/track\("ai_build_done", \{ mode, outcome, ms_bucket: msBucket\(Date\.now\(\) - mountedAt\), auto \}\)/);
  });

  it("build page: ?auto=1 passes auto, a finished auto run opens the editor, draft from books.doc", () => {
    const s = src("src/app/books/[id]/build/page.tsx");
    expect(s).toContain('const auto = query.auto === "1";');
    // Review fix: redirect only on a confirmed "no run"; a read error renders BuildProgress.
    expect(s).toContain("if (auto && activeRead.ok && !active) redirect(`/books/${book.id}/edit`);");
    expect(s).not.toContain("getActiveRunForBook(book.id).catch(() => null)");
    expect(s).toContain("auto={auto}");
    expect(s).toContain("aiOn={aiOn}");
    expect(s).toContain("preview={preview}");
    // Only the preview's photos are loaded + signed.
    expect(s).toContain("listReviewPhotos(book.id, wanted).catch(() => null)");
  });
});

describe("aiSummary", () => {
  const ph = (kept: number, dropped: number) => [
    ...Array.from({ length: kept }, () => ({ status: "kept" as const })),
    ...Array.from({ length: dropped }, () => ({ status: "dropped" as const })),
  ];

  it("AI album: 'AI kept X of Y · See N left out'", () => {
    expect(aiSummary("ai", ph(34, 6))).toMatchObject({ label: "AI kept 34 of 40 photos", linkText: "See 6 left out", kept: 34, total: 40 });
    expect(aiSummary("ai", ph(12, 0))).toMatchObject({ label: "AI kept 12 of 12 photos", linkText: "See all photos" });
  });

  it("M13 polish: the total is the photos added (copies skipped at upload) — the detail says so", () => {
    const s = aiSummary("ai", ph(33, 5))!;
    expect(s.label).toBe("AI kept 33 of 38 photos");
    expect(s.detail).toBe("38 photos were added to this book (copies of the same photo are added once). AI left 5 out — tap to see them and change it.");
    expect(aiSummary("rule", ph(0, 1))!.detail).toContain("1 photo was added");
    expect(aiSummary("ai", ph(3, 0))!.detail).toContain("AI left none out");
  });

  it("rule album: no AI claim, only when photos were left out", () => {
    expect(aiSummary("rule", ph(8, 2))).toMatchObject({ label: "8 of 10 photos in your book", linkText: "See 2 left out" });
    expect(aiSummary(undefined, ph(8, 2))).toMatchObject({ label: "8 of 10 photos in your book" });
    expect(aiSummary("rule", ph(10, 0))).toBeNull();
    expect(aiSummary("ai", [])).toBeNull();
  });

  it("dismissal is per book and survives missing / throwing storage", () => {
    resetAiSummaryMemoryForTests();
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(aiSummaryDismissed("b1", store)).toBe(false);
    dismissAiSummary("b1", store);
    expect(mem.get(aiSummaryDismissKey("b1"))).toBe("1");
    resetAiSummaryMemoryForTests();
    expect(aiSummaryDismissed("b1", store)).toBe(true);
    expect(aiSummaryDismissed("b2", store)).toBe(false);

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(aiSummaryDismissed("b3", broken)).toBe(false);
    expect(() => dismissAiSummary("b3", broken)).not.toThrow();
    expect(aiSummaryDismissed("b3", broken)).toBe(true); // in-memory for this session
    expect(aiSummaryDismissed("b4", null)).toBe(false);
  });
});

describe("AiSummaryChip", () => {
  beforeEach(() => resetAiSummaryMemoryForTests());
  const summary = { label: "AI kept 34 of 40 photos", linkText: "See 6 left out", kept: 34, total: 40, detail: "40 photos were added to this book." };

  it("links to the review screen; 44 px link + dismiss with visible focus", () => {
    const html = renderToStaticMarkup(<AiSummaryChipView bookId="b1" summary={summary} onDismiss={() => {}} />);
    expect(html).toContain('data-testid="ai-summary-chip"');
    expect(html).toMatch(/<a [^>]*href="\/books\/b1\/review"[^>]*data-testid="ai-summary-link"|<a [^>]*data-testid="ai-summary-link"[^>]*href="\/books\/b1\/review"/);
    expect(html).toContain("AI kept 34 of 40 photos");
    expect(html).toContain("See 6 left out");
    // What the total counts: title for pointer users, sr-only for screen readers; 2 lines max, never cut.
    expect(html).toContain('title="40 photos were added to this book."');
    expect(html).toContain('<span class="sr-only">. 40 photos were added to this book.</span>');
    expect(html).toContain("line-clamp-2");
    expect(html).toMatch(/class="flex min-h-11[^"]*focus-visible:ring-2/);
    expect(html).toMatch(/aria-label="Hide photo summary" class="flex size-11[^"]*focus-visible:ring-2/);
  });

  it("hidden when read-only or there is nothing to report", () => {
    expect(renderToStaticMarkup(<AiSummaryChip bookId="b1" summary={summary} readOnly />)).toBe("");
    expect(renderToStaticMarkup(<AiSummaryChip bookId="b1" summary={null} readOnly={false} />)).toBe("");
    expect(renderToStaticMarkup(<AiSummaryChip bookId="b1" summary={summary} readOnly={false} />)).toContain("ai-summary-chip");
  });

  it("EditorShell shows it under the header only when the page passes a summary; hidden read-only", () => {
    const shell = (data = devEditorData("ok"), s: typeof summary | null = summary) =>
      renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} aiSummary={s} />);
    expect(shell()).toContain('data-testid="ai-summary-chip"');
    expect(shell(devEditorData("ok"), null)).not.toContain("ai-summary-chip");
    expect(renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} />)).not.toContain("ai-summary-chip");
    expect(shell(devEditorData("readonly"))).not.toContain("ai-summary-chip");
  });

  it("edit page computes the summary from photo status + doc generator", () => {
    const s = src("src/app/books/[id]/edit/page.tsx");
    expect(s).toContain("aiSummary(shell.doc.meta?.generator, shell.photos)");
    expect(s).toContain("aiSummary={summary}");
  });
});

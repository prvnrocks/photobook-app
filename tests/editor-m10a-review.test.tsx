// M10a review fixes (frontend): server render of the editor before the width is known (N7),
// toolbar sizing at 375 px, toast placement above an open panel.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EditorShell } from "@/components/editor/EditorShell";
import { toastBottomAbovePanel } from "@/components/editor/EditorToast";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

const render = (layout?: "single" | "spread") =>
  renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} layout={layout} />);

describe("editor server render before the width is known (N7)", () => {
  it("phones get the real single-page carousel; md+ hides it behind a spread-shaped placeholder", () => {
    const html = render();
    expect(html).toMatch(/class="flex min-h-0 flex-1 flex-col md:hidden" data-testid="single-carousel-wrap"/);
    expect(html).toContain('data-mode="single"');
    expect(html).toMatch(/<div class="[^"]*\bhidden md:flex\b[^"]*" aria-hidden="true" data-testid="spread-placeholder"/);
    // Cover first → the placeholder shows the cover alone with the page counter of spread mode.
    expect(html).toContain("aspect-[148/210]");
    // lg strip: same width as the spread strip, no single-mode strip yet.
    expect(html).toContain("hidden w-44 shrink-0 border-r border-border bg-muted/40 lg:block");
    expect(html).not.toContain('data-testid="page-strip"');
  });

  it("a forced layout renders that mode straight away (no placeholder)", () => {
    const spread = render("spread");
    expect(spread).toContain('data-mode="spread"');
    expect(spread).not.toContain("spread-placeholder");
    expect(spread).not.toContain("md:hidden\" data-testid=\"single-carousel-wrap\"");
    const single = render("single");
    expect(single).toContain('data-mode="single"');
    expect(single).not.toContain("spread-placeholder");
    expect(single).toContain('data-testid="page-strip"');
  });
});

describe("toolbar at 375 px", () => {
  it("M13: ≤ 4 equal buttons (3 primary + More), ≥ 44 px, no sideways scroll or fade edges", () => {
    const html = render();
    const row = html.match(/<div[^>]*data-testid="editor-toolbar-row"[^>]*>/)?.[0] ?? "";
    expect(row).not.toContain("overflow-x-auto");
    expect(Number(row.match(/data-count="(\d+)"/)?.[1])).toBeLessThanOrEqual(4);
    const btn = html.match(/<button[^>]*data-testid="editor-tool-background"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(btn).toContain("Background");
    expect(btn).toMatch(/min-h-14 min-w-11 max-w-40 flex-1 basis-0/);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*data-testid="editor-more"/);
    expect(html).not.toContain('data-testid="toolbar-fade-start"');
    expect(html).not.toContain('data-testid="toolbar-fade-end"');
  });
});

describe("toast above an open panel", () => {
  it("phone + panel → just above the panel's top edge; no panel or side panel → default spot", () => {
    expect(toastBottomAbovePanel(500, 812, false)).toBe(312 + 8);
    expect(toastBottomAbovePanel(900, 812, false)).toBe(8);
    expect(toastBottomAbovePanel(null, 812, false)).toBeNull();
    expect(toastBottomAbovePanel(500, 812, true)).toBeNull();
    expect(toastBottomAbovePanel(Number.NaN, 812, false)).toBeNull();
  });
});

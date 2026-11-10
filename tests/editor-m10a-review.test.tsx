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
    expect(html).toContain("hidden w-44 shrink-0 border-r bg-muted/30 lg:block");
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
  it("buttons size to the label (11 px, tight, 44–72 px) on phones, no truncation; fade edges for scrolling", () => {
    const html = render();
    const btn = html.match(/<button[^>]*data-testid="editor-tool-background"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(btn).toContain("Background");
    expect(btn).toMatch(/min-w-11 max-w-\[72px\] flex-auto/);
    expect(btn).toContain("text-[11px]");
    expect(btn).toContain("tracking-tight");
    expect(btn).not.toContain("truncate");
    expect(btn).toContain('class="whitespace-nowrap"');
    expect(html).toContain('data-testid="toolbar-fade-start"');
    expect(html).toContain('data-testid="toolbar-fade-end"');
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

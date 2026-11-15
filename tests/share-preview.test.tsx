// @vitest-environment jsdom
// M21 T2: the share page preview tile — BookCover (shelf) on the ivory stage, format-aware, null
// cover placeholder, title on the cover (dir="auto"), page count, "Open flipbook" slot, compact
// variant, celebration trigger; plus share-motion.css (every animation behind reduced-motion).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SharePreview, formatLabel, pageCountLabel, type SharePreviewData } from "@/components/publish/SharePreview";
import { SHARE_OPEN_LINK } from "@/components/publish/share-page-classes";
import { LIBRARY_STAGE } from "@/components/dashboard/library-classes";

const portrait: SharePreviewData = { coverThumbUrl: "https://example.test/thumb.jpg", format: "A5_PORTRAIT", designStyle: "modern" };
const landscape: SharePreviewData = { coverThumbUrl: null, format: "A5_LANDSCAPE", designStyle: "classic" };
const open = (
  <a href="https://example.test/b/slug" data-testid="publish-open" className={SHARE_OPEN_LINK}>
    Open flipbook
  </a>
);

function dom(html: string) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("SharePreview tile", () => {
  it("draws the shelf cover on the library stage with the title on the cover and the open link", () => {
    const el = dom(renderToStaticMarkup(<SharePreview preview={portrait} title="Summer in Al Ain" pageCount={24} open={open} />));
    const root = el.querySelector('[data-testid="share-preview"]')!;
    expect(root.getAttribute("data-variant")).toBe("tile");
    expect(root.getAttribute("data-format")).toBe("A5_PORTRAIT");
    expect(root.getAttribute("data-celebrate")).toBeNull();
    expect(el.innerHTML).toContain(LIBRARY_STAGE.split(" ")[0]);
    const cover = el.querySelector('[data-testid="book-cover"]')!;
    expect(cover.getAttribute("data-cover")).toBe("photo");
    expect(cover.getAttribute("data-format")).toBe("A5_PORTRAIT");
    expect(cover.className).toContain("w-[60%]");
    expect(cover.querySelector("img")!.getAttribute("src")).toBe(portrait.coverThumbUrl);
    const plate = el.querySelector('[data-testid="share-preview-cover-title"]')!;
    expect(plate.querySelector('[dir="auto"]')!.textContent).toBe("Summer in Al Ain");
    expect(plate.className).toContain("inset-x-[24%]");
    expect(el.querySelector('[data-testid="share-preview-meta"]')!.textContent).toBe("24 pages · Portrait");
    const link = el.querySelector('[data-testid="publish-open"]')!;
    expect(link.textContent).toBe("Open flipbook");
    expect(el.querySelector(".share-float")).not.toBeNull();
  });

  it("keeps the landscape shape and shows the placeholder for a null cover", () => {
    const el = dom(renderToStaticMarkup(<SharePreview preview={landscape} title="رحلتنا إلى العين" pageCount={1} />));
    const cover = el.querySelector('[data-testid="book-cover"]')!;
    expect(cover.getAttribute("data-cover")).toBe("placeholder");
    expect(cover.getAttribute("data-format")).toBe("A5_LANDSCAPE");
    expect(cover.className).toContain("w-[84%]");
    expect(cover.querySelector("img")).toBeNull();
    expect(el.querySelector('[data-testid="book-cover-placeholder"]')).not.toBeNull();
    const plate = el.querySelector('[data-testid="share-preview-cover-title"]')!;
    expect(plate.className).toContain("inset-x-[13%]");
    const span = plate.querySelector("span")!;
    expect(span.getAttribute("dir")).toBe("auto");
    expect(span.textContent).toBe("رحلتنا إلى العين");
    expect(el.querySelector('[data-testid="share-preview-meta"]')!.textContent).toBe("1 page · Landscape");
    expect(el.querySelector('[data-testid="publish-open"]')).toBeNull();
  });

  it("falls back to 'Your book' for a blank title", () => {
    const el = dom(renderToStaticMarkup(<SharePreview preview={portrait} title="" pageCount={0} />));
    expect(el.querySelector('[data-testid="share-preview-cover-title"]')!.textContent).toBe("Your book");
    expect(el.querySelector('[data-testid="share-preview-meta"]')!.textContent).toBe("0 pages · Portrait");
  });

  it("sets the celebration trigger and renders a decorative, clipped burst", () => {
    const el = dom(renderToStaticMarkup(<SharePreview preview={portrait} title="x" pageCount={2} celebrate />));
    expect(el.querySelector('[data-testid="share-preview"]')!.getAttribute("data-celebrate")).toBe("on");
    const burst = el.querySelector('[data-testid="share-burst"]')!;
    expect(burst.getAttribute("aria-hidden")).toBe("true");
    expect(burst.querySelectorAll("i").length).toBeGreaterThanOrEqual(12);
    // The stage clips the burst so it can't cause horizontal scroll at 375.
    expect(burst.parentElement!.className).toContain("overflow-hidden");
  });
});

describe("SharePreview compact", () => {
  it("is a row with a small cover, the title in dir=auto, meta and the open slot", () => {
    const el = dom(renderToStaticMarkup(<SharePreview preview={landscape} title="رحلتنا" pageCount={16} open={open} compact />));
    const root = el.querySelector('[data-testid="share-preview"]')!;
    expect(root.getAttribute("data-variant")).toBe("compact");
    expect(root.getAttribute("data-format")).toBe("A5_LANDSCAPE");
    expect(el.querySelector('[data-testid="book-cover"]')!.getAttribute("data-cover")).toBe("placeholder");
    const title = el.querySelector('[data-testid="share-preview-title"] [dir="auto"]')!;
    expect(title.textContent).toBe("رحلتنا");
    expect(el.querySelector('[data-testid="share-preview-meta"]')!.textContent).toBe("16 pages · Landscape");
    expect(el.querySelector('[data-testid="publish-open"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="share-preview-cover-title"]')).toBeNull();
    expect(el.querySelector(".share-float")).toBeNull();
  });
});

describe("labels", () => {
  it("formats page counts and shapes", () => {
    expect(pageCountLabel(1)).toBe("1 page");
    expect(pageCountLabel(20)).toBe("20 pages");
    expect(pageCountLabel(-3)).toBe("0 pages");
    expect(formatLabel("A5_PORTRAIT")).toBe("Portrait");
    expect(formatLabel("A5_LANDSCAPE")).toBe("Landscape");
  });
});

describe("share-motion.css", () => {
  const css = readFileSync(join(process.cwd(), "src/components/publish/share-motion.css"), "utf8");
  const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  // The guarded block runs from the media query to the first @keyframes after it.
  const guarded = css.slice(start, css.indexOf("@keyframes", start));
  const outside = css.slice(0, start);

  it("defines float, celebration burst and copy pulse", () => {
    for (const k of ["share-float", "share-burst", "share-hop", "share-copy-pulse"]) expect(css).toContain(`@keyframes ${k}`);
    expect(css).toContain('[data-celebrate="on"] .share-burst');
    expect(css).toContain(".share-copy-pulse[data-copied]");
  });

  it("keeps every animation behind prefers-reduced-motion: no-preference", () => {
    expect(start).toBeGreaterThan(0);
    expect(guarded).toContain("animation: share-float");
    expect(guarded).toContain("animation: share-burst");
    expect(guarded).toContain("animation: share-copy-pulse");
    expect(guarded).toContain("animation: share-hop");
    expect(outside).not.toMatch(/animation\s*:/);
    expect(outside).not.toMatch(/transform\s*:/);
    // Statically the burst is hidden; the copied ring is a still ring.
    expect(outside).toMatch(/\.share-burst\s*\{[^}]*display:\s*none/);
    expect(outside).toMatch(/\.share-copy-pulse\[data-copied\]::after\s*\{[^}]*box-shadow/);
  });

  it("is imported by SharePreview (first-load chunk)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/publish/SharePreview.tsx"), "utf8");
    expect(src).toContain('import "./share-motion.css"');
  });
});

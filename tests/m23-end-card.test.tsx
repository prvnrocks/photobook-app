// M23 T4 (D-075): the end card renders inside page-flip page nodes, whose clickEventForward only lets
// a tap through when the event target IS the <a>/<button> — so every link/button holds text only.
// Also pins the free card's emerald-style look and the loader skeleton's motion class.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EndCard } from "@/components/viewer/EndCard";
import { FlipbookSkeleton } from "@/components/viewer/FlipbookLoader";
import { endCardModel } from "@/lib/viewer/end-card";
import type { BookFormat } from "@/lib/book/types";

const noop = () => {};
const FORMATS: (BookFormat | undefined)[] = [undefined, "A5_PORTRAIT", "A5_LANDSCAPE"];

function controls(html: string) {
  return [...html.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/g)];
}

describe("EndCard links and buttons are text only", () => {
  for (const format of FORMATS) {
    it(`free + paid (light, dark, no model), format ${format ?? "default"}`, () => {
      const cards = [
        <EndCard key="f" isPaid={false} onReplay={noop} onShare={noop} format={format} />,
        <EndCard key="pl" isPaid model={endCardModel({ title: "رحلتنا", styleFont: "Playfair", background: "#F5EFE6" })} onReplay={noop} onShare={noop} format={format} />,
        <EndCard key="pd" isPaid model={endCardModel({ title: "Trip", styleFont: "Inter", background: "#1E2A47" })} onReplay={noop} onShare={noop} format={format} />,
        <EndCard key="pn" isPaid onReplay={noop} onShare={noop} format={format} />,
      ];
      for (const card of cards) {
        const html = renderToStaticMarkup(card);
        const found = controls(html);
        expect(found.length).toBeGreaterThan(0);
        for (const m of found) {
          expect(m[2], m[0]).not.toContain("<");
          expect(m[2].trim().length, m[0]).toBeGreaterThan(0);
          expect(m[0], m[0]).toContain("min-h-11");
        }
      }
    });
  }
});

describe("free end card (emerald style)", () => {
  it("cream card, antique-gold eyebrow, emerald serif heading, gold text-only CTA; copy unchanged", () => {
    for (const format of FORMATS) {
      const html = renderToStaticMarkup(<EndCard isPaid={false} format={format} />);
      expect(html).toContain("bg-[#faf5ec]");
      expect(html).toMatch(/<p class="[^"]*text-\[#7a5f0e\][^"]*">Made with /);
      expect(html).toMatch(/<h2 class="[^"]*font-display[^"]*text-\[#0e3b2e\][^"]*">Make your own photobook<\/h2>/);
      expect(html).toMatch(/<a href="\/\?ref=book" data-testid="end-card-cta" class="[^"]*home-foil-fill[^"]*">Create yours<\/a>/);
      // Opacity-only entrance; nothing translates or scales inside a page-flip page.
      expect(html).toContain("vw-card-in");
      expect(html).not.toMatch(/translate|scale-|rotate-|animate-/);
    }
  });
  it("landscape uses the compact recipe set (smaller cqw sizes), portrait the full one", () => {
    const l = renderToStaticMarkup(<EndCard isPaid={false} format="A5_LANDSCAPE" />);
    const p = renderToStaticMarkup(<EndCard isPaid={false} />);
    expect(p).toContain("text-[8cqw]");
    expect(l).toContain("text-[5.6cqw]");
    expect(l).not.toContain("text-[8cqw]");
  });
});

describe("paid end card Share button", () => {
  it("emerald on a light background, white on a dark one; background stays the book's", () => {
    const light = renderToStaticMarkup(
      <EndCard isPaid model={endCardModel({ title: "x", styleFont: "Inter", background: "#F5EFE6" })} onShare={noop} />,
    );
    expect(light).toMatch(/<button[^>]*class="[^"]*bg-\[#0e3b2e\] text-white[^"]*"[^>]*data-testid="end-card-share">Share<\/button>/);
    expect(light).toContain("background:#F5EFE6");
    const dark = renderToStaticMarkup(
      <EndCard isPaid model={endCardModel({ title: "x", styleFont: "Inter", background: "#1E2A47" })} onShare={noop} />,
    );
    expect(dark).toMatch(/<button[^>]*class="[^"]*bg-white text-neutral-900[^"]*"[^>]*data-testid="end-card-share">Share<\/button>/);
    expect(dark).not.toContain("bg-[#0e3b2e]");
  });
});

describe("loader skeleton", () => {
  it("ivory page with the opacity-only vw-skeleton-pulse (static under reduced motion via viewer-motion.css)", () => {
    const html = renderToStaticMarkup(<FlipbookSkeleton />);
    expect(html).toContain('data-testid="flipbook-loading"');
    expect(html).toContain("vw-skeleton-pulse");
    expect(html).toContain("bg-[#faf5ec]");
    expect(html).toContain("aspect-[148/210]");
    expect(html).not.toContain("animate-pulse");
  });
});

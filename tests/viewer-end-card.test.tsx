import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EndCard } from "@/components/viewer/EndCard";
import { APP_NAME } from "@/lib/brand";
import { devViewerBackground, devViewerDoc, devViewerPageCount } from "@/lib/viewer/dev-fixture";
import { endCardModel, hexLuminance } from "@/lib/viewer/end-card";
import { BACKGROUND_SWATCHES, inkFor, multiplyHex, textureById } from "@/lib/design/backgrounds";
import type { Background } from "@/lib/book/types";

const noop = () => {};

describe("endCardModel (D-054)", () => {
  it("English title: style font for heading and title, light background → dark ink", () => {
    const m = endCardModel({ title: "  Our Abu Dhabi trip ", styleFont: "Playfair", background: "#FFFFFF" });
    expect(m.title).toBe("Our Abu Dhabi trip");
    expect(m.titleLang).toBeUndefined();
    expect(m.titleFontFamily.startsWith("var(--font-playfair)")).toBe(true);
    expect(m.headingFontFamily.startsWith("var(--font-playfair)")).toBe(true);
    expect(m.background).toBe("#FFFFFF");
    expect(m.dark).toBe(false);
  });
  it("Arabic title: Cairo + lang=ar; heading keeps the style font", () => {
    const m = endCardModel({ title: "رحلتنا إلى أبوظبي", styleFont: "Playfair", background: "#F5EFE6" });
    expect(m.titleLang).toBe("ar");
    expect(m.titleFontFamily.startsWith("var(--font-cairo)")).toBe(true);
    expect(m.headingFontFamily.startsWith("var(--font-playfair)")).toBe(true);
    expect(m.background).toBe("#F5EFE6");
  });
  it("dark background → light ink; invalid colour falls back to white", () => {
    expect(endCardModel({ title: "x", styleFont: "Inter", background: "#111111" }).dark).toBe(true);
    const bad = endCardModel({ title: "x", styleFont: "Unknown", background: "red" });
    expect(bad.background).toBe("#FFFFFF");
    expect(bad.dark).toBe(false);
    expect(hexLuminance("#000000")).toBe(0);
    expect(hexLuminance("#ffffff")).toBeCloseTo(1);
    expect(hexLuminance("#fff")).toBeNull();
  });
  it("ink follows inkFor — the same rule as the pages (N3)", () => {
    // Every catalogue swatch: card text is white exactly when page captions are white.
    for (const s of BACKGROUND_SWATCHES) {
      const bg: Background = { kind: "color", hex: s.hex };
      expect(endCardModel({ title: "x", styleFont: "Inter", background: bg }).dark, s.id).toBe(inkFor(bg) === "light");
      expect(endCardModel({ title: "x", styleFont: "Inter", background: s.hex }).dark, s.id).toBe(inkFor(s.hex) === "light");
    }
    // Mid-tone where the old 0.18-luminance cut disagreed with the pages' contrast rule.
    expect(hexLuminance("#7C7C7C")).toBeGreaterThan(0.18);
    expect(inkFor("#7C7C7C")).toBe("light");
    expect(endCardModel({ title: "x", styleFont: "Inter", background: "#7C7C7C" }).dark).toBe(true);
  });
  it("paper and photo backgrounds: plain card colour + the pages' ink", () => {
    const linen = textureById("linen")!;
    const paper = endCardModel({ title: "x", styleFont: "Inter", background: { kind: "texture", textureId: "linen" } });
    expect(paper.background).toBe(linen.baseHex);
    expect(paper.dark).toBe(linen.ink === "light");
    const tinted: Background = { kind: "texture", textureId: "linen", tint: "#CAD6C1" };
    const t = endCardModel({ title: "x", styleFont: "Inter", background: tinted });
    expect(t.background).toBe(multiplyHex(linen.baseHex, "#CAD6C1"));
    expect(t.dark).toBe(inkFor(tinted) === "light");
    const navyVeil: Background = { kind: "photo", photoId: "11111111-1111-4111-8111-111111111111", veil: 0.7, veilColor: "#1E2A47" };
    expect(endCardModel({ title: "x", styleFont: "Inter", background: navyVeil })).toMatchObject({ background: "#1E2A47", dark: true });
    const whiteVeil: Background = { ...navyVeil, veilColor: "#FFFFFF" };
    expect(endCardModel({ title: "x", styleFont: "Inter", background: whiteVeil })).toMatchObject({ background: "#FFFFFF", dark: false });
  });
});

describe("EndCard markup", () => {
  it("paid: The end, title dir=auto, Replay + Share buttons, Made with link, page background", () => {
    const model = endCardModel({ title: "رحلتنا إلى أبوظبي", styleFont: "Playfair", background: "#F5EFE6" });
    const html = renderToStaticMarkup(<EndCard isPaid model={model} onReplay={noop} onShare={noop} />);
    expect(html).toContain('data-paid="true"');
    expect(html).toContain("The end");
    expect(html).toMatch(/<p dir="auto" lang="ar"[^>]*data-testid="end-card-title"[^>]*>رحلتنا إلى أبوظبي<\/p>/);
    expect(html).toMatch(/<button type="button"[^>]*data-testid="end-card-replay">Replay<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*data-testid="end-card-share">Share<\/button>/);
    expect(html).toContain(`Made with ${APP_NAME}`);
    expect(html).toContain('href="/?ref=book"');
    expect(html).toContain("background:#F5EFE6");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("Make your own photobook");
    // page-flip forwards taps only when the target IS the <a>/<button>: text only inside.
    for (const m of html.matchAll(/<(a|button) [^>]*>([\s\S]*?)<\/\1>/g)) expect(m[2]).not.toContain("<");
  });
  it("free: CTA unchanged, no Replay/Share", () => {
    const html = renderToStaticMarkup(<EndCard isPaid={false} onReplay={noop} onShare={noop} />);
    expect(html).toContain("Make your own photobook");
    expect(html).toContain('data-testid="end-card-cta"');
    expect(html).not.toContain("end-card-replay");
    expect(html).not.toContain("The end");
  });
});

describe("dev fixture page count", () => {
  it("parses ?pages= and builds that many pages", () => {
    expect(devViewerPageCount(undefined)).toBe(12);
    expect(devViewerPageCount("20")).toBe(20);
    expect(devViewerPageCount("0")).toBe(1);
    expect(devViewerPageCount("500")).toBe(100);
    expect(devViewerPageCount("abc")).toBe(12);
    const doc = devViewerDoc({ pages: 60 });
    expect(doc.pages).toHaveLength(60);
    expect(doc.pages.flatMap((p) => p.slots.map((s) => s.photoId)).every((id) => /^v([1-9]|[1-3]\d)$/.test(id ?? ""))).toBe(true);
    expect(devViewerDoc().pages).toHaveLength(12);
    expect(devViewerBackground("f5efe6")).toBe("#F5EFE6");
    expect(devViewerBackground("red")).toBe("#FFFFFF");
    expect(devViewerDoc({ background: "#F5EFE6" }).style.background).toEqual({ kind: "color", hex: "#F5EFE6" });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import LandingPage, { metadata } from "@/app/(marketing)/page";
import sitemap from "@/app/sitemap";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { LIMITS } from "@/lib/ai/limits";
import { SUPPORT_EMAIL } from "@/lib/brand";
import { retentionSummary } from "@/lib/cleanup/rules";
import { BUILD_TIME_CLAIM, CTA_HREF, HERO_CLAIM, OG_HEADLINE, OG_SUBLINE } from "@/lib/marketing/copy";
import { EXAMPLE_BOOKS } from "@/lib/marketing/examples";
import { faqItems } from "@/lib/marketing/faq";
import { plans } from "@/lib/marketing/plans";
import { UPGRADE } from "@/lib/pricing";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";

// renderToStaticMarkup escapes quotes/apostrophes/ampersands.
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const html = renderToStaticMarkup(<LandingPage />);
const text = (testId: string) => {
  const m = html.match(new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</`));
  return m?.[1] ?? null;
};

describe("landing hero", () => {
  it("headline is the HERO_CLAIM constant and uses the free AI photo limit", () => {
    expect(HERO_CLAIM).toContain(String(LIMITS.free.maxAnalyzedPhotos));
    expect(HERO_CLAIM).toContain(BUILD_TIME_CLAIM);
    expect(html).toContain(esc(HERO_CLAIM));
  });

  it("CTA goes to login, then to a new book", () => {
    expect(CTA_HREF).toBe("/login?next=%2Fbooks%2Fstart");
    expect(html).toMatch(/data-testid="cta-create"/);
    expect(html).toContain(`href="${esc(CTA_HREF)}"`);
  });

  it("Arabic sample caption uses dir=auto + the Arabic font", () => {
    const tag = html.match(/<p[^>]*data-testid="sample-caption-ar"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('dir="auto"');
    expect(tag).toContain("font-arabic");
  });
});

describe("pricing equals the constants", () => {
  const [free, paid] = plans();
  const feature = (p: typeof free, key: string) => p.features.find((f) => f.key === key)!;

  it("paid price comes from pricing.ts", () => {
    expect(paid.price).toBe(UPGRADE.label);
    expect(UPGRADE.label).toBe("AED 39");
    expect(text("plan-paid-price")).toBe(UPGRADE.label);
  });

  it("free plan: pages, link days, watermark, no PDF, AI photos", () => {
    expect(feature(free, "pages").text).toContain(String(LIMITS.free.maxPages));
    expect(feature(free, "link").text).toContain(String(FREE_LINK_DAYS));
    expect(feature(free, "watermark").included).toBe(false);
    expect(feature(free, "pdf").included).toBe(false);
    expect(feature(free, "ai_photos").text).toContain(String(LIMITS.free.maxAnalyzedPhotos));
  });

  it("paid plan: pages, permanent, no watermark, PDF, AI photos", () => {
    expect(feature(paid, "pages").text).toContain(String(LIMITS.paid.maxPages));
    expect(feature(paid, "link").text).toMatch(/permanent/i);
    expect(feature(paid, "watermark").included).toBe(true);
    expect(feature(paid, "pdf").included).toBe(true);
    expect(feature(paid, "ai_photos").text).toContain(String(LIMITS.paid.maxAnalyzedPhotos));
  });

  it("every plan feature is on the page", () => {
    for (const p of plans()) for (const f of p.features) expect(html).toContain(esc(f.text));
  });
});

describe("sections", () => {
  it("renders hero, how it works, pricing, FAQ", () => {
    for (const id of ["section-hero", "section-how", "section-pricing", "section-faq"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it("examples section is hidden while the list is empty", () => {
    expect(EXAMPLE_BOOKS).toHaveLength(0);
    expect(html).not.toContain('data-testid="section-examples"');
    expect(renderToStaticMarkup(<ExampleBooks books={[]} />)).toBe("");
    const shown = renderToStaticMarkup(<ExampleBooks books={[{ slug: "abc", title: "Eid 2026", coverSrc: "/x.jpg" }]} />);
    expect(shown).toContain('data-testid="section-examples"');
    expect(shown).toContain('href="/b/abc"');
  });

  it("demo video is hidden when public/demo files are missing", () => {
    expect(html).not.toContain('data-testid="section-demo"');
  });

  it("footer links to privacy, terms and support", () => {
    // Footer lives in the (marketing) layout; checked in e2e. Here: support email in the refunds FAQ.
    expect(faqItems().find((f) => f.id === "refunds")!.answer.join(" ")).toContain(SUPPORT_EMAIL);
  });
});

describe("FAQ", () => {
  it("retention answers come from retentionSummary()", () => {
    const r = Object.fromEntries(retentionSummary().map((x) => [x.key, x.text]));
    const after = faqItems().find((f) => f.id === "after_30_days")!;
    expect(after.question).toContain(String(FREE_LINK_DAYS));
    expect(after.answer).toEqual([r.free_published, r.draft, r.paid]);
    for (const p of after.answer) expect(html).toContain(esc(p));
  });

  it("uses native <details> and covers the required topics", () => {
    expect(faqItems().map((f) => f.id)).toEqual(["privacy", "ai", "arabic", "after_30_days", "refunds", "printing"]);
    expect(html.match(/<details/g)?.length).toBe(faqItems().length);
  });

  it("AI answer: thumbnails + dates/places, Anthropic commercial-terms wording", () => {
    const ai = faqItems().find((f) => f.id === "ai")!.answer.join(" ");
    expect(ai).toMatch(/512 px/);
    expect(ai).toMatch(/dates and place names/);
    expect(ai).toContain("Under Anthropic's commercial terms, data sent through its API is not used to train its models");
  });
});

describe("SEO", () => {
  it("metadata has title + description", () => {
    expect(metadata.description).toBeTruthy();
    expect(JSON.stringify(metadata.title)).toContain("Photobook");
  });

  it("OG card text is ASCII only (no runtime font fetch)", () => {
    expect(OG_HEADLINE + OG_SUBLINE).toMatch(/^[\x20-\x7E]+$/);
  });

  it("sitemap lists only /, /privacy, /terms — never /b/", () => {
    const urls = sitemap().map((e) => new URL(e.url).pathname);
    expect(urls).toEqual(["/", "/privacy", "/terms"]);
    expect(urls.some((u) => u.startsWith("/b/"))).toBe(false);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import LandingPage, { metadata } from "@/app/(marketing)/page";
import sitemap from "@/app/sitemap";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { LIMITS } from "@/lib/ai/limits";
import { SUPPORT_EMAIL } from "@/lib/brand";
import { retentionSummary } from "@/lib/cleanup/rules";
import { CTA_HREF, CTA_LABEL, HERO_CTA_LABEL, HERO_HEADLINE, HERO_SUBCOPY, OG_HEADLINE, OG_SUBLINE } from "@/lib/marketing/copy";
import { SHELF_BOOKS, SHELF_DEFAULT_ID, SHELF_FILTERS } from "@/lib/marketing/shelf";
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
  it("headline is exactly the user's line (M14) in the hero heading", () => {
    expect(HERO_HEADLINE).toBe("Your memories, in print.");
    expect(text("hero-heading")).toBe(HERO_HEADLINE);
    expect(html).toContain(esc(HERO_SUBCOPY));
    expect(HERO_SUBCOPY).toBe("Upload your photos. AI turns them into a book you can share.");
  });

  it("CTA goes to login, then to a new book", () => {
    expect(CTA_HREF).toBe("/login?next=%2Fbooks%2Fstart");
    expect(text("cta-create")).toBe(HERO_CTA_LABEL);
    expect(HERO_CTA_LABEL).toBe("Make my book");
    expect(html).toContain(`href="${esc(CTA_HREF)}"`);
    // pricing repeats the hero's words (M14 final)
    expect(CTA_LABEL).toBe(HERO_CTA_LABEL);
    expect(html.split(`>${CTA_LABEL}<`).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("does not render the mockup's colour palette note", () => {
    expect(html).not.toMatch(/color palette/i);
    expect(html).not.toContain("#F8F3EA");
  });
});

describe("bookshelf (server render)", () => {
  const tagOf = (testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

  it("is a labelled carousel with one button per book, named by its title", () => {
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).toContain('aria-label="Sample books"');
    for (const b of SHELF_BOOKS) {
      expect(html).toContain(`data-testid="shelf-book-${b.id}"`);
      expect(html).toContain(`aria-label="${esc(b.title)}"`);
    }
  });

  it("default selection is The Day We Said Yes: current, only tab stop, title + View sample album", () => {
    expect(SHELF_DEFAULT_ID).toBe("the-day-we-said-yes");
    expect(tagOf(`shelf-book-${SHELF_DEFAULT_ID}`)).toContain("data-selected");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html.match(/<button[^>]*aria-current="true"[^>]*>/)?.[0]).toContain('aria-label="The Day We Said Yes"');
    expect(html.match(/<button[^>]*aria-label="[^"]*"[^>]*tabindex="0"|<button[^>]*tabindex="0"[^>]*aria-label/g)?.length).toBe(1);
    expect(html).toMatch(/data-testid="shelf-title"[^>]*><span dir="auto">The Day We Said Yes<\/span>/);
    expect(text("shelf-view-sample")).toBe("View sample album");
  });

  it("the real cover loads with high priority; far spines are lazy", () => {
    expect(html).toMatch(/<img[^>]*src="\/home\/books\/08-the-day-we-said-yes-cover.png"[^>]*fetchPriority="high"/i);
    expect(html).toMatch(/<img[^>]*loading="lazy"[^>]*src="\/home\/books\/01-our-family.png"|<img[^>]*src="\/home\/books\/01-our-family.png"[^>]*loading="lazy"/);
  });

  it("filter chips: All pressed, one per filter, 44 px targets on phones", () => {
    for (const f of SHELF_FILTERS) {
      const tag = tagOf(`shelf-filter-${f.id}`);
      expect(tag).toContain(`aria-pressed="${f.id === "all"}"`);
      expect(tag).toContain("h-11");
    }
  });

  it("book titles use dir=auto; preview dialog is closed (no second accent CTA in HTML)", () => {
    expect(html.match(/<span dir="auto">[^<]+<\/span>/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-testid="shelf-preview"');
    expect(html).not.toContain('data-testid="shelf-preview-cta"');
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

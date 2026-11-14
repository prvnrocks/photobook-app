import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import LandingPage, { metadata } from "@/app/(marketing)/page";
import sitemap from "@/app/sitemap";
import { ExampleBooks } from "@/components/marketing/ExampleBooks";
import { LIMITS } from "@/lib/ai/limits";
import { SUPPORT_EMAIL } from "@/lib/brand";
import { retentionSummary } from "@/lib/cleanup/rules";
import {
  CTA_HREF,
  CTA_LABEL,
  HERO_CTA_LABEL,
  HERO_HEADLINE,
  HERO_STICKER,
  HERO_SUBCOPY,
  MARQUEE_ITEMS,
  OG_HEADLINE,
  OG_SUBLINE,
  SHELF_SECTION_TITLE,
} from "@/lib/marketing/copy";
import { CONFETTI, CONFETTI_COLORS, HERO_BOOK } from "@/lib/marketing/hero";
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
/** Visible text of an element whose children include markup (e.g. the CTA's arrow badge). */
const fullText = (testId: string) => {
  const m = html.match(new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`));
  return m ? m[2].replace(/<[^>]+>/g, "") : null;
};

const tagOf = (testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe("landing hero", () => {
  it("headline is exactly the user's line (M14, kept in M15) in the hero heading", () => {
    expect(HERO_HEADLINE).toBe("Your memories, in print.");
    expect(text("hero-heading")).toBe(HERO_HEADLINE);
    expect(html).toContain(esc(HERO_SUBCOPY));
    expect(HERO_SUBCOPY).toBe("Upload your photos. AI turns them into a book you can share.");
  });

  it("CTA goes to login, then to a new book", () => {
    expect(CTA_HREF).toBe("/login?next=%2Fbooks%2Fstart");
    expect(fullText("cta-create")).toBe(HERO_CTA_LABEL);
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

describe("M15 hero (Direction A · Confetti)", () => {
  it("one h1 (the headline) in the Bricolage brand face; CTA is the AA pink pill", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(tagOf("hero-heading")).toContain("font-brand");
    expect(tagOf("cta-create")).toContain("bg-accent-strong");
    expect(tagOf("cta-create")).toContain("rounded-full");
  });

  it("the hero book is HERO_BOOK: sized, described, the only high-priority image", () => {
    expect(HERO_BOOK.src).toBe("/home/books/08-the-day-we-said-yes-cover.png");
    const img = html.match(new RegExp(`<img[^>]*src="${HERO_BOOK.src}"[^>]*>`))![0];
    expect(img).toContain(`width="${HERO_BOOK.w}"`);
    expect(img).toContain(`height="${HERO_BOOK.h}"`);
    expect(img).toContain(`alt="${esc(HERO_BOOK.alt)}"`);
    // React also emits a <link rel="preload"> for it; count <img> tags only
    expect(html.match(/<img[^>]*fetchPriority="high"/gi)).toHaveLength(1);
  });

  it("confetti is decorative CSS in the four confetti colours, every piece inside its box", () => {
    expect(Object.values(CONFETTI_COLORS)).toEqual(["#ff1f84", "#ffc93c", "#18b8a6", "#ffffff"]);
    for (const p of CONFETTI) {
      expect(p.layer === "front" ? p.x >= -15 && p.x <= 100 : p.x >= 0 && p.x <= 100).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
      expect(p.dur).toBeGreaterThanOrEqual(10);
    }
    expect(html.match(/class="home-confetti /g)?.length).toBe(CONFETTI.length);
    expect(html).toMatch(/<div aria-hidden="true" class="pointer-events-none absolute inset-0 \[--cs/);
  });

  it("sticker + Arabic paper tag: true copy, Arabic in lang=ar with dir=auto", () => {
    expect(HERO_STICKER.join(" ")).toBe("Free to try");
    expect(html).toMatch(/<p lang="ar" class="[^"]*font-brand-ar[^"]*"><span dir="auto">لمّة العائلة<\/span>/);
  });

  it("marquee: true benefits once for readers, copies hidden, pause toggle", () => {
    expect(MARQUEE_ITEMS).toEqual([
      "AI picks your best photos",
      "Arabic & English captions",
      "Share on WhatsApp",
      "Print-ready PDF",
      "Made in Abu Dhabi",
    ]);
    const marquee = html.slice(html.indexOf('data-testid="section-marquee"'), html.indexOf('data-testid="section-how"'));
    expect(marquee.match(/<ul class=/g)).toHaveLength(1);
    expect(marquee.match(/<ul aria-hidden="true"/g)).toHaveLength(3);
    for (const item of MARQUEE_ITEMS) expect(marquee).toContain(esc(item));
    expect(marquee).toMatch(/<input type="checkbox" data-testid="marquee-pause"/);
    expect(marquee).toContain("Pause scrolling text");
  });

  it("section order: hero, marquee, how it works, shelf, pricing, FAQ", () => {
    const order = ["section-hero", "section-marquee", "section-how", "section-shelf", "section-pricing", "section-faq"].map((id) =>
      html.indexOf(`data-testid="${id}"`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(`>${SHELF_SECTION_TITLE}</h2>`);
  });
});

describe("bookshelf (server render)", () => {

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

  it("the shelf sits below the fold: its cover is not high priority; far spines are lazy", () => {
    const shelf = html.slice(html.indexOf('data-testid="bookshelf"'));
    expect(shelf).not.toMatch(/fetchPriority="high"/i);
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
  it("renders hero, marquee, how it works, shelf, pricing, FAQ", () => {
    for (const id of ["section-hero", "section-marquee", "section-how", "section-shelf", "section-pricing", "section-faq"]) {
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

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
  HERO_HEADLINE_ACCENT,
  HERO_HEADLINE_LEAD,
  HERO_SEAL,
  HERO_SUBCOPY,
  HERO_TAG_LINE,
  HERO_TAG_TITLE_AR,
  MARQUEE_ITEMS,
  OG_EYEBROW,
  OG_HEADLINE,
  OG_HEADLINE_ACCENT,
  OG_HEADLINE_LEAD,
  OG_SUBLINE,
  SECTION_LABELS,
} from "@/lib/marketing/copy";
import { FOIL_FLECKS, HERO_BOOK } from "@/lib/marketing/hero";
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
  it("headline is exactly the user's line (M14, kept in M15/M16) in the hero heading", () => {
    expect(HERO_HEADLINE).toBe("Your memories, in print.");
    // M16 sets the last words in foil; the heading's text is still exactly the line
    expect(HERO_HEADLINE_LEAD + HERO_HEADLINE_ACCENT).toBe(HERO_HEADLINE);
    expect(HERO_HEADLINE_ACCENT).toBe("in print.");
    expect(fullText("hero-heading")).toBe(HERO_HEADLINE);
    expect(html).toContain(esc(HERO_SUBCOPY));
    expect(HERO_SUBCOPY).toBe("Upload your photos. AI turns them into a book you can share.");
  });

  it("CTA goes to login, then to a new book", () => {
    expect(CTA_HREF).toBe("/login?next=%2Fbooks%2Fnew");
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

describe("M16 hero (Emerald & gold)", () => {
  it("one h1 (the headline) in the Bricolage brand face; CTA is the gold foil pill with ink text", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(tagOf("hero-heading")).toContain("font-brand");
    expect(tagOf("cta-create")).toContain("home-foil-fill");
    expect(tagOf("cta-create")).toContain("text-[#1b1b1d]");
    expect(tagOf("cta-create")).toContain("rounded-full");
    expect(tagOf("section-hero")).toContain("home-leather");
  });

  it("two gold foil rules frame the hero; small caps eyebrow over a foil hairline", () => {
    const hero = html.slice(html.indexOf('data-testid="section-hero"'), html.indexOf('data-testid="section-marquee"'));
    expect(hero.match(/<span aria-hidden="true" class="home-foil-v /g)).toHaveLength(2);
    expect(hero).toContain(esc("AI photobooks · Abu Dhabi"));
  });

  it("the hero book is HERO_BOOK: sized, described, the only high-priority image", () => {
    expect(HERO_BOOK.src).toBe("/home/books/08-the-day-we-said-yes-cover.png");
    const img = html.match(new RegExp(`<img[^>]*src="${HERO_BOOK.src}"[^>]*>`))![0];
    expect(img).toContain(`width="${HERO_BOOK.w}"`);
    expect(img).toContain(`height="${HERO_BOOK.h}"`);
    expect(img).toContain(`alt="${esc(HERO_BOOK.alt)}"`);
    // React also emits a <link rel="preload"> for it; count <img> tags only
    expect(html.match(/<img[^>]*fetchPriority="high"/gi)).toHaveLength(1);
    // the only image on the page now that the shelf is gone
    expect(html.match(/<img[\s>]/g)).toHaveLength(1);
  });

  it("gold flecks: few, slow, decorative, every fleck inside its box; no confetti left", () => {
    expect(FOIL_FLECKS.length).toBeLessThanOrEqual(10);
    for (const p of FOIL_FLECKS) {
      expect(p.layer === "front" ? p.x >= -15 && p.x <= 105 : p.x >= 0 && p.x <= 100).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
      expect(p.dur).toBeGreaterThanOrEqual(20);
      expect(Math.max(p.w, p.h)).toBeLessThanOrEqual(12);
    }
    expect(html.match(/class="home-fleck /g)?.length).toBe(FOIL_FLECKS.length);
    expect(html).not.toContain("home-confetti");
    expect(html).toMatch(/<div aria-hidden="true" class="pointer-events-none absolute inset-0 \[--fs/);
  });

  it("foil seal + Arabic card: true copy, Arabic in lang=ar with dir=auto in the Lalezar face", () => {
    expect(HERO_SEAL.join(" ")).toBe("Free to try");
    expect(HERO_TAG_TITLE_AR).toBe("لمّة العائلة");
    expect(html).toMatch(/<p lang="ar" data-testid="hero-tag-ar" class="[^"]*font-brand-ar[^"]*"><span dir="auto">لمّة العائلة<\/span>/);
    expect(html).toContain(esc(HERO_TAG_LINE));
    // the card is shown at every width (it is the landing's Arabic proof since M16)
    expect(tagOf("hero-tag")).not.toMatch(/(^|\s)hidden(\s|")/);
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

  it("section order: hero, marquee, how it works, pricing, FAQ; the shelf is gone", () => {
    const order = ["section-hero", "section-marquee", "section-how", "section-pricing", "section-faq"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("section-shelf");
    expect(html).not.toContain("Pick a style to start");
    expect(html).not.toContain("bookshelf");
    for (const label of Object.values(SECTION_LABELS)) expect(html).toContain(esc(label));
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
  it("renders hero, marquee, how it works, pricing, FAQ", () => {
    for (const id of ["section-hero", "section-marquee", "section-how", "section-pricing", "section-faq"]) {
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

  it("OG card text stays in the bundled Latin font (no runtime font fetch)", () => {
    // Basic Latin + Latin-1 (U+00A0-U+00FF) = the Noto Sans latin subset next/og bundles.
    expect(OG_EYEBROW + OG_HEADLINE + OG_SUBLINE).toMatch(/^[\x20-\x7E\u00A0-\u00FF]+$/);
    expect(OG_EYEBROW).toBe("AI PHOTOBOOKS \u00B7 ABU DHABI");
    expect(OG_HEADLINE).toBe(`${OG_HEADLINE_LEAD} ${OG_HEADLINE_ACCENT}`);
    expect(OG_HEADLINE).toBe("Your memories, in print.");
  });

  it("sitemap lists only /, /privacy, /terms — never /b/", () => {
    const urls = sitemap().map((e) => new URL(e.url).pathname);
    expect(urls).toEqual(["/", "/privacy", "/terms"]);
    expect(urls.some((u) => u.startsWith("/b/"))).toBe(false);
  });
});

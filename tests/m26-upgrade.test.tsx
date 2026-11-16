// M26 (D-078): upgrade return page in the emerald style. Every view phase renders its testid in one
// cream card; one gold call to action at most per state (paid only); the islands stay free of
// cn / buttonVariants / next/link / shadcn Button; motion is CSS gated by prefers-reduced-motion;
// the band and the cards clear AA. Behaviour (polling, timeout, paid detection) stays covered by
// tests/upgrade-success.test.tsx.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: "upgrade=cancelled" }));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn(), getUpgradeStatus: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
  usePathname: () => "/books/b1/publish",
  useSearchParams: () => new URLSearchParams(h.search),
}));

const { UpgradeStatusView } = await import("@/components/upgrade/UpgradeStatusPoller");
const { UpgradeBand } = await import("@/components/upgrade/UpgradeBand");
const { UpgradeCancelledNotice } = await import("@/components/upgrade/UpgradeCancelledNotice");
const { UpgradeButtonView } = await import("@/components/upgrade/UpgradeButton");
const classes = await import("@/components/upgrade/upgrade-classes");
const pageClasses = await import("@/components/upgrade/upgrade-page-classes");
const buttonClasses = await import("@/components/upgrade/upgrade-button-classes");
const { contrastRatio } = await import("@/lib/app/palette");
type Phase = import("@/lib/upgrade/poller").UpgradePollPhase;

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const BOOK = "11111111-1111-4111-8111-111111111111";

const view = (phase: Phase, liveSlug: string | null = null) =>
  renderToStaticMarkup(<UpgradeStatusView bookId={BOOK} phase={phase} liveSlug={liveSlug} onRetry={() => {}} />);

const PHASE_TESTID: Array<[Phase, string]> = [
  ["polling", "upgrade-polling"],
  ["processing", "upgrade-polling"],
  ["paid", "upgrade-paid"],
  ["failed", "upgrade-failed"],
  ["support", "upgrade-support"],
  ["timeout", "upgrade-timeout"],
  ["unauthenticated", "upgrade-signed-out"],
  ["not_found", "upgrade-not-found"],
];

const goldCount = (html: string) => (html.match(/home-foil-fill/g) ?? []).length;

describe("status cards", () => {
  it("every phase renders its testid on one cream card with exactly one h1", () => {
    for (const [phase, testId] of PHASE_TESTID) {
      const html = view(phase, phase === "paid" ? null : "s-1");
      expect(html, phase).toContain(`data-testid="${testId}"`);
      expect(html.match(/<h1/g)?.length, phase).toBe(1);
      expect(html.startsWith(`<section class="${classes.UP_CARD}"`), phase).toBe(true);
    }
  });

  it("one gold per state: paid has exactly one gold pill (live or not); every other state none", () => {
    expect(goldCount(view("paid"))).toBe(1);
    expect(goldCount(view("paid", "sara-7Hq2"))).toBe(1);
    expect(view("paid")).toMatch(/home-foil-fill[^"]*" data-testid="upgrade-publish">Publish your book</);
    expect(view("paid", "sara-7Hq2")).toMatch(/home-foil-fill[^"]*" data-testid="upgrade-open-live"/);
    for (const [phase] of PHASE_TESTID.filter(([p]) => p !== "paid")) expect(goldCount(view(phase)), phase).toBe(0);
  });

  it("paid: gold check seal, celebration dots, four benefit cards with emerald checks, Back to editor outline", () => {
    const html = view("paid");
    expect(html).toContain('data-seal="paid"');
    expect(html).toContain("home-seal");
    expect(html).toContain('class="up-burst" data-testid="upgrade-burst"');
    expect(html.match(/<i style=/g)?.length).toBe(12);
    const benefits = html.match(/<ul class="[^"]*" data-testid="upgrade-benefits">(.*?)<\/ul>/)?.[1] ?? "";
    expect(benefits.match(/<li /g)?.length).toBe(4);
    expect(benefits.match(new RegExp(classes.UP_BENEFIT_CHECK.replace(/[[\]/().]/g, "\\$&"), "g"))?.length).toBe(4);
    expect(html).toContain(`class="${classes.UP_CTA_OUTLINE}" data-testid="upgrade-edit">Back to editor</a>`);
  });

  it("confirming: busy card, turning seal ring + breathing icon, keep-open copy as a status", () => {
    for (const phase of ["polling", "processing"] as const) {
      const html = view(phase);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('data-seal="confirming"');
      expect(html).toContain('class="up-seal-track"');
      expect(html).toContain('class="up-seal-arc"');
      expect(html).toContain("up-seal-icon");
      expect(html).toMatch(/role="status">This usually takes a few seconds\. Please keep this page open\.</);
    }
  });

  it("calm states use the cream / amber seals and emerald CTAs (no red, no gold)", () => {
    expect(view("failed")).toContain('data-seal="warm"');
    expect(view("support")).toContain('data-seal="warm"');
    expect(view("timeout")).toContain('data-seal="calm"');
    expect(view("failed")).toContain(`class="${classes.UP_CTA_EMERALD}" data-testid="upgrade-back-publish"`);
    expect(view("timeout")).toContain(`<button type="button" class="${classes.UP_CTA_EMERALD}" data-testid="upgrade-refresh">`);
    for (const [phase] of PHASE_TESTID) expect(view(phase), phase).not.toMatch(/destructive/);
  });

  it("every link / button is ≥ 44 px with a visible focus ring", () => {
    for (const [phase] of PHASE_TESTID) {
      for (const m of view(phase, "s-1").matchAll(/<(?:a|button)[^>]*class="([^"]*)"/g)) {
        expect(m[1], phase).toMatch(/\bmin-h-1[1-4]\b|\bsize-11\b/);
        expect(m[1], phase).toContain("focus-visible:ring-2");
      }
    }
  });
});

describe("band, notice, button", () => {
  it("band: Upgrade eyebrow, the title as dir=auto user text (p, not h1), the back slot", () => {
    const html = renderToStaticMarkup(<UpgradeBand title="  رحلتنا إلى العين " back={<a href="/x">Back to editor</a>} />);
    expect(html).toContain('data-testid="upgrade-band"');
    expect(html).toContain("<span>Upgrade</span>");
    expect(html).toContain('<span dir="auto" data-testid="upgrade-title">رحلتنا إلى العين</span>');
    expect(html).not.toContain("<h1");
    expect(html).toContain("Back to editor");
    expect(renderToStaticMarkup(<UpgradeBand title="" />)).toContain(">Your book</span>");
  });

  it("cancelled notice: amber-cream card, 44 px dismiss", () => {
    h.search = "upgrade=cancelled";
    const html = renderToStaticMarkup(<UpgradeCancelledNotice />);
    expect(html).toContain(buttonClasses.UPGRADE_CANCELLED_BOX);
    expect(html).toContain('data-testid="upgrade-cancelled"');
    expect(html).toMatch(/class="[^"]*size-11[^"]*"[^>]*data-testid="upgrade-cancelled-dismiss"/);
  });

  it("UpgradeButton: emerald defaults; a caller's className still replaces them entirely", () => {
    const base = { bookId: BOOK, returnTo: `/books/${BOOK}/publish`, isPaid: false, paymentsEnabled: true, refresh: () => {} };
    expect(renderToStaticMarkup(<UpgradeButtonView {...base} />)).toContain(`class="${buttonClasses.UPGRADE_BUTTON_PRIMARY}"`);
    expect(renderToStaticMarkup(<UpgradeButtonView {...base} variant="viewer" />)).toContain(`class="${buttonClasses.UPGRADE_BUTTON_PRIMARY}"`);
    expect(renderToStaticMarkup(<UpgradeButtonView {...base} variant="outline" />)).toContain(`class="${buttonClasses.UPGRADE_BUTTON_OUTLINE}"`);
    expect(renderToStaticMarkup(<UpgradeButtonView {...base} className="CUSTOM min-h-12" />)).toContain('class="CUSTOM min-h-12" data-testid="upgrade-button"');
  });
});

describe("guardrails", () => {
  const islands = [
    "src/components/upgrade/UpgradeStatusPoller.tsx",
    "src/components/upgrade/UpgradeCancelledNotice.tsx",
    "src/app/dev-upgrade/DevUpgradeClient.tsx",
  ];

  it("client islands import no cn / buttonVariants / next/link / shadcn Button / EmptyState / BTN", () => {
    for (const f of islands) {
      const src = read(f);
      expect(src, f).toMatch(/^"use client";/);
      expect(src, f).not.toMatch(/from "next\/link"|@\/lib\/utils|button-variants|@\/components\/ui\/|EmptyState|app\/button-classes"/);
    }
    // UpgradeButton keeps its own (pre-M26) Sign in link; it must not gain cn / ui imports either.
    expect(read("src/components/upgrade/UpgradeButton.tsx")).not.toMatch(/@\/lib\/utils|button-variants|@\/components\/ui\//);
  });

  it("dev fixture client imports nothing from other routes beyond the poller module it already used", () => {
    const imports = [...read("src/app/dev-upgrade/DevUpgradeClient.tsx").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((i) => i.startsWith("@/components/"))).toEqual(["@/components/upgrade/UpgradeStatusPoller"]);
    expect(read("src/app/dev-upgrade/page.tsx")).toMatch(/NODE_ENV === "production"\) notFound\(\)/);
  });

  it("recipe modules are plain (no use client, no imports)", () => {
    for (const f of ["upgrade-classes.ts", "upgrade-page-classes.ts", "upgrade-button-classes.ts"]) {
      expect(read(`src/components/upgrade/${f}`), f).not.toMatch(/^"use client"|^import /m);
    }
  });

  it("success page: band back link to the editor, motion CSS imported, still never reads session_id", () => {
    const src = read("src/app/books/[id]/upgrade/success/page.tsx");
    expect(src).toMatch(/href=\{`\/books\/\$\{id\}\/edit`\} className=\{UPGRADE_BAND_BACK\} data-testid="upgrade-back"/);
    expect(src).toContain('import "@/components/upgrade/upgrade-motion.css"');
    expect(src).toContain('width="library"');
    expect(src).not.toMatch(/searchParams/);
  });

  it("motion CSS: every animation sits under prefers-reduced-motion: no-preference; arc + burst hidden outside it; no box-shadow keyframes", () => {
    const css = read("src/components/upgrade/upgrade-motion.css");
    const open = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(open).toBeGreaterThan(0);
    const outside = css.slice(0, open);
    expect(outside).not.toMatch(/animation:/);
    expect(outside).toMatch(/\.up-seal-arc \{[^}]*display: none;/);
    expect(outside).toMatch(/\.up-burst \{[^}]*display: none;/);
    // The burst runs once.
    expect(css).toMatch(/\.up-burst > i \{\s*animation: up-burst [^;]* 1 both;/);
    const keyframes = css.slice(css.indexOf("@keyframes"));
    expect(keyframes).not.toMatch(/box-shadow|width|height|top|left/);
  });

  it("contrast: card, pills, seals, band on the leather, notice", () => {
    for (const [name, fg, bg, min] of [...classes.UPGRADE_CONTRAST, ...pageClasses.UPGRADE_BAND_CONTRAST]) {
      expect(contrastRatio(fg, bg), name).toBeGreaterThanOrEqual(min);
    }
    expect(contrastRatio("#1b1b1d", "#fbf2e2")).toBeGreaterThanOrEqual(4.5); // notice text
    expect(contrastRatio("#8a5a12", "#f6e3bf")).toBeGreaterThanOrEqual(3); // notice icon (graphic)
    expect(contrastRatio("#7a5f0e", "#faf6ee")).toBeGreaterThanOrEqual(4.5); // gold text on light
  });
});

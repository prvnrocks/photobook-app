// M23 T5/T6 (D-075): the viewer's message screens (password, expired, unavailable, not found) on
// leather with one cream card, one gold action per screen, and the dev-viewer ?state= previews.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("@/app/b/[slug]/actions", () => ({ unlockBookAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/b/x",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The book preview island is not under test here (and is owned by other tasks).
vi.mock("@/app/dev-viewer/DevViewerClient", () => ({ DevViewerClient: () => null }));

import BookNotFound from "@/app/b/[slug]/not-found";
import DevViewerPage from "@/app/dev-viewer/page";
import { BookUnavailable } from "@/components/viewer/public/BookUnavailable";
import { ExpiredBook } from "@/components/viewer/public/ExpiredBook";
import { PasswordGate } from "@/components/viewer/public/PasswordGate";

const root = join(__dirname, "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const golds = (html: string) => html.match(/home-foil-fill/g)?.length ?? 0;
/** The data-testid of the element carrying the gold fill. */
const goldTestId = (html: string) => html.match(/<(?:a|button)\b[^>]*home-foil-fill[^>]*data-testid="([^"]+)"/)?.[1] ?? null;

const owner = (paymentsEnabled: boolean) =>
  renderToStaticMarkup(
    <ExpiredBook
      isOwner
      editorHref="/books/b1/edit"
      upgrade={{ bookId: "b1", returnTo: "/b/s", paymentsEnabled }}
    />,
  );

const screens: { name: string; html: string; gold: string | null }[] = [
  { name: "password", html: renderToStaticMarkup(<PasswordGate slug="our-trip-AbCdEfGhJk" />), gold: "password-submit" },
  { name: "expired visitor", html: renderToStaticMarkup(<ExpiredBook isOwner={false} />), gold: "expired-create" },
  { name: "expired owner, payments on", html: owner(true), gold: "expired-upgrade" },
  { name: "expired owner, payments off", html: owner(false), gold: "expired-upgrade" },
  { name: "unavailable", html: renderToStaticMarkup(<BookUnavailable />), gold: null },
  { name: "not found", html: renderToStaticMarkup(<BookNotFound />), gold: "not-found-create" },
];

describe("viewer message screens (M23 T5)", () => {
  for (const { name, html, gold } of screens) {
    it(`${name}: ${gold ? "exactly one gold action" : "no gold action"}`, () => {
      expect(golds(html)).toBe(gold ? 1 : 0);
      expect(goldTestId(html)).toBe(gold);
    });

    it(`${name}: leather screen, cream card, seal, eyebrow, h1 dir=auto first, brand link`, () => {
      expect(html).toContain("home-leather");
      expect(html).toContain("bg-[#faf5ec]");
      expect(html).toMatch(/<span class="[^"]*rounded-full bg-\[#0e3b2e\][^"]*" aria-hidden="true"><svg/);
      expect(html).toMatch(/<p class="[^"]*tracking-\[0\.24em\][^"]*">[A-Z][a-z ]+<\/p><h1 dir="auto"/);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).toContain('<a href="/"');
    });
  }

  it("expired owner: Open in editor is emerald (not gold) and keeps its href", () => {
    const html = owner(true);
    expect(html).toMatch(/<a href="\/books\/b1\/edit" class="[^"]*border-\[#0e3b2e\][^"]*" data-testid="expired-open-editor">Open in editor<\/a>/);
  });

  it("password gate: no title / cover / slug, form testids kept, 44 px input with emerald focus", () => {
    const html = screens[0].html;
    expect(html).not.toContain("our-trip");
    expect(html).not.toContain("<img");
    expect(html).toMatch(/<input[^>]*class="h-11 [^"]*focus-visible:ring-\[#0e3b2e\]/);
    for (const id of ["password-gate", "password-input", "password-submit"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain("Open photobook");
  });

  it("ViewerMessage and PasswordGate stay small: no next/link, EmptyState, cn or button variants", () => {
    for (const f of [
      "src/components/viewer/public/ViewerMessage.tsx",
      "src/components/viewer/public/PasswordGate.tsx",
      "src/components/viewer/public/PasswordGateScreen.tsx",
    ]) {
      const s = src(f);
      expect(s, f).not.toMatch(/from "next\/link"/);
      const imports = s.match(/^import[^;]*;/gm)?.join("\n") ?? "";
      expect(imports, f).not.toMatch(/EmptyState|button-classes|buttonVariants|@\/lib\/utils|"zod"|ui\/button/);
    }
  });

  it("no next/link in any message screen", () => {
    for (const f of [
      "src/components/viewer/public/ExpiredBook.tsx",
      "src/components/viewer/public/ExpiredBookScreen.tsx",
      "src/components/viewer/public/BookUnavailable.tsx",
      "src/components/viewer/public/BookNotFoundScreen.tsx",
      "src/app/b/[slug]/not-found.tsx",
    ]) {
      expect(src(f), f).not.toMatch(/from "next\/link"/);
    }
  });

  it("/b/[slug] theme colour is the leather emerald", () => {
    expect(src("src/app/b/[slug]/page.tsx")).toContain('themeColor: "#0e3b2e"');
  });
});

describe("dev-viewer ?state= (M23 T6)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const render = async (q: Record<string, string>) =>
    renderToStaticMarkup(await DevViewerPage({ searchParams: Promise.resolve(q) }));

  it.each([
    ["password", "password-gate"],
    ["expired", "expired-create"],
    ["expiredOwner", "expired-open-editor"],
    ["unavailable", "book-unavailable"],
    ["notFound", "book-not-found"],
  ])("state=%s renders the %s screen", async (state, testId) => {
    expect(await render({ state })).toContain(`data-testid="${testId}"`);
  });

  it("expiredOwner: payments off by default, on with payments=1", async () => {
    expect(await render({ state: "expiredOwner" })).toContain("Payments unavailable");
    expect(await render({ state: "expiredOwner", payments: "1" })).not.toContain("Payments unavailable");
  });

  it("unknown state falls through to the book preview", async () => {
    expect(await render({ state: "bogus" })).not.toContain("home-leather");
  });

  it("404s in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(render({ state: "password" })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("expiredOwner stand-in mirrors UpgradeButton's markup (gold, testids, disabled + hint when off)", async () => {
    const off = await render({ state: "expiredOwner" });
    expect(off).toMatch(/<button type="button" disabled=""[^>]*aria-describedby="expired-upgrade-unavailable"[^>]*home-foil-fill[^>]*data-testid="expired-upgrade">/);
    expect(off).toContain('data-testid="expired-upgrade-wrap" data-payments="off"');
    expect(off).toContain("Upgrade to bring it back — AED 39");
    expect(golds(off)).toBe(1);
    const on = await render({ state: "expiredOwner", payments: "1" });
    expect(on).toContain('data-payments="on"');
    expect(on).not.toMatch(/disabled=""[^>]*data-testid="expired-upgrade"/);
  });

  it("password preview is the shared PasswordGateScreen (same form testids, one gold)", async () => {
    const html = await render({ state: "password" });
    for (const id of ["password-gate", "password-input", "password-submit"]) expect(html).toContain(`data-testid="${id}"`);
    expect(golds(html)).toBe(1);
  });

  it("the server page references no client module /b uses (chunk splitting, lesson M22)", () => {
    const s = src("src/app/dev-viewer/page.tsx");
    const imports = s.match(/^import[^;]*;/gm)?.join("\n") ?? "";
    expect(imports).not.toMatch(/PasswordGate"|ExpiredBook"|UpgradeButton|UpgradeCancelledNotice|PublicViewer|@\/app\/b\//);
    // Every viewer/public module it does import is a server module without client imports.
    for (const m of imports.matchAll(/"@\/components\/viewer\/public\/(\w+)"/g)) {
      const f = `src/components/viewer/public/${m[1]}.tsx`;
      const body = src(f);
      expect(body, f).not.toMatch(/^\s*["']use client["']/m);
      expect(body, f).not.toMatch(/from "@\/components\/upgrade\/|from "\.\/(PasswordGate|ExpiredBook|PublicViewer)"/);
    }
  });

  it("the client island imports no viewer/public or app route modules", () => {
    const s = src("src/app/dev-viewer/DevViewerClient.tsx");
    expect(s).not.toMatch(/viewer\/public|@\/app\//);
  });
});

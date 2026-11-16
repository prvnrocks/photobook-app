// M25 (D-077): /login in the emerald style — testids and behaviour hooks kept in both steps (email and
// 6-digit code), exactly one gold action per step, 44 px+ controls, numeric contrast for every text
// pair, the decorative book (aria-hidden, lazy, float only without reduced motion), and no
// cn/buttonVariants/next/link/Button in the LoginForm client island. Static renders; actions mocked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AuthFormState } from "@/lib/auth/form-state";

vi.mock("server-only", () => ({}));
vi.mock("@/app/auth/actions", () => ({
  sendMagicLink: vi.fn(),
  signInWithGoogle: vi.fn(),
  verifyEmailCode: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => null }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

// Force the send action's state (first useActionState call) to render the code step statically.
const forced: { send: AuthFormState | null } = { send: null };
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  let call = 0;
  return {
    ...actual,
    useActionState: ((fn: never, init: never) => {
      const real = actual.useActionState(fn, init);
      const isSend = call++ % 2 === 0;
      return isSend && forced.send ? [forced.send, real[1], false] : real;
    }) as typeof actual.useActionState,
  };
});

const { LoginForm } = await import("@/components/auth/LoginForm");
const LoginPage = (await import("@/app/login/page")).default;
const LG = await import("@/components/auth/login-classes");
const { contrastRatio } = await import("@/lib/app/palette");
const { HERO_BOOK } = await import("@/lib/marketing/hero");

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const tagOf = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const count = (html: string, needle: string) => html.split(needle).length - 1;
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function renderEmailStep(error = false) {
  forced.send = null;
  return renderToStaticMarkup(<LoginForm next="/books/new" error={error} />);
}
function renderCodeStep() {
  forced.send = { ok: true, email: "sara@example.com" };
  try {
    return renderToStaticMarkup(<LoginForm next="/books/new" />);
  } finally {
    forced.send = null;
  }
}
async function renderPage(search: Record<string, string> = {}) {
  const el = await LoginPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(el);
}

describe("LoginForm — email step", () => {
  const html = renderEmailStep();

  it("keeps testids, hidden next, autocomplete/inputMode and copy", () => {
    for (const id of ["login-email", "login-send", "login-google", "login-next"]) expect(has(html, id)).toBe(true);
    expect(tagOf(html, "login-next")).toContain('value="/books/new"');
    const email = tagOf(html, "login-email");
    expect(email).toContain('type="email"');
    expect(email).toContain('inputMode="email"');
    expect(email).toContain('autoComplete="email"');
    expect(email).toContain("required");
    expect(html).toContain("Email me a sign-in link");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Opening this from WhatsApp?");
    expect(has(html, "login-error")).toBe(false);
  });

  it("exactly one gold action — the email CTA; Google is the emerald outline", () => {
    expect(count(html, "home-foil-fill")).toBe(1);
    expect(tagOf(html, "login-send")).toContain("home-foil-fill");
    expect(tagOf(html, "login-google")).toContain("border-[#0e3b2e]");
    expect(tagOf(html, "login-google")).not.toContain("home-foil-fill");
  });

  it("plain submit buttons, 48 px, not busy at rest", () => {
    for (const id of ["login-send", "login-google"]) {
      const tag = tagOf(html, id);
      expect(tag.startsWith("<button")).toBe(true);
      expect(tag).toContain('type="submit"');
      expect(tag).toContain("h-12");
      expect(tag).toContain('aria-busy="false"');
    }
    expect(tagOf(html, "login-email")).toContain("h-12");
    expect(tagOf(html, "login-email")).toContain("text-base");
  });

  it("error=auth shows the soft error card (role=alert)", () => {
    const err = renderEmailStep(true);
    expect(tagOf(err, "login-error")).toContain('role="alert"');
    expect(err).toContain("That sign-in link has expired");
  });
});

describe("LoginForm — code step", () => {
  const html = renderCodeStep();

  it("shows the code field with one-time-code hints, resend and change email", () => {
    expect(has(html, "login-code")).toBe(true);
    expect(has(html, "login-verify")).toBe(true);
    expect(has(html, "login-email")).toBe(false);
    const code = tagOf(html, "login-code");
    expect(code).toContain('inputMode="numeric"');
    expect(code).toContain('autoComplete="one-time-code"');
    expect(code).toContain('maxLength="6"');
    expect(code).toContain("text-center");
    expect(code).toContain("h-12");
    expect(html).toContain("sara@example.com");
    expect(html).toContain("Use a different email");
    expect(html).toContain("Resend");
    expect(html).toContain('aria-live="polite"');
  });

  it("exactly one gold action — Sign in with code", () => {
    expect(count(html, "home-foil-fill")).toBe(1);
    expect(tagOf(html, "login-verify")).toContain("home-foil-fill");
  });

  it("every button is ≥ 44 px (h-12)", () => {
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(4); // verify, change email, resend, Google
    for (const b of buttons) expect(b).toContain("h-12");
  });
});

describe("LoginForm island stays light", () => {
  const src = stripComments(read("src/components/auth/LoginForm.tsx"));
  const recipes = read("src/components/auth/login-classes.ts");

  it("no cn / buttonVariants / next/link / shadcn Button", () => {
    expect(src).not.toMatch(/from "@\/lib\/utils"/);
    expect(src).not.toMatch(/\bcn\(/);
    expect(src).not.toMatch(/buttonVariants/);
    expect(src).not.toMatch(/next\/link/);
    expect(src).not.toMatch(/@\/components\/ui\/button/);
    expect(src).not.toMatch(/<Button\b/);
  });

  it("login-classes is import-free plain strings", () => {
    expect(stripComments(recipes)).not.toMatch(/^\s*import\s/m);
    expect(stripComments(recipes)).not.toContain('"use client"');
    for (const [, v] of Object.entries(LG)) expect(typeof v).toBe("string");
  });

  it("no transforms; every transition has motion-reduce:transition-none", () => {
    for (const [name, v] of Object.entries(LG)) {
      expect(v, name).not.toMatch(/(^|\s|:)-?(translate|scale|rotate)-/);
      if (/(^|\s)transition/.test(v)) expect(v, name).toContain("motion-reduce:transition-none");
    }
  });
});

describe("/login page", () => {
  it("keeps the heading, eyebrow, body and legal line with Terms/Privacy links", async () => {
    const html = await renderPage();
    expect(count(html, "<h1")).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Sign in to [^<]+<\/h1>/);
    expect(html).toContain(">Welcome<");
    expect(html).toContain("No password needed.");
    const legal = html.slice(html.indexOf('data-testid="login-legal"'));
    expect(legal).toContain('href="/terms"');
    expect(legal).toContain('href="/privacy"');
    expect(html).toContain("home-leather");
  });

  it("one gold action on the whole page", async () => {
    expect(count(await renderPage(), "home-foil-fill")).toBe(1);
  });

  it("brand panel is ≥lg only; the book is decorative, lazy and floats", async () => {
    const html = await renderPage();
    expect(tagOf(html, "login-brand")).toMatch(/\bhidden\b/);
    expect(tagOf(html, "login-brand")).toContain("lg:flex");
    const book = html.slice(html.indexOf('data-testid="login-book"'));
    expect(tagOf(html, "login-book")).toContain('aria-hidden="true"');
    const img = book.match(/<img[^>]*>/)?.[0] ?? "";
    expect(img).toContain(`src="${HERO_BOOK.src}"`);
    expect(img).toContain('alt=""');
    expect(img).toContain('loading="lazy"');
    expect(img).toContain("home-float");
    expect(html).toContain("Your memories,");
  });

  it("passes the sanitised next and the auth error through", async () => {
    const html = await renderPage({ next: "//evil.com", error: "auth" });
    expect(tagOf(html, "login-next")).toContain('value="/dashboard"');
    expect(has(html, "login-error")).toBe(true);
  });
});

describe("reduced motion", () => {
  it("home-float animates only under prefers-reduced-motion: no-preference", () => {
    const css = read("src/app/globals.css");
    const i = css.indexOf("@utility home-float");
    expect(i).toBeGreaterThan(-1);
    const body = css.slice(i, css.indexOf("\n}\n", i));
    expect(body).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*animation: home-float/);
    expect(body.replace(/@media[\s\S]*$/, "")).not.toContain("animation");
  });
});

// Every text / background pair the login design relies on, recomputed (WCAG AA).
const CARD = "#fffdf8";
const IVORY = "#faf5ec";
const MINT = "#e6efe9";
const FOIL_DARKEST = "#bf9a23";
const LEATHER_LIGHTEST = "#1f5443";
const CREAM_PANEL = "#f4ede0";
const CREAM_PANEL_LIGHT = "#fbf7ef";

const TEXT_PAIRS: { name: string; fg: string; bg: string; min: number; where: string }[] = [
  { name: "label ink on card", fg: "#1b1b1d", bg: CARD, min: 4.5, where: LG.LG_LABEL },
  { name: "input ink on ivory", fg: "#1b1b1d", bg: IVORY, min: 4.5, where: LG.LG_INPUT },
  { name: "placeholder on ivory", fg: "#6b665c", bg: IVORY, min: 4.5, where: LG.LG_INPUT },
  { name: "code ink on ivory", fg: "#1b1b1d", bg: IVORY, min: 4.5, where: LG.LG_CODE_INPUT },
  { name: "gold CTA ink on foil darkest", fg: "#1b1b1d", bg: FOIL_DARKEST, min: 4.5, where: LG.LG_CTA_GOLD },
  { name: "outline emerald on card", fg: "#0e3b2e", bg: CARD, min: 4.5, where: LG.LG_CTA_OUTLINE },
  { name: "outline emerald on hover mint", fg: "#0e3b2e", bg: MINT, min: 4.5, where: LG.LG_CTA_OUTLINE },
  { name: "ghost emerald on card", fg: "#0e3b2e", bg: CARD, min: 4.5, where: LG.LG_CTA_GHOST },
  { name: "divider ink-soft on card", fg: "#4a4740", bg: CARD, min: 4.5, where: LG.LG_DIVIDER },
  { name: "hint ink-soft on card", fg: "#4a4740", bg: CARD, min: 4.5, where: LG.LG_HINT },
  { name: "sent card ink on mint", fg: "#1b1b1d", bg: MINT, min: 4.5, where: LG.LG_SENT_CARD },
];

const PAGE_PAIRS: { name: string; fg: string; bg: string; min: number }[] = [
  { name: "eyebrow antique gold on card", fg: "#7a5f0e", bg: CARD, min: 4.5 },
  { name: "heading emerald on card", fg: "#0e3b2e", bg: CARD, min: 4.5 },
  { name: "body ink-soft on card", fg: "#4a4740", bg: CARD, min: 4.5 },
  { name: "wordmark cream on leather lightest", fg: "#f2e8d8", bg: LEATHER_LIGHTEST, min: 4.5 },
  { name: "legal muted cream on leather lightest (phones)", fg: "#d7cdb9", bg: LEATHER_LIGHTEST, min: 4.5 },
  { name: "legal link cream on leather lightest (phones)", fg: "#f2e8d8", bg: LEATHER_LIGHTEST, min: 4.5 },
  { name: "panel eyebrow pale gold on leather lightest", fg: "#e3c766", bg: LEATHER_LIGHTEST, min: 4.5 },
  { name: "panel headline foil lightest-stop min on leather lightest", fg: "#d9b84a", bg: LEATHER_LIGHTEST, min: 4.5 },
  { name: "panel subcopy muted cream on leather lightest", fg: "#d7cdb9", bg: LEATHER_LIGHTEST, min: 4.5 },
  { name: "legal ink-soft on cream panel (≥lg)", fg: "#4a4740", bg: CREAM_PANEL, min: 4.5 },
  { name: "legal ink-soft on cream panel centre (≥lg)", fg: "#4a4740", bg: CREAM_PANEL_LIGHT, min: 4.5 },
  { name: "legal link emerald on cream panel (≥lg)", fg: "#0e3b2e", bg: CREAM_PANEL, min: 4.5 },
];

const NONTEXT_PAIRS: { name: string; fg: string; bg: string }[] = [
  { name: "field hairline on ivory", fg: "#8c8270", bg: IVORY },
  { name: "field hairline on card", fg: "#8c8270", bg: CARD },
  { name: "emerald focus ring / outline border on card", fg: "#0e3b2e", bg: CARD },
  { name: "sent icon emerald on mint", fg: "#0e3b2e", bg: MINT },
];

describe("contrast (AA, computed)", () => {
  it.each(TEXT_PAIRS.map((p) => [p.name, p] as const))("%s ≥ 4.5:1 and the recipe uses it", (_n, p) => {
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
    expect(p.where).toContain(p.fg);
  });

  it.each(PAGE_PAIRS.map((p) => [p.name, p] as const))("%s ≥ 4.5:1", (_n, p) => {
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
  });

  it.each(NONTEXT_PAIRS.map((p) => [p.name, p] as const))("non-text %s ≥ 3:1", (_n, p) => {
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(3);
  });

  it("the page uses the hexes its pairs claim", () => {
    const page = read("src/app/login/page.tsx");
    for (const hex of ["#fffdf8", "#7a5f0e", "#0e3b2e", "#4a4740", "#f2e8d8", "#d7cdb9", "#e3c766", "#f4ede0", "#fbf7ef"]) {
      expect(page, hex).toContain(hex);
    }
    expect(LG.LG_CTA_GOLD).toContain(`focus-visible:ring-offset-[${CARD}]`);
  });
});

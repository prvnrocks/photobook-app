// M11 T5–T7: app header + account menu, route loading / not-found screens, login card,
// settings danger zone, landing restyle. Static renders (no DOM); server actions are mocked.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/auth/actions", () => ({
  signOut: vi.fn(),
  sendMagicLink: vi.fn(),
  signInWithGoogle: vi.fn(),
  verifyEmailCode: vi.fn(),
}));
vi.mock("@/app/settings/actions", () => ({
  setEmailRemindersAction: vi.fn(),
  deleteAccountAction: vi.fn(),
  clearMemoryAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { AppHeader, AppHeaderPlaceholder } = await import("@/components/layout/AppHeader");
const { AccountMenu, accountInitial } = await import("@/components/layout/AccountMenu");
const { RouteLoading, EditorLoading } = await import("@/components/layout/RouteLoading");
const NotFound = (await import("@/app/not-found")).default;
const { LoginForm } = await import("@/components/auth/LoginForm");
const { DeleteAccountView } = await import("@/components/settings/DeleteAccount");
const { SettingsMemory } = await import("@/components/settings/SettingsMemory");
const { EmailRemindersToggleView } = await import("@/components/settings/EmailRemindersToggle");
const { SiteHeader } = await import("@/components/marketing/SiteHeader");
const { SiteFooter } = await import("@/components/marketing/SiteFooter");
const LandingPage = (await import("@/app/(marketing)/page")).default;
const { CTA_LABEL, HERO_CLAIM } = await import("@/lib/marketing/copy");

const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const tagOf = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

describe("AppHeader + account menu (T5)", () => {
  const html = renderToStaticMarkup(<AppHeader displayName="sara.alhashimi.long-address@example.com" />);

  it("keeps the header testids inside the account menu", () => {
    for (const id of ["header-user", "header-settings", "sign-out", "account-menu-button", "account-menu"]) {
      expect(has(html, id)).toBe(true);
    }
    // Menu content follows the menu button in the DOM (inside the popover).
    expect(html.indexOf('data-testid="account-menu"')).toBeLessThan(html.indexOf('data-testid="header-user"'));
  });

  it("menu is closed on first render; button announces it", () => {
    expect(tagOf(html, "account-menu")).toMatch(/hidden=""/);
    const btn = tagOf(html, "account-menu-button");
    expect(btn).toContain('aria-expanded="false"');
    expect(btn).toContain('aria-label="Account menu"');
    expect(btn).toMatch(/h-11/);
  });

  it("serif wordmark links home to the dashboard", () => {
    const home = tagOf(html, "header-home");
    expect(home).toContain('href="/dashboard"');
    expect(home).toContain("font-display");
  });

  it("the full email is shown (not truncated) with dir=auto; settings link + sign-out submit", () => {
    const user = tagOf(html, "header-user");
    expect(user).toContain('dir="auto"');
    expect(user).not.toContain("truncate");
    expect(tagOf(html, "header-settings")).toContain('href="/settings"');
    expect(tagOf(html, "sign-out")).toContain('type="submit"');
    expect(html).toContain("Sign out");
  });

  it("no name → no header-user row, menu still has Settings and Sign out", () => {
    const anon = renderToStaticMarkup(<AppHeader displayName={null} />);
    expect(has(anon, "header-user")).toBe(false);
    expect(has(anon, "header-settings")).toBe(true);
    expect(has(anon, "sign-out")).toBe(true);
  });

  it("defaultOpen shows the panel", () => {
    const open = renderToStaticMarkup(
      <AccountMenu displayName="x" defaultOpen>
        <p>inside</p>
      </AccountMenu>,
    );
    expect(tagOf(open, "account-menu")).not.toMatch(/hidden=""/);
    expect(tagOf(open, "account-menu-button")).toContain('aria-expanded="true"');
  });

  it("accountInitial: first letter, Arabic safe, fallback", () => {
    expect(accountInitial("sara@example.com")).toBe("S");
    expect(accountInitial("  omar")).toBe("O");
    expect(accountInitial("سارة")).toBe("س");
    expect(accountInitial(null)).toBe("?");
    expect(accountInitial("")).toBe("?");
  });

  it("placeholder header has no account data", () => {
    const ph = renderToStaticMarkup(<AppHeaderPlaceholder />);
    expect(has(ph, "header-home")).toBe(true);
    expect(has(ph, "account-menu-button")).toBe(false);
  });
});

describe("route loading + not-found (T5)", () => {
  it("RouteLoading shows header + polite skeleton with its label", () => {
    const html = renderToStaticMarkup(<RouteLoading label="Loading your books…" width="wide" />);
    expect(has(html, "header-home")).toBe(true);
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(html).toContain("Loading your books…");
    expect(html).toContain("max-w-wide");
  });

  it("RouteLoading header={false} skips the header (publish)", () => {
    expect(has(renderToStaticMarkup(<RouteLoading header={false} />), "header-home")).toBe(false);
  });

  it("EditorLoading announces itself", () => {
    const html = renderToStaticMarkup(<EditorLoading />);
    expect(html).toContain("Opening the editor…");
    expect(html).toContain('aria-live="polite"');
  });

  it("app not-found: serif title + dashboard and home links", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(has(html, "app-not-found")).toBe(true);
    expect(html).toContain("We couldn&#x27;t find that page");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/"');
  });
});

describe("login (T7)", () => {
  it("keeps testids, 48 px CTA buttons and 16 px+ email input", () => {
    const html = renderToStaticMarkup(<LoginForm next="/dashboard" />);
    for (const id of ["login-email", "login-send", "login-google", "login-next"]) expect(has(html, id)).toBe(true);
    expect(tagOf(html, "login-send")).toContain("h-12");
    expect(tagOf(html, "login-google")).toContain("h-12");
    expect(tagOf(html, "login-email")).toContain("text-base");
    expect(has(html, "login-error")).toBe(false);
  });

  it("error=auth shows the error Notice (role=alert)", () => {
    const html = renderToStaticMarkup(<LoginForm next="/dashboard" error />);
    expect(tagOf(html, "login-error")).toContain('role="alert"');
    expect(html).toContain("That sign-in link has expired");
  });
});

describe("settings (T7)", () => {
  it("delete account is styled as a danger zone and keeps its testids", () => {
    const html = renderToStaticMarkup(<DeleteAccountView deleteAccount={async () => {}} />);
    expect(tagOf(html, "settings-delete-account")).toContain("border-destructive-border");
    for (const id of ["settings-delete-input", "settings-delete-button"]) expect(has(html, id)).toBe(true);
    expect(tagOf(html, "settings-delete-button")).toContain("h-11");
  });

  it("regular settings are cards; load errors use the error Notice", () => {
    const failed = renderToStaticMarkup(<SettingsMemory view={undefined} />);
    expect(tagOf(failed, "settings-memory")).toContain("bg-card");
    expect(tagOf(failed, "settings-error")).toContain('role="alert"');
    const reminders = renderToStaticMarkup(<EmailRemindersToggleView initialOn={null} save={async () => ({ ok: true, on: true })} />);
    expect(tagOf(reminders, "settings-reminders-load-error")).toContain('role="alert"');
  });
});

describe("landing (T6)", () => {
  const html = renderToStaticMarkup(<LandingPage />);

  it("hero: serif display headline, one accent CTA", () => {
    expect(tagOf(html, "hero-heading")).toContain("type-display");
    expect(tagOf(html, "cta-create")).toContain("bg-accent-strong");
    expect(html.match(/bg-accent-strong text-accent-strong-foreground/g)?.length).toBe(1);
    expect(html).toContain(CTA_LABEL);
    expect(html.length).toBeGreaterThan(HERO_CLAIM.length);
  });

  it("no raw amber/emerald palette classes left on public pages", () => {
    const all = html + renderToStaticMarkup(<SiteHeader />) + renderToStaticMarkup(<SiteFooter />);
    expect(all).not.toMatch(/\b(?:bg|text|from|via|to|border)-(?:amber|emerald|neutral)-\d+/);
  });

  it("header Sign in is a 44 px target; footer keeps Made in Abu Dhabi once", () => {
    expect(tagOf(renderToStaticMarkup(<SiteHeader />), "header-signin")).toContain("h-11");
    const footer = renderToStaticMarkup(<SiteFooter />);
    expect(footer.match(/Made in Abu Dhabi/g)?.length).toBe(1);
  });
});

// M24 (D-076): /settings in the emerald style — band (heading/email testids, dir=auto), section nav
// anchors that match the page's section ids, account card, emerald switch semantics, quiet danger zone
// (button disabled until DELETE), memory card rows as a definition list, numeric contrast, and no
// cn/buttonVariants/next/link/Button in the client islands. Static renders; server actions mocked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/settings/actions", () => ({
  setEmailRemindersAction: vi.fn(),
  deleteAccountAction: vi.fn(),
  clearMemoryAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { SettingsBand } = await import("@/components/settings/SettingsBand");
const { SettingsNav, SETTINGS_SECTIONS } = await import("@/components/settings/SettingsNav");
const { SettingsAccount } = await import("@/components/settings/SettingsAccount");
const { SettingsMemory } = await import("@/components/settings/SettingsMemory");
const { EmailRemindersToggleView } = await import("@/components/settings/EmailRemindersToggle");
const { DeleteAccountView } = await import("@/components/settings/DeleteAccount");
const Loading = (await import("@/app/settings/loading")).default;
const classes = await import("@/components/settings/settings-classes");
const pageClasses = await import("@/components/settings/settings-page-classes");
const { contrastRatio } = await import("@/lib/app/palette");
const { SETTINGS_COPY } = await import("@/lib/settings/ui");

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const tagOf = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

describe("band", () => {
  const html = renderToStaticMarkup(<SettingsBand email="sara@example.com" back={<a href="/dashboard">My books</a>} />);

  it("keeps the heading and email testids, email in its own dir=auto span", () => {
    expect(tagOf(html, "settings-heading")).toMatch(/^<h1/);
    expect(html).toContain(`>${SETTINGS_COPY.heading}</h1>`);
    expect(tagOf(html, "settings-email")).toContain('dir="auto"');
    expect(html).toMatch(/data-testid="settings-email">sara@example\.com<\/span>/);
    expect(html).toContain("Signed in as");
    expect(html).toContain(">Account<");
    expect(html).toContain('href="/dashboard"');
    expect(tagOf(html, "settings-band")).toContain("home-leather");
  });

  it("no email → no chip", () => {
    expect(has(renderToStaticMarkup(<SettingsBand email={null} />), "settings-email")).toBe(false);
  });
});

describe("section nav + page anchors", () => {
  const html = renderToStaticMarkup(<SettingsNav />);
  const page = read("src/app/settings/page.tsx");

  it("links to #account, #email-reminders, #ai-memory, #danger-zone as plain 44 px anchors", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(["account", "email-reminders", "ai-memory", "danger-zone"]);
    for (const s of SETTINGS_SECTIONS) {
      const tag = tagOf(html, `settings-nav-${s.id}`);
      expect(tag).toMatch(/^<a /);
      expect(tag).toContain(`href="#${s.id}"`);
      expect(tag).toContain("min-h-11");
      // Every anchor has a target on the page.
      expect(page).toContain(`id="${s.id}"`);
    }
    expect(tagOf(html, "settings-nav")).toContain('aria-label="Settings sections"');
    expect(tagOf(html, "settings-nav")).toContain("lg:block");
  });

  it("the page keeps back-to-dashboard and the library-width header", () => {
    expect(page).toMatch(/href="\/dashboard"[^>]*data-testid="back-to-dashboard"/);
    expect(page).toContain('width="library"');
    expect(pageClasses.SETTINGS_ANCHOR).toContain("scroll-mt-");
  });
});

describe("cards", () => {
  it("account card shows the email with dir=auto", () => {
    const html = renderToStaticMarkup(<SettingsAccount email="سارة@example.com" />);
    expect(tagOf(html, "settings-account-email")).toContain('dir="auto"');
    expect(html).toContain("<dl");
  });

  it("memory rows are a definition list in the cream well; clear is an emerald outline pill", () => {
    const html = renderToStaticMarkup(<SettingsMemory view={{ tone: "warm", knownNames: ["Layla"], updatedAt: "2026-11-14T10:00:00Z" }} />);
    expect(tagOf(html, "settings-memory-list")).toMatch(/^<dl /);
    expect(tagOf(html, "settings-memory-list")).toContain("bg-[#faf6ee]");
    expect(html).toMatch(/<dt[^>]*>/);
    expect(tagOf(html, "settings-clear")).toContain("border-[#0e3b2e]/30");
    expect(tagOf(html, "settings-clear")).toContain("min-h-11");
  });
});

describe("email reminders switch", () => {
  const save = async () => ({ ok: true as const, on: true });

  it("keeps role=switch, aria-checked and the labels; on = emerald track, off = muted track", () => {
    const on = renderToStaticMarkup(<EmailRemindersToggleView initialOn save={save} />);
    const off = renderToStaticMarkup(<EmailRemindersToggleView initialOn={false} save={save} />);
    for (const [html, checked] of [[on, "true"], [off, "false"]] as const) {
      const tag = tagOf(html, "settings-reminders-toggle");
      expect(tag).toContain('role="switch"');
      expect(tag).toContain(`aria-checked="${checked}"`);
      expect(tag).toContain('aria-labelledby="settings-reminders-heading"');
      expect(tag).toContain('aria-describedby="settings-reminders-detail"');
      expect(tag).toContain("min-h-11");
    }
    expect(on).toContain(classes.SETTINGS_SWITCH_TRACK_ON);
    expect(off).toContain(classes.SETTINGS_SWITCH_TRACK_OFF);
    expect(classes.SETTINGS_SWITCH_TRACK_ON).toContain("bg-[#0e3b2e]");
    // Reduced motion: the thumb and track don't animate.
    for (const c of [classes.SETTINGS_SWITCH_THUMB_ON, classes.SETTINGS_SWITCH_THUMB_OFF, classes.SETTINGS_SWITCH_TRACK_OFF]) {
      expect(c).toContain("motion-reduce:transition-none");
    }
  });
});

describe("danger zone", () => {
  it("quiet and disabled until DELETE is typed, then red and enabled", () => {
    const idle = renderToStaticMarkup(<DeleteAccountView deleteAccount={async () => {}} />);
    expect(tagOf(idle, "settings-delete-account")).toContain('data-state="quiet"');
    expect(tagOf(idle, "settings-delete-button")).toContain('disabled=""');
    expect(tagOf(idle, "settings-delete-button")).not.toContain("bg-destructive ");

    const partial = renderToStaticMarkup(<DeleteAccountView deleteAccount={async () => {}} initialText="DELET" />);
    expect(tagOf(partial, "settings-delete-button")).toContain('disabled=""');

    const armed = renderToStaticMarkup(<DeleteAccountView deleteAccount={async () => {}} initialText="DELETE" />);
    expect(tagOf(armed, "settings-delete-account")).toContain('data-state="armed"');
    expect(tagOf(armed, "settings-delete-button")).not.toContain('disabled=""');
    expect(tagOf(armed, "settings-delete-button")).toContain("bg-destructive");
    expect(tagOf(armed, "settings-delete-input")).toContain('dir="ltr"');
  });

  it("the page sets the danger zone apart with a dashed rule and its label", () => {
    expect(pageClasses.SETTINGS_DANGER_ZONE).toContain("border-dashed");
    expect(read("src/app/settings/page.tsx")).toContain("Danger zone");
  });
});

describe("loading skeleton", () => {
  it("renders the band and four card shapes, announced once", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(tagOf(html, "page-skeleton")).toContain('role="status"');
    expect(html).toContain("Loading settings");
    expect(html).toContain("home-leather");
    expect(html.split("rounded-[1.75rem]").length - 1).toBeGreaterThanOrEqual(5);
  });
});

describe("contrast + bundle guardrails", () => {
  it("text and switch colours meet AA", () => {
    const leather = "#1f5443";
    expect(contrastRatio("#f2e8d8", leather)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#d7cdb9", leather)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#e3c766", leather)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#d7cdb9", "#143f33")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f2e8d8", "#143f33")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#0e3b2e", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#0e3b2e", "#faf6ee")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#b42318", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // Switch tracks are graphics: ≥ 3:1 against the white card.
    expect(contrastRatio("#0e3b2e", "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#8c8576", "#ffffff")).toBeGreaterThanOrEqual(3);
    // Account-deleted notice on the home leather.
    expect(contrastRatio("#f2e8d8", "#0f3a2d")).toBeGreaterThanOrEqual(4.5);
  });

  it("client islands use no cn, buttonVariants, next/link or the Button component", () => {
    for (const f of [
      "src/components/settings/EmailRemindersToggle.tsx",
      "src/components/settings/SettingsClearButton.tsx",
      "src/components/settings/DeleteAccount.tsx",
      "src/components/settings/AccountDeletedNotice.tsx",
    ]) {
      const src = read(f);
      expect(src.startsWith('"use client"'), f).toBe(true);
      expect(src, f).not.toMatch(/from "@\/lib\/utils"/);
      expect(src, f).not.toMatch(/button-variants|buttonVariants/);
      expect(src, f).not.toMatch(/from "next\/link"/);
      expect(src, f).not.toMatch(/from "@\/components\/ui\/button"/);
      expect(src, f).not.toMatch(/settings-page-classes/);
    }
    // The shared island recipes stay a plain module.
    expect(read("src/components/settings/settings-classes.ts")).not.toMatch(/^"use client"|import /m);
  });
});

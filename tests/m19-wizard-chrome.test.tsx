// M19 T2 (D-071): wizard step logic + static renders of the wizard chrome.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

const steps = await import("@/lib/books/wizard-steps");
const { WizardShell, WizardHeadline } = await import("@/components/wizard/WizardShell");
const { WizardProgress } = await import("@/components/wizard/WizardProgress");
const { WizardNav } = await import("@/components/wizard/WizardNav");
const { ChoiceCard } = await import("@/components/wizard/ChoiceCard");
const { SUPPORT_EMAIL } = await import("@/lib/brand");

const {
  WIZARD_STEPS,
  EMPTY_WIZARD_DRAFT,
  parseStep,
  firstMissingStep,
  canEnter,
  parseWizardDraft,
  serializeWizardDraft,
  wizardHeadline,
  wizardStepLabel,
} = steps;
type Draft = import("@/lib/books/wizard-steps").WizardDraft;

const full: Draft = {
  title: "Days by the Sea",
  occasion: "travel",
  captionLang: "en",
  format: "A5_LANDSCAPE",
  designStyle: "modern",
};

const tagOf = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

describe("wizard steps", () => {
  it("lists the six steps with their headlines", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["title", "occasion", "shape", "style", "photos", "sorting"]);
    expect(wizardHeadline(1)).toBe("Give your book a title");
    expect(wizardHeadline(2)).toBe("What's this book for?");
    expect(wizardHeadline(3)).toBe("Choose a page shape");
    expect(wizardHeadline(4)).toBe("Choose a book style");
    expect(wizardHeadline(5)).toBe("Add your photos");
    expect(wizardHeadline(6)).toBe("Sorting your photos");
    expect(wizardStepLabel(3)).toBe("Step 3 of 6");
  });

  it("parseStep accepts only 1–4", () => {
    expect(parseStep("1")).toBe(1);
    expect(parseStep("4")).toBe(4);
    expect(parseStep(["3", "2"])).toBe(3);
    expect(parseStep(2)).toBe(2);
    for (const bad of [undefined, null, "", "0", "5", "6", " 2", "2.0", "02", "abc", [], {}, 2.5, NaN]) {
      expect(parseStep(bad)).toBe(1);
    }
  });

  it("firstMissingStep walks the answers in order", () => {
    // M19 T3: an empty / blank title is allowed (we suggest one), so a fresh draft misses the occasion.
    expect(firstMissingStep(EMPTY_WIZARD_DRAFT)).toBe(2);
    expect(firstMissingStep({ ...full, title: "   " })).toBeNull();
    expect(firstMissingStep({ ...full, title: "a\ud800b" })).toBe(1);
    expect(firstMissingStep({ ...full, title: "x".repeat(121) })).toBe(1);
    expect(firstMissingStep({ ...full, title: "🌊".repeat(120) })).toBeNull();
    expect(firstMissingStep({ ...full, occasion: null })).toBe(2);
    expect(firstMissingStep({ ...full, format: null, designStyle: null })).toBe(3);
    expect(firstMissingStep({ ...full, designStyle: null })).toBe(4);
    expect(firstMissingStep(full)).toBeNull();
    // captionLang is not a step
    expect(firstMissingStep({ ...full, captionLang: null })).toBeNull();
    // occasion missing wins over later gaps
    expect(firstMissingStep({ ...full, occasion: null, format: null })).toBe(2);
  });

  it("canEnter allows the first missing step and earlier ones", () => {
    const d = { ...full, format: null, designStyle: null };
    expect(canEnter(1, d)).toBe(true);
    expect(canEnter(3, d)).toBe(true);
    expect(canEnter(4, d)).toBe(false);
    expect(canEnter(2, EMPTY_WIZARD_DRAFT)).toBe(true);
    expect(canEnter(3, EMPTY_WIZARD_DRAFT)).toBe(false);
    expect(canEnter(4, full)).toBe(true);
  });

  it("draft round-trips through serialize/parse", () => {
    expect(parseWizardDraft(serializeWizardDraft(full))).toEqual(full);
    expect(parseWizardDraft(serializeWizardDraft(EMPTY_WIZARD_DRAFT))).toEqual(EMPTY_WIZARD_DRAFT);
    const ar = { ...full, title: "أيام البحر", captionLang: "ar" as const };
    expect(parseWizardDraft(serializeWizardDraft(ar))).toEqual(ar);
  });

  it("garbage drafts parse to null", () => {
    const base = JSON.parse(serializeWizardDraft(full)) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>) => JSON.stringify({ ...base, ...patch });
    const cases: (string | null | undefined)[] = [
      null,
      undefined,
      "",
      "not json",
      "null",
      "[]",
      "42",
      bad({ v: 2 }),
      bad({ v: undefined }),
      bad({ title: 5 }),
      bad({ title: undefined }),
      bad({ title: "x".repeat(121) }),
      bad({ title: "a\ud800b" }),
      bad({ occasion: "birthday" }),
      bad({ occasion: undefined }),
      bad({ captionLang: "fr" }),
      bad({ format: "A4_PORTRAIT" }),
      bad({ format: "a5_portrait" }),
      bad({ designStyle: "vintage" }),
      bad({ designStyle: 1 }),
    ];
    for (const c of cases) expect(parseWizardDraft(c)).toBeNull();
    // the 120-code-point limit counts astral characters once
    expect(parseWizardDraft(bad({ title: "🌊".repeat(120) }))?.title).toBe("🌊".repeat(120));
  });
});

describe("WizardShell", () => {
  const html = renderToStaticMarkup(
    <WizardShell step={3} displayName="sara@example.com" wide>
      <WizardHeadline>{wizardHeadline(3)}</WizardHeadline>
    </WizardShell>,
  );

  it("shows the step label, headline and account menu", () => {
    expect(html).toContain("Step 3 of 6");
    expect(html).toContain("Choose a page shape");
    expect(tagOf(html, "wizard-headline")).toContain("type-display");
    expect(html).toContain('data-testid="account-menu-button"');
    expect(tagOf(html, "header-home")).toContain('href="/dashboard"');
    expect(tagOf(html, "wizard-content")).toContain("max-w-[40rem]");
  });

  it("renders a 6-segment progressbar with aria values", () => {
    const bar = tagOf(html, "wizard-progress");
    expect(bar).toContain('role="progressbar"');
    expect(bar).toContain('aria-valuenow="3"');
    expect(bar).toContain('aria-valuemin="1"');
    expect(bar).toContain('aria-valuemax="6"');
    expect(bar).toContain('aria-label="Book setup progress"');
    const segs = html.match(/<span[^>]*data-testid="wizard-progress-segment"[^>]*>/g) ?? [];
    expect(segs).toHaveLength(6);
    expect(segs.filter((s) => s.includes('data-filled=""'))).toHaveLength(3);
  });

  it("has the footer links", () => {
    expect(tagOf(html, "wizard-footer-home")).toContain('href="/"');
    expect(tagOf(html, "wizard-footer-help")).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    expect(tagOf(html, "wizard-footer-privacy")).toContain('href="/privacy"');
    expect(tagOf(html, "wizard-footer-terms")).toContain('href="/terms"');
  });

  it("uses the narrow column by default", () => {
    const narrow = renderToStaticMarkup(<WizardShell step={1}>x</WizardShell>);
    expect(tagOf(narrow, "wizard-content")).toContain("max-w-[28rem]");
    expect(narrow).toContain("Step 1 of 6");
  });

  it("progress fills every segment on the last step", () => {
    const last = renderToStaticMarkup(<WizardProgress step={6} />);
    expect((last.match(/data-filled=""/g) ?? []).length).toBe(6);
  });
});

describe("WizardNav", () => {
  it("renders Back (href) + Continue submit with default testids", () => {
    const h = renderToStaticMarkup(<WizardNav backHref="/books/new?step=3" />);
    expect(tagOf(h, "wizard-back")).toContain('href="/books/new?step=3"');
    const cont = tagOf(h, "wizard-continue");
    expect(cont).toContain('type="submit"');
    expect(cont).toContain("bg-accent-strong");
    expect(cont).toContain("rounded-full");
    expect(h).toContain("Continue");
  });

  it("omits Back without a target; pending disables and swaps the label", () => {
    const h = renderToStaticMarkup(
      <WizardNav pending pendingLabel="Creating…" continueTestId="create" continueType="button" />,
    );
    expect(h).not.toContain("wizard-back");
    const cont = tagOf(h, "create");
    expect(cont).toContain("disabled");
    expect(cont).toContain('aria-busy="true"');
    expect(cont).toContain('type="button"');
    expect(h).toContain("Creating…");
  });

  it("accepts a server-rendered back slot and an onClick back", () => {
    const slot = renderToStaticMarkup(<WizardNav back={<a href="/x" data-testid="my-back">Back</a>} />);
    expect(slot).toContain('data-testid="my-back"');
    const btn = renderToStaticMarkup(<WizardNav onBack={() => {}} backTestId="b" disabled />);
    expect(tagOf(btn, "b")).toContain('type="button"');
    expect(tagOf(btn, "wizard-continue")).toContain("disabled");
  });
});

describe("ChoiceCard", () => {
  it("renders a hidden radio inside a label with the checked state", () => {
    const h = renderToStaticMarkup(
      <ChoiceCard name="occasion" value="travel" label="Travel" checked onChange={() => {}} testId="occ-travel" />,
    );
    const label = tagOf(h, "occ-travel");
    expect(label.startsWith("<label")).toBe(true);
    expect(label).toContain("has-checked:border-primary");
    expect(label).toContain("has-focus-visible:ring-2");
    expect(label).toContain("min-h-11");
    const input = h.match(/<input[^>]*>/)?.[0] ?? "";
    for (const attr of ['type="radio"', 'name="occasion"', 'value="travel"', 'checked=""', 'class="sr-only"']) {
      expect(input).toContain(attr);
    }
    expect(h).toContain("group-has-checked/choice:flex");
    expect(h).toContain("Travel");
  });

  it("unchecked card has no checked attribute", () => {
    const h = renderToStaticMarkup(<ChoiceCard name="occasion" value="baby" label="Baby" defaultChecked={false} />);
    expect(h).not.toMatch(/<input[^>]*checked/);
  });
});

// @vitest-environment jsdom
// M20 T2 (D-072; was tests/m19-wizard-chrome.test.tsx, M19 T2 D-071): wizard step data + static
// renders of the wizard chrome — My-books band, 7-step stepper, body columns, nav, choice cards —
// plus the motion CSS (reduced-motion guards) and runViewTransition.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

const steps = await import("@/lib/books/wizard-steps");
const { WizardShell, WizardHeadline } = await import("@/components/wizard/WizardShell");
const { WizardBand, WIZARD_TITLE_PLACEHOLDER } = await import("@/components/wizard/WizardBand");
const { WizardBody } = await import("@/components/wizard/WizardBody");
const { WizardStepper, stepStateOf, stepperProgress } = await import("@/components/wizard/WizardStepper");
const { WizardNav, WIZARD_BACK_CLASS } = await import("@/components/wizard/WizardNav");
const { ChoiceCard } = await import("@/components/wizard/ChoiceCard");
const { runViewTransition, canUseViewTransition } = await import("@/lib/ui/view-transition");
const { SUPPORT_EMAIL } = await import("@/lib/brand");

const {
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  WIZARD_FORM_STEP_COUNT,
  WIZARD_STEP_NUMBERS,
  EMPTY_WIZARD_DRAFT,
  parseStep,
  isWizardStep,
  isWizardFormStep,
  firstMissingStep,
  parseWizardDraft,
  serializeWizardDraft,
  wizardHeadline,
  wizardStepLabel,
  wizardStepName,
  wizardStepIcon,
  wizardStepId,
} = steps;
type Draft = import("@/lib/books/wizard-steps").WizardDraft;
type Step = import("@/lib/books/wizard-steps").WizardStep;

const full: Draft = {
  title: "Days by the Sea",
  occasion: "travel",
  format: "A5_LANDSCAPE",
  designStyle: "modern",
};

const tagOf = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const ALL: Step[] = [1, 2, 3, 4, 5, 6, 7];

describe("wizard steps (7)", () => {
  it("lists the seven steps with names, icons and headlines", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["title", "occasion", "photos", "story", "design", "sorting", "review"]);
    // Task 5 order: Title, Occasion, Photos, Story, Design, Create (the AI build), Preview.
    expect(ALL.map(wizardStepName)).toEqual(["Title", "Occasion", "Photos", "Story", "Design", "Create", "Edit"]);
    expect(ALL.map(wizardStepIcon)).toEqual(["pen-line", "heart", "images", "feather", "palette", "sparkles", "book-open-check"]);
    // Short enough for the 375 px compact label ("Step N of 7 · Name") and the 7-up stepper.
    for (const n of ALL) expect(wizardStepName(n).length).toBeLessThanOrEqual(8);
    expect(wizardHeadline(1)).toBe("Give your book a title");
    expect(wizardHeadline(2)).toBe("What's this book for?");
    expect(wizardHeadline(3)).toBe("Add your photos");
    expect(wizardHeadline(4)).toBe("Every memory has a story.");
    expect(wizardHeadline(5)).toBe("Choose your book design");
    expect(wizardHeadline(6)).toBe("Sorting your photos");
    expect(wizardHeadline(7)).toBe("Preview and personalize");
    expect(wizardStepId(4)).toBe("story");
    expect(wizardStepId(5)).toBe("design");
    expect(wizardStepId(7)).toBe("review");
    expect(WIZARD_STEP_COUNT).toBe(7);
    expect(WIZARD_FORM_STEP_COUNT).toBe(2);
    expect(WIZARD_STEP_NUMBERS).toEqual(ALL);
    expect(wizardStepLabel(3)).toBe("Step 3 of 7");
    expect(wizardStepLabel(7)).toBe("Step 7 of 7");
  });

  it("parseStep accepts only 1–7", () => {
    expect(parseStep("1")).toBe(1);
    expect(parseStep("4")).toBe(4);
    expect(parseStep("5")).toBe(5);
    expect(parseStep("7")).toBe(7);
    expect(parseStep(["6", "2"])).toBe(6);
    expect(parseStep(2)).toBe(2);
    expect(parseStep(7)).toBe(7);
    for (const bad of [undefined, null, "", "0", "8", "9", " 2", "2.0", "02", "abc", [], {}, 2.5, 8, NaN]) {
      expect(parseStep(bad)).toBe(1);
    }
  });

  it("step guards", () => {
    expect(ALL.every((s) => isWizardStep(s))).toBe(true);
    for (const bad of [0, 8, 1.5, "1", null]) expect(isWizardStep(bad)).toBe(false);
    expect(ALL.filter(isWizardFormStep)).toEqual([1, 2]);
  });

  it("firstMissingStep walks the answers in order", () => {
    // M19 T3: an empty / blank title is allowed (we suggest one), so a fresh draft misses the occasion.
    expect(firstMissingStep(EMPTY_WIZARD_DRAFT)).toBe(2);
    expect(firstMissingStep({ ...full, title: "   " })).toBeNull();
    expect(firstMissingStep({ ...full, title: "a\ud800b" })).toBe(1);
    expect(firstMissingStep({ ...full, title: "x".repeat(121) })).toBe(1);
    expect(firstMissingStep({ ...full, title: "🌊".repeat(120) })).toBeNull();
    expect(firstMissingStep({ ...full, occasion: null })).toBe(2);
    // Task 5: shape and style are no form answers any more (chosen on step 5, after the photos).
    expect(firstMissingStep({ ...full, format: null, designStyle: null })).toBeNull();
    expect(firstMissingStep({ ...full, designStyle: null })).toBeNull();
    expect(firstMissingStep(full)).toBeNull();
    // occasion missing wins over later gaps
    expect(firstMissingStep({ ...full, occasion: null, format: null })).toBe(2);
  });

  it("draft round-trips through serialize/parse", () => {
    expect(parseWizardDraft(serializeWizardDraft(full))).toEqual(full);
    expect(parseWizardDraft(serializeWizardDraft(EMPTY_WIZARD_DRAFT))).toEqual(EMPTY_WIZARD_DRAFT);
    const ar = { ...full, title: "أيام البحر" };
    expect(parseWizardDraft(serializeWizardDraft(ar))).toEqual(ar);
    // No caption language in the draft any more (D-072) …
    expect(JSON.parse(serializeWizardDraft(full))).not.toHaveProperty("captionLang");
    // … but drafts stored before still parse (the extra field is ignored, whatever its value).
    const base = JSON.parse(serializeWizardDraft(full)) as Record<string, unknown>;
    for (const captionLang of ["ar", "en", null, "fr"]) {
      expect(parseWizardDraft(JSON.stringify({ ...base, captionLang }))).toEqual(full);
    }
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
      bad({ occasion: "picnic" }),
      bad({ occasion: undefined }),
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

describe("WizardStepper", () => {
  const render = (step: Step, extra: Partial<Parameters<typeof WizardStepper>[0]> = {}) =>
    renderToStaticMarkup(<WizardStepper step={step} {...extra} />);
  const items = (html: string) => html.match(/<li[^>]*data-testid="wizard-step-\d"[^>]*>/g) ?? [];
  const nodes = (html: string) => html.match(/<span[^>]*data-testid="wizard-step-node"[^>]*>/g) ?? [];

  it("states for every current step 1–7", () => {
    for (const cur of ALL) {
      const html = render(cur);
      const li = items(html);
      expect(li).toHaveLength(7);
      li.forEach((tag, i) => {
        const n = (i + 1) as Step;
        const want = n < cur ? "done" : n === cur ? "current" : "upcoming";
        expect(stepStateOf(n, cur)).toBe(want);
        expect(tag).toContain(`data-state="${want}"`);
        expect(nodes(html)[i]).toContain(`data-state="${want}"`);
      });
      expect(tagOf(html, "wizard-stepper")).toContain(`data-step="${cur}"`);
    }
  });

  it("exactly one aria-current=step, on the current item, inside a labelled nav list", () => {
    const html = render(4);
    expect(html.startsWith("<nav")).toBe(true);
    expect(tagOf(html, "wizard-stepper")).toContain('aria-label="Book setup steps"');
    expect(html).toContain("<ol");
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(tagOf(html, "wizard-step-4")).toContain('aria-current="step"');
    // Screen-reader state text for each item.
    expect(html).toContain("step 3, completed");
    expect(html).toContain("step 4, current step");
    expect(html).toContain("step 5, not started");
  });

  it("compact label: Step N of 7 · Name (name only below sm); names visible from sm", () => {
    const html = render(4);
    expect(html).toMatch(/data-testid="wizard-step-label">Step 4 of 7<\/span>/);
    expect(tagOf(html, "wizard-step-name")).toContain("sm:hidden");
    expect(html).toMatch(/data-testid="wizard-step-name"><span aria-hidden="true"> · <\/span>Story<\/span>/);
    for (const name of ["Title", "Occasion", "Photos", "Story", "Design", "Create", "Edit"]) expect(html).toContain(name);
    // The seven names appear in the new order.
    const order = ["Title", "Occasion", "Photos", "Story", "Design", "Create", "Edit"].map((n) => html.lastIndexOf(`>${n}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("sm:not-sr-only");
  });

  it("connector fill grows with the step (0 → 1)", () => {
    expect(stepperProgress(1)).toBe(0);
    expect(stepperProgress(7)).toBe(1);
    expect(stepperProgress(4)).toBeCloseTo(0.5);
    expect(tagOf(render(1), "wizard-stepper-fill")).toContain("scaleX(0)");
    expect(tagOf(render(7), "wizard-stepper-fill")).toContain("scaleX(1)");
    expect(tagOf(render(4), "wizard-stepper-fill")).toContain('data-progress="0.500"');
    expect(tagOf(render(4), "wizard-stepper-fill")).toContain("wz-connector-fill");
  });

  it("no buttons without onStepClick + canGoTo", () => {
    expect(render(5)).not.toContain("<button");
    expect(render(5, { onStepClick: () => {} })).not.toContain("<button");
    expect(render(5, { canGoTo: () => true })).not.toContain("<button");
  });

  it("canGoTo gates which done steps become 44 px buttons (never current / upcoming)", () => {
    const html = render(6, { onStepClick: () => {}, canGoTo: (s) => s >= 5 || s === 2 });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    // done = 1..5; allowed: 2 and 5 (6 is current, 7 upcoming even though canGoTo says yes)
    expect(buttons).toHaveLength(2);
    expect(tagOf(html, "wizard-step-2-button")).toContain('type="button"');
    expect(tagOf(html, "wizard-step-5-button")).toContain("min-h-11");
    expect(tagOf(html, "wizard-step-5-button")).toContain("min-w-11");
    expect(html).not.toContain("wizard-step-6-button");
    expect(html).not.toContain("wizard-step-7-button");
    expect(html).not.toContain("wizard-step-1-button");
  });

  it("only uses colours checked for AA on the leather's lightest point", () => {
    const L = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const lightest = "#1f5443";
    // text
    for (const c of ["#f2e8d8", "#e3c766", "#b9c2b6", "#d7cdb9"]) expect(ratio(c, lightest)).toBeGreaterThanOrEqual(4.5);
    // graphics (rings, dots, gold fill)
    for (const c of ["#9fb3a6", "#c9a227"]) expect(ratio(c, lightest)).toBeGreaterThanOrEqual(3);
    expect(ratio("#1b1b1d", "#bf9a23")).toBeGreaterThanOrEqual(4.5); // check on the darkest foil stop
    expect(ratio("#0e3b2e", "#f2e8d8")).toBeGreaterThanOrEqual(4.5); // current icon
    expect(ratio("#ffffff", "#1f6f54")).toBeGreaterThanOrEqual(4.5); // choice check badge
    const src = readFileSync(join(process.cwd(), "src/components/wizard/WizardStepper.tsx"), "utf8");
    const used = new Set(src.match(/text-\[#[0-9a-f]{6}\]/g)?.map((m) => m.slice(6, 13)));
    for (const c of used) expect(["#f2e8d8", "#e3c766", "#b9c2b6", "#d7cdb9", "#1b1b1d", "#0e3b2e", "#9fb3a6"]).toContain(c);
  });
});

describe("WizardBand", () => {
  it("emerald leather band: eyebrow, live title (dir=auto span) and the stepper", () => {
    const html = renderToStaticMarkup(<WizardBand step={2} title="رحلتنا إلى العين" />);
    expect(tagOf(html, "wizard-band")).toContain("home-leather");
    expect(html).toContain("New book");
    expect(html).toMatch(/data-testid="wizard-band-title"[^>]*><span dir="auto">رحلتنا إلى العين<\/span>/);
    expect(tagOf(html, "wizard-band-title")).toContain("truncate");
    expect(tagOf(html, "wizard-band-title")).not.toContain("data-placeholder");
    expect(html).toContain('data-testid="wizard-stepper"');
    expect(html).toContain("max-w-library");
  });

  it("blank title shows the placeholder", () => {
    for (const t of [undefined, null, "", "   "]) {
      const html = renderToStaticMarkup(<WizardBand step={1} title={t} />);
      expect(html).toContain(`<span dir="auto">${WIZARD_TITLE_PLACEHOLDER}</span>`);
      expect(tagOf(html, "wizard-band-title")).toContain('data-placeholder=""');
    }
    expect(WIZARD_TITLE_PLACEHOLDER).toBe("Your new book");
  });

  it("passes step clicks through to the stepper", () => {
    const html = renderToStaticMarkup(<WizardBand step={3} onStepClick={() => {}} canGoTo={() => true} />);
    expect(html).toContain("wizard-step-1-button");
    expect(html).toContain("wizard-step-2-button");
  });
});

describe("WizardBody", () => {
  it("single centred column without an aside (wide / narrow)", () => {
    expect(tagOf(renderToStaticMarkup(<WizardBody wide>x</WizardBody>), "wizard-content")).toContain("max-w-[52rem]");
    expect(tagOf(renderToStaticMarkup(<WizardBody>x</WizardBody>), "wizard-content")).toContain("max-w-[28rem]");
    expect(renderToStaticMarkup(<WizardBody>x</WizardBody>)).not.toContain("<aside");
    // wide="full" (step 7 Review): the whole library width.
    expect(tagOf(renderToStaticMarkup(<WizardBody wide="full">x</WizardBody>), "wizard-content")).not.toContain("max-w-");
  });

  it("two columns on ≥ lg with an aside; clipped horizontally", () => {
    const html = renderToStaticMarkup(<WizardBody aside={<p>preview</p>}>x</WizardBody>);
    // M20 T4: the columns fill the library width (preview column grows: 26 → 30 → 34rem).
    expect(html).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]");
    expect(html).toContain("xl:grid-cols-[minmax(0,1fr)_30rem]");
    expect(html).toContain("2xl:grid-cols-[minmax(0,1fr)_34rem]");
    expect(html).toContain("grid-cols-1");
    expect(tagOf(html, "wizard-aside")).toContain("<aside");
    expect(tagOf(html, "wizard-aside")).not.toContain("hidden lg:block");
    expect(html).toContain("<p>preview</p>");
    expect(tagOf(html, "wizard-body")).toContain("overflow-x-clip");
  });

  it("asideBelowLg=hide drops the aside below lg (the step draws its own mini version)", () => {
    const html = renderToStaticMarkup(<WizardBody aside={<p>preview</p>} asideBelowLg="hide">x</WizardBody>);
    expect(tagOf(html, "wizard-aside")).toContain("hidden lg:block");
  });
});

describe("WizardShell", () => {
  const html = renderToStaticMarkup(
    <WizardShell displayName="sara@example.com">
      <div data-testid="kid">
        <WizardHeadline>{wizardHeadline(3)}</WizardHeadline>
      </div>
    </WizardShell>,
  );

  it("header (account menu) + the children; no band, body or data-step of its own — the wizard owns them", () => {
    expect(tagOf(html, "wizard-shell")).not.toContain("data-step");
    expect(html).not.toContain("wizard-band");
    expect(html).not.toContain("wizard-stepper");
    expect(html).toContain('data-testid="kid"');
    expect(html).toContain("Add your photos");
    expect(tagOf(html, "wizard-headline")).toContain("type-display");
    expect(html).toContain('data-testid="account-menu-button"');
    expect(tagOf(html, "header-home")).toContain('href="/dashboard"');
  });

  it("has the footer links", () => {
    expect(tagOf(html, "wizard-footer-home")).toContain('href="/"');
    expect(tagOf(html, "wizard-footer-help")).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    expect(tagOf(html, "wizard-footer-privacy")).toContain('href="/privacy"');
    expect(tagOf(html, "wizard-footer-terms")).toContain('href="/terms"');
  });
});

describe("WizardNav", () => {
  it("renders Back (href) + Continue submit with default testids", () => {
    const h = renderToStaticMarkup(<WizardNav backHref="/books/new?step=3" />);
    expect(tagOf(h, "wizard-back")).toContain('href="/books/new?step=3"');
    expect(tagOf(h, "wizard-back")).toContain("border-success/45");
    expect(tagOf(h, "wizard-back")).toContain("text-primary");
    const cont = tagOf(h, "wizard-continue");
    expect(cont).toContain('type="submit"');
    expect(cont).toContain("bg-accent-strong");
    expect(cont).toContain("rounded-full");
    expect(h).toContain("Continue");
    expect(WIZARD_BACK_CLASS).toContain("min-h-12");
  });

  it("sticky bottom bar on phones with safe-area padding, inline from sm; opt out with sticky={false}", () => {
    const bar = tagOf(renderToStaticMarkup(<WizardNav />), "wizard-nav");
    expect(bar).toContain("sticky bottom-0");
    expect(bar).toContain("env(safe-area-inset-bottom)");
    expect(bar).toContain("sm:static");
    const inline = tagOf(renderToStaticMarkup(<WizardNav sticky={false} />), "wizard-nav");
    expect(inline).not.toContain("sticky");
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

describe("wizard-motion.css", () => {
  const css = readFileSync(join(process.cwd(), "src/components/wizard/wizard-motion.css"), "utf8");
  const motionBlock = (() => {
    const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(start).toBeGreaterThan(-1);
    // balanced braces from the block's first "{"
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
    }
    return "";
  })();
  const outside = css.replace(motionBlock, "");

  it("defines the keyframes the chrome uses", () => {
    for (const k of ["wz-pulse", "wz-connector-shimmer", "wz-card-bounce", "wz-pop", "wz-step-in-forward", "wz-step-in-back"]) {
      expect(css).toContain(`@keyframes ${k}`);
    }
  });

  it("every animation / transition / hover lift is inside the no-preference block", () => {
    const rules = outside.replace(/@keyframes[\s\S]*?\n}\n/g, "");
    expect(rules).not.toMatch(/\banimation(-name)?\s*:/);
    expect(rules).not.toMatch(/\btransition\s*:/);
    expect(rules).not.toMatch(/translateY/);
    expect(motionBlock).toMatch(/\.wz-choice:has\(input:checked\)\s*{\s*animation: wz-card-bounce/);
    expect(motionBlock).toContain("translateY(-3px)");
    expect(motionBlock).toContain("[data-step-anim=\"css\"][data-step-dir=\"back\"]");
    expect(motionBlock).toContain("::view-transition-new(wizard-step)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("is not in globals.css (owned by the wizard)", () => {
    const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(globals).not.toContain("wz-");
  });
});

describe("runViewTransition", () => {
  const doc = document as unknown as { startViewTransition?: unknown };
  const setReduced = (reduced: boolean) => {
    window.matchMedia = ((q: string) => ({ matches: reduced && q.includes("reduce"), media: q })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    delete doc.startViewTransition;
  });

  it("without the API: runs the update directly, once", () => {
    setReduced(false);
    const update = vi.fn();
    runViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(canUseViewTransition()).toBe(false);
  });

  it("with the API: runs the update inside startViewTransition (flushSync)", () => {
    setReduced(false);
    const start = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    doc.startViewTransition = start;
    const update = vi.fn();
    runViewTransition(update);
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("reduced motion bypasses the API", () => {
    setReduced(true);
    const start = vi.fn();
    doc.startViewTransition = start;
    const update = vi.fn();
    runViewTransition(update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("a throwing startViewTransition still runs the update once; rejected finished is swallowed", async () => {
    setReduced(false);
    doc.startViewTransition = () => {
      throw new Error("nope");
    };
    const update = vi.fn();
    runViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    doc.startViewTransition = (cb: () => void) => {
      cb();
      return { finished: Promise.reject(new Error("aborted")) };
    };
    runViewTransition(update);
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("ChoiceCard", () => {
  it("renders a hidden radio inside a label with the checked state", () => {
    const h = renderToStaticMarkup(
      <ChoiceCard name="occasion" value="travel" label="Travel" checked onChange={() => {}} testId="occ-travel" />,
    );
    const label = tagOf(h, "occ-travel");
    expect(label.startsWith("<label")).toBe(true);
    expect(label).toContain("has-checked:border-success");
    expect(label).toContain("has-checked:bg-success-soft");
    expect(label).toContain("wz-choice");
    expect(label).toContain("has-focus-visible:ring-2");
    expect(label).toContain("min-h-11");
    const input = h.match(/<input[^>]*>/)?.[0] ?? "";
    for (const attr of ['type="radio"', 'name="occasion"', 'value="travel"', 'checked=""', 'class="sr-only"']) {
      expect(input).toContain(attr);
    }
    expect(h).toContain("group-has-checked/choice:flex");
    expect(h).toMatch(/class="wz-choice-check[^"]*bg-success/);
    expect(h).toContain("Travel");
  });

  it("unchecked card has no checked attribute", () => {
    const h = renderToStaticMarkup(<ChoiceCard name="occasion" value="baby" label="Baby" defaultChecked={false} />);
    expect(h).not.toMatch(/<input[^>]*checked/);
  });
});

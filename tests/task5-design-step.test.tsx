// @vitest-environment jsdom
// Task 5: wizard step 5 "Choose your book design" (StepDesign) in a DOM, plus the pure rules behind it
// (src/lib/books/design-choice.ts): the recommendation's badges + plain reasons, preselection only
// while the user hasn't chosen, a manual choice that survives a new recommendation, "save only when
// changed", and a step that works without the recommendation.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Occasion } from "@/lib/book/options";
import {
  designPatch,
  designPickStorageKey,
  initialDesignPick,
  NO_DESIGN_PICK,
  parseDesignPick,
  recommendedChoice,
  resolveDesignChoice,
  serializeDesignPick,
  shapeReasonText,
  styleReasonText,
  type DesignPick,
  type StoredDesign,
} from "@/lib/books/design-choice";
import { DEFAULT_FORM_FORMAT, defaultStyleFor, FORM_DESIGN_STYLES } from "@/lib/design/defaults";
import { recommendDesign, type DesignRecommendation } from "@/lib/design/recommend";
import type { RecommendDesignResult } from "@/lib/story/answers";

const actions = vi.hoisted(() => ({ recommend: vi.fn() }));
vi.mock("@/app/books/story-actions", () => ({
  loadStoryAnswersAction: vi.fn(),
  saveStoryAnswersAction: vi.fn(),
  recommendDesignAction: actions.recommend,
}));

const { StepDesign } = await import("@/components/books/wizard/steps/StepDesign");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = "22222222-2222-4222-8222-222222222222";
const wide = (n: number) => Array.from({ length: n }, () => ({ width: 1600, height: 1000 }));
const tall = (n: number) => Array.from({ length: n }, () => ({ width: 1000, height: 1600 }));
const rec = (occasion: Occasion | null, photos: { width: number | null; height: number | null }[]) => recommendDesign({ occasion, photos });
const answer = (r: DesignRecommendation): RecommendDesignResult => ({ ok: true, recommendation: r });

let container: HTMLDivElement;
let root: Root;
let onContinue: ReturnType<typeof vi.fn<() => void>>;
let onBack: ReturnType<typeof vi.fn<() => void>>;
/** What the wizard would hold. */
let held: { pick: DesignPick; recommendation: DesignRecommendation | null };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onContinue = vi.fn<() => void>();
  onBack = vi.fn<() => void>();
  held = { pick: NO_DESIGN_PICK, recommendation: null };
  actions.recommend.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

type HarnessProps = {
  occasion?: Occasion | null;
  stored?: StoredDesign;
  pick?: DesignPick;
  recommendation?: DesignRecommendation | null;
  locked?: boolean;
  error?: string | null;
  buildError?: string | null;
  pending?: boolean;
};

/** StepDesign with the wizard's state around it (pick + recommendation live in the parent). */
function Harness(p: HarnessProps) {
  const occasion = p.occasion === undefined ? "travel" : p.occasion;
  const [pick, setPick] = useState<DesignPick>(p.pick ?? NO_DESIGN_PICK);
  const [recommendation, setRecommendation] = useState<DesignRecommendation | null>(p.recommendation ?? null);
  held = { pick, recommendation };
  return (
    <StepDesign
      bookId={BOOK}
      headlineId="wizard-headline"
      title="Sea days"
      occasion={occasion}
      stored={p.stored ?? { format: DEFAULT_FORM_FORMAT as "A5_PORTRAIT", designStyle: defaultStyleFor(occasion) }}
      pick={pick}
      onPick={setPick}
      recommendation={recommendation}
      onRecommendation={setRecommendation}
      locked={p.locked}
      error={p.error}
      buildError={p.buildError}
      pending={p.pending}
      onBack={onBack}
      onContinue={onContinue}
    />
  );
}

async function mount(props: HarnessProps = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
    await tick(10);
  });
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`) as T;
const radio = (id: string) => $(id).querySelector("input") as HTMLInputElement;
const badgeOn = (id: string) => $(id).querySelector('[data-testid="choice-badge"]')?.textContent ?? null;
const checkedFormat = () => ["A5_PORTRAIT", "A5_LANDSCAPE"].filter((f) => radio(`format-${f}`).checked);
const checkedStyle = () => FORM_DESIGN_STYLES.filter((s) => radio(`style-${s}`).checked);
const badges = () => [...container.querySelectorAll('[data-testid="choice-badge"]')].map((b) => b.closest("label")!.getAttribute("data-testid"));

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await tick(10);
  });
}

describe("StepDesign — one screen for shape + style", () => {
  it("headline, two named radio groups (the M19/M20 cards), Back + a Continue that says what happens next", async () => {
    actions.recommend.mockResolvedValue({ ok: false, error: "unavailable" });
    await mount();
    expect($("wizard-headline").textContent).toBe("Choose your book design");
    expect($("wizard-headline").tagName).toBe("H1");
    const groups = [...container.querySelectorAll("fieldset")];
    expect(groups.map((g) => g.querySelector("legend")!.textContent)).toEqual(["Page shape", "Book style"]);
    expect(groups[0].querySelectorAll('input[type="radio"][name="wizard-format"]')).toHaveLength(2);
    expect(groups[1].querySelectorAll('input[type="radio"][name="wizard-designStyle"]')).toHaveLength(6);
    for (const label of container.querySelectorAll("fieldset label")) expect(label.className).toContain("min-h-11");
    // shape first, then style, then the actions
    const nav = [...$("wizard-nav").querySelectorAll("button")];
    expect(nav.map((b) => b.textContent)).toEqual(["Back", "Create my book"]);
    expect(nav[1].getAttribute("type")).toBe("submit");
    await click($("wizard-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
    await click($("wizard-design-continue"));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("asks for the recommendation on entry (once, for this book)", async () => {
    actions.recommend.mockResolvedValue(answer(rec("travel", wide(8))));
    await mount();
    expect(actions.recommend).toHaveBeenCalledTimes(1);
    expect(actions.recommend).toHaveBeenCalledWith(BOOK);
  });
});

describe("StepDesign — badges and reasons per recommendation", () => {
  it("mostly wide photos: Landscape is recommended, preselected, and says why in plain words", async () => {
    actions.recommend.mockResolvedValue(answer(rec("travel", [...wide(8), ...tall(2)])));
    await mount();
    expect(badges()).toEqual(["format-A5_LANDSCAPE", "style-magazine"]);
    expect(badgeOn("format-A5_LANDSCAPE")).toBe("Recommended");
    expect($("format-reason").textContent).toBe("Most of your photos are wide.");
    expect($("style-reason").textContent).toBe("A good fit for a travel book.");
    expect(checkedFormat()).toEqual(["A5_LANDSCAPE"]);
    expect(checkedStyle()).toEqual(["magazine"]);
    // The badge is text inside the option's label (read with its name) — not colour alone.
    expect($("format-A5_LANDSCAPE").textContent).toContain("Recommended");
    expect($("format-A5_PORTRAIT").textContent).not.toContain("Recommended");
    // The reason is tied to its group.
    expect($("design-shape").getAttribute("aria-describedby")).toBe($("format-reason").id);
    expect($("design-style").getAttribute("aria-describedby")).toBe($("style-reason").id);
    expect($("design-intro").textContent).toMatch(/choose what you like/i);
    // The style cards are drawn in the selected shape.
    expect($("style-modern").innerHTML).toContain('data-format="A5_LANDSCAPE"');
  });

  it("mostly tall photos: Portrait, 'Most of your photos are tall.'", async () => {
    actions.recommend.mockResolvedValue(answer(rec("baby", tall(9))));
    await mount({ occasion: "baby" });
    expect(badgeOn("format-A5_PORTRAIT")).toBe("Recommended");
    expect($("format-reason").textContent).toBe("Most of your photos are tall.");
    expect($("style-reason").textContent).toBe("A good fit for a baby book.");
    expect(checkedFormat()).toEqual(["A5_PORTRAIT"]);
    expect(badges()).toEqual(["format-A5_PORTRAIT", `style-${defaultStyleFor("baby")}`]);
  });

  it.each([
    ["mixed", [...wide(5), ...tall(5)]],
    ["no_photos", []],
  ] as const)("%s: the badge sits on the default shape with no claim about the photos", async (reason, photos) => {
    const r = rec("wedding", [...photos]);
    expect(r.formatReason).toBe(reason);
    actions.recommend.mockResolvedValue(answer(r));
    await mount({ occasion: "wedding" });
    expect(badgeOn(`format-${DEFAULT_FORM_FORMAT}`)).toBe("Recommended");
    expect($("format-reason").textContent).toBe("A good all-round shape.");
    expect($("format-reason").textContent).not.toMatch(/photo/i);
    expect($("style-reason").textContent).toBe("A good fit for a wedding book.");
  });

  it("birthday and 'other' / no occasion get a sensible style line", async () => {
    actions.recommend.mockResolvedValue(answer(rec("birthday", wide(6))));
    await mount({ occasion: "birthday" });
    expect($("style-reason").textContent).toBe("A good fit for a birthday book.");
    expect(styleReasonText(rec("other", []), "other")).toBe("A good fit for your book.");
    expect(styleReasonText(rec(null, []), null)).toBe("A good fit for your book.");
    expect(styleReasonText(null, "travel")).toBeNull();
    expect(shapeReasonText(null)).toBeNull();
  });
});

describe("StepDesign — the user decides", () => {
  it("before the recommendation arrives the stored (provisional) design shows; nothing is badged", async () => {
    actions.recommend.mockImplementation(() => new Promise(() => {}));
    await mount({ occasion: "family" });
    expect(checkedFormat()).toEqual(["A5_PORTRAIT"]);
    expect(checkedStyle()).toEqual([defaultStyleFor("family")]);
    expect(badges()).toEqual([]);
    expect($("format-reason")).toBeNull();
  });

  it("a manual choice made before the recommendation arrives is never overwritten by it", async () => {
    let release: (r: RecommendDesignResult) => void = () => {};
    actions.recommend.mockImplementation(() => new Promise<RecommendDesignResult>((r) => (release = r)));
    await mount();
    await click(radio("format-A5_PORTRAIT")); // already selected visually, but now it is the user's own pick
    await click(radio("style-classic"));
    expect(held.pick).toEqual({ format: "A5_PORTRAIT", designStyle: "classic" });
    await act(async () => {
      release(answer(rec("travel", wide(10))));
      await tick(10);
    });
    // The badges show what we'd suggest…
    expect(badges()).toEqual(["format-A5_LANDSCAPE", "style-magazine"]);
    // …but the user's choice stays.
    expect(checkedFormat()).toEqual(["A5_PORTRAIT"]);
    expect(checkedStyle()).toEqual(["classic"]);
  });

  it("the user can always override the recommendation, per field; the other field keeps following it", async () => {
    actions.recommend.mockResolvedValue(answer(rec("travel", wide(10))));
    await mount();
    expect(checkedFormat()).toEqual(["A5_LANDSCAPE"]);
    await click(radio("format-A5_PORTRAIT"));
    expect(checkedFormat()).toEqual(["A5_PORTRAIT"]);
    expect(held.pick).toEqual({ format: "A5_PORTRAIT", designStyle: null });
    expect(checkedStyle()).toEqual(["magazine"]); // still the recommended one
    expect(badgeOn("format-A5_LANDSCAPE")).toBe("Recommended"); // the badge stays where it was
    await click(radio("style-editorial"));
    expect(checkedStyle()).toEqual(["editorial"]);
    expect(held.pick).toEqual({ format: "A5_PORTRAIT", designStyle: "editorial" });
  });

  it("re-entering the step: the pick the wizard holds wins over a NEW recommendation", async () => {
    actions.recommend.mockResolvedValue(answer(rec("travel", tall(10))));
    await mount({ pick: { format: "A5_LANDSCAPE", designStyle: null }, recommendation: rec("travel", wide(10)) });
    // shown at once from the held recommendation, then refreshed
    expect(actions.recommend).toHaveBeenCalledTimes(1);
    expect(held.recommendation?.formatReason).toBe("mostly_portrait");
    expect(badgeOn("format-A5_PORTRAIT")).toBe("Recommended");
    expect($("format-reason").textContent).toBe("Most of your photos are tall.");
    expect(checkedFormat()).toEqual(["A5_LANDSCAPE"]); // the user's own
    expect(checkedStyle()).toEqual(["magazine"]); // not picked → the recommendation
  });

  it("works when the recommendation fails or throws: no badges, the stored design, everything selectable", async () => {
    for (const impl of [
      async () => ({ ok: false as const, error: "unavailable" as const }),
      async () => {
        throw new Error("offline");
      },
    ]) {
      actions.recommend.mockReset().mockImplementation(impl);
      await mount({ occasion: "graduation" });
      expect(badges()).toEqual([]);
      expect($("format-reason")).toBeNull();
      expect($("style-reason")).toBeNull();
      expect($("design-intro").textContent).toBe("Choose the shape and style you like best.");
      expect(checkedFormat()).toEqual(["A5_PORTRAIT"]);
      expect(checkedStyle()).toEqual([defaultStyleFor("graduation")]);
      await click(radio("format-A5_LANDSCAPE"));
      await click(radio("style-scrapbook"));
      expect(checkedFormat()).toEqual(["A5_LANDSCAPE"]);
      expect(checkedStyle()).toEqual(["scrapbook"]);
      await click($("wizard-design-continue"));
      expect(onContinue).toHaveBeenCalled();
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("a failed refresh keeps the earlier recommendation", async () => {
    actions.recommend.mockResolvedValue({ ok: false, error: "unavailable" });
    await mount({ recommendation: rec("travel", wide(10)) });
    expect(badgeOn("format-A5_LANDSCAPE")).toBe("Recommended");
    expect(checkedFormat()).toEqual(["A5_LANDSCAPE"]);
  });

  it("errors show inline (alert); pending: Continue waits and says so; locked: read-only with the note, no recommendation", async () => {
    actions.recommend.mockResolvedValue(answer(rec("travel", wide(10))));
    await mount({ error: "We couldn't save your changes. Please try again.", buildError: "No AI redos left for this book." });
    expect($("design-error").getAttribute("role")).toBe("alert");
    expect($("design-error").textContent).toContain("couldn't save");
    expect($("design-build-error").textContent).toContain("No AI redos left");
    act(() => root.unmount());
    root = createRoot(container);
    await mount({ pending: true });
    expect($<HTMLButtonElement>("wizard-design-continue").disabled).toBe(true);
    expect($("wizard-design-continue").getAttribute("aria-busy")).toBe("true");
    expect($("wizard-design-continue").textContent).toContain("Starting your book…");
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
    });
    expect(onContinue).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(container);
    actions.recommend.mockClear();
    await mount({ locked: true, stored: { format: "A5_LANDSCAPE", designStyle: "classic" }, recommendation: rec("travel", tall(10)) });
    expect($("wizard-design-locked")).toBeTruthy();
    expect($("format-A5_PORTRAIT")).toBeNull();
    expect(radio("format-A5_LANDSCAPE").checked).toBe(true);
    expect(radio("style-classic").checked).toBe(true);
    expect($("style-modern")).toBeNull();
    expect(badges()).toEqual([]);
    expect(actions.recommend).not.toHaveBeenCalled();
  });
});

describe("design-choice (pure rules)", () => {
  const provisional: StoredDesign = { format: "A5_PORTRAIT", designStyle: "magazine" }; // a new travel book
  const wideRec = rec("travel", wide(10));

  it("resolveDesignChoice: pick > recommendation > stored > defaults, per field", () => {
    expect(resolveDesignChoice({ stored: provisional, pick: NO_DESIGN_PICK, recommendation: null, occasion: "travel" })).toEqual({
      format: "A5_PORTRAIT",
      designStyle: "magazine",
    });
    expect(resolveDesignChoice({ stored: provisional, pick: NO_DESIGN_PICK, recommendation: wideRec, occasion: "travel" })).toEqual({
      format: "A5_LANDSCAPE",
      designStyle: "magazine",
    });
    expect(
      resolveDesignChoice({ stored: provisional, pick: { format: "A5_PORTRAIT", designStyle: "classic" }, recommendation: wideRec, occasion: "travel" }),
    ).toEqual({ format: "A5_PORTRAIT", designStyle: "classic" });
    expect(
      resolveDesignChoice({ stored: provisional, pick: { format: null, designStyle: "classic" }, recommendation: wideRec, occasion: "travel" }),
    ).toEqual({ format: "A5_LANDSCAPE", designStyle: "classic" });
    // nothing known at all
    expect(resolveDesignChoice({ stored: { format: null, designStyle: null }, pick: NO_DESIGN_PICK, recommendation: undefined, occasion: null })).toEqual({
      format: DEFAULT_FORM_FORMAT,
      designStyle: defaultStyleFor(null),
    });
  });

  it("designPatch: null when nothing differs from the stored book (no save), else shape + style", () => {
    expect(designPatch({ format: "A5_PORTRAIT", designStyle: "magazine" }, provisional)).toBeNull();
    expect(designPatch({ format: "A5_LANDSCAPE", designStyle: "magazine" }, provisional)).toEqual({ format: "A5_LANDSCAPE", designStyle: "magazine" });
    expect(designPatch({ format: "A5_PORTRAIT", designStyle: "classic" }, provisional)).toEqual({ format: "A5_PORTRAIT", designStyle: "classic" });
    // Accepting a recommendation that equals the provisional design saves nothing.
    const chosen = resolveDesignChoice({ stored: provisional, pick: NO_DESIGN_PICK, recommendation: rec("travel", tall(4)), occasion: "travel" });
    expect(designPatch(chosen, provisional)).toBeNull();
  });

  it("initialDesignPick: a provisional design is 'not chosen'; a different stored value or a remembered pick is the user's", () => {
    expect(initialDesignPick({ stored: provisional, occasion: "travel" })).toEqual(NO_DESIGN_PICK);
    expect(initialDesignPick({ stored: { format: "A5_LANDSCAPE", designStyle: "magazine" }, occasion: "travel" })).toEqual({
      format: "A5_LANDSCAPE",
      designStyle: null,
    });
    expect(initialDesignPick({ stored: { format: "A5_PORTRAIT", designStyle: "classic" }, occasion: "travel" })).toEqual({
      format: null,
      designStyle: "classic",
    });
    expect(
      initialDesignPick({ stored: provisional, occasion: "travel", remembered: { format: "A5_PORTRAIT", designStyle: null } }),
    ).toEqual({ format: "A5_PORTRAIT", designStyle: null });
    expect(initialDesignPick({ stored: { format: null, designStyle: null }, occasion: null })).toEqual(NO_DESIGN_PICK);
  });

  it("recommendedChoice only offers what the form offers", () => {
    expect(recommendedChoice(null)).toEqual(NO_DESIGN_PICK);
    expect(recommendedChoice(wideRec)).toEqual({ format: "A5_LANDSCAPE", designStyle: "magazine" });
    expect(recommendedChoice({ ...wideRec, format: "A4" as never, designStyle: "neon" as never })).toEqual(NO_DESIGN_PICK);
  });

  it("the remembered pick round-trips and rejects junk", () => {
    expect(designPickStorageKey(BOOK)).toContain(BOOK);
    const pick: DesignPick = { format: "A5_LANDSCAPE", designStyle: null };
    expect(parseDesignPick(serializeDesignPick(pick))).toEqual(pick);
    for (const bad of [null, "", "{not json", "[]", JSON.stringify({ v: 2, format: null, designStyle: null }), JSON.stringify({ v: 1, format: "A4", designStyle: null }), JSON.stringify({ v: 1, format: null })]) {
      expect(parseDesignPick(bad)).toBeNull();
    }
  });
});

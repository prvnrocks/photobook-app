// @vitest-environment jsdom
// Task 5 / v3: wizard step 4 "What makes this memory special?" (StepStory) in a DOM — the three
// questions (occasion prefilled from step 2, who with chips, one memory), exact title + tone labels,
// tap-to-fill chips, nothing else prefilled, the
// optional tone (radio semantics, can be cleared), the 200-code-point limit, Continue / Skip payloads,
// restore on re-entry, a failed save that never traps the user, and accessible names / roles.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCCASIONS, type Occasion } from "@/lib/book/options";
import type { StoryAnswersInput, StoryAnswersResult, StoryAnswersView } from "@/lib/story/answers";
import { STORY_ANSWER_MAX, STORY_TONE_LABELS, STORY_TONES, occasionPrefill, storyQuestionsFor } from "@/lib/story/questions";

const actions = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), recommend: vi.fn() }));
vi.mock("@/app/books/story-actions", () => ({
  loadStoryAnswersAction: actions.load,
  saveStoryAnswersAction: actions.save,
  recommendDesignAction: actions.recommend,
}));

const {
  StepStory,
  clampStoryAnswer,
  storyDraftFromView,
  storyInputFromDraft,
  EMPTY_STORY_DRAFT,
  STORY_COUNTER_FROM,
  STORY_SAVE_FAILED,
  STORY_SUPPORT_LINE,
} = await import("@/components/books/wizard/steps/StepStory");
type StoryDraft = import("@/components/books/wizard/steps/StepStory").StoryDraft;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = "22222222-2222-4222-8222-222222222222";
const EMPTY_VIEW: StoryAnswersView = { storyTone: null, answers: [], skipped: false, rev: 0 };
const ok = (context: StoryAnswersView = EMPTY_VIEW): StoryAnswersResult => ({ ok: true, context });

let container: HTMLDivElement;
let root: Root;
/** The wizard's client copy (what NewBookWizard keeps in state). */
let value: StoryDraft | null;
let onContinue: ReturnType<typeof vi.fn<() => void>>;
let onBack: ReturnType<typeof vi.fn<() => void>>;
let occasion: Occasion | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  value = null;
  occasion = "travel";
  onContinue = vi.fn<() => void>();
  onBack = vi.fn<() => void>();
  actions.load.mockReset().mockResolvedValue(ok());
  actions.save.mockReset().mockResolvedValue(ok());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function draw() {
  root.render(
    <StepStory
      bookId={BOOK}
      occasion={occasion}
      headlineId="wizard-headline"
      value={value}
      onChange={(v) => {
        value = v;
        draw();
      }}
      onBack={onBack}
      onContinue={onContinue}
    />,
  );
}

async function mount() {
  await act(async () => {
    draw();
    await tick(10);
  });
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`) as T;
const $$ = <T extends HTMLElement = HTMLElement>(id: string) => [...container.querySelectorAll<T>(`[data-testid="${id}"]`)];
const field = (id: string) => $<HTMLTextAreaElement>(`story-answer-${id}`);
const toneRadio = (id: string) => $(`story-tone-${id}`).querySelector("input") as HTMLInputElement;

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await tick(10);
  });
}

async function type(el: HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const lastSave = () => actions.save.mock.calls.at(-1) as [string, StoryAnswersInput];

describe("StepStory — what is asked", () => {
  it("title is exactly 'What makes this memory special?' with one supporting line; everything is optional", async () => {
    await mount();
    const h = $("wizard-headline");
    expect(h.tagName).toBe("H1");
    expect(h.textContent).toBe("What makes this memory special?");
    expect(h.id).toBe("wizard-headline");
    expect(h.getAttribute("tabindex")).toBe("-1"); // focus target after a step change
    expect($$("story-support")).toHaveLength(1);
    expect($("story-support").textContent).toBe(STORY_SUPPORT_LINE);
    expect(container.querySelectorAll("[required], [aria-required='true']")).toHaveLength(0);
    // Continue is never disabled by an empty form.
    expect($<HTMLButtonElement>("story-continue").disabled).toBe(false);
  });

  it.each([...OCCASIONS, null] as const)("occasion %s: occasion (prefilled from step 2), relationship (chips) and one short memory — labelled, optional, dir=auto", async (occ) => {
    occasion = occ;
    await mount();
    const questions = storyQuestionsFor(occ);
    expect(questions.map((q) => q.kind)).toEqual(["occasion", "relationship", "moment"]);
    const fields = [...container.querySelectorAll("textarea")];
    expect(fields).toHaveLength(3);
    for (const q of questions) {
      const f = field(q.id);
      // a visible <label> names the field, a hint describes it
      const label = container.querySelector(`label[for="${f.id}"]`)!;
      expect(label.textContent).toContain(q.prompt);
      expect(label.textContent).toContain("optional");
      expect(f.getAttribute("aria-describedby")).toContain(`${f.id}-hint`);
      // only the occasion starts with text: the occasion the user picked in step 2
      expect(f.value).toBe(q.kind === "occasion" ? occasionPrefill(occ) : "");
      expect(f.placeholder).toBe(q.placeholder);
      expect(f.getAttribute("dir")).toBe("auto");
      expect(f.rows).toBe(q.kind === "moment" ? 3 : 2); // short: never a long text box
      expect(f.required).toBe(false);
      const chips = $(`story-question-${q.id}`).querySelectorAll<HTMLButtonElement>('[data-testid="story-chip"]');
      expect([...chips].map((c) => c.textContent)).toEqual(q.suggestions);
      for (const c of chips) {
        expect(c.type).toBe("button");
        expect(c.className).toContain("min-h-11"); // >= 44 px
        expect(c.getAttribute("aria-pressed")).toBe("false");
        expect(c.getAttribute("dir")).toBe("auto");
      }
    }
    expect($$("story-chip").length).toBe(questions[1]!.suggestions.length);
  });

  it("the occasion is sent only when the user changed it; the step-2 occasion alone adds nothing", async () => {
    await mount();
    expect(field("memory.occasion").value).toBe("Travel");
    await click($("story-continue"));
    expect(lastSave()[1]).toEqual({ storyTone: null, answers: [], skipped: false });
    await type(field("memory.occasion"), "Seeing my brother again");
    await click($("story-continue"));
    expect(lastSave()[1].answers).toEqual([{ questionId: "memory.occasion", text: "Seeing my brother again" }]);
    expect(storyInputFromDraft({ ...EMPTY_STORY_DRAFT, answers: { "memory.occasion": " travel " } }, storyQuestionsFor("travel"), false, "Travel").answers).toEqual([]);
  });

  it("the three tone choices, exactly: an optional native radio group", async () => {
    await mount();
    const group = $("story-tone");
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")!.textContent).toContain("How should it sound?");
    expect(group.querySelector("legend")!.textContent).toContain("optional");
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(3);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1); // one group: arrow keys move within it
    expect(radios.map((r) => r.closest("label")!.textContent)).toEqual(["Heartfelt & personal", "Joyful & playful", "Elegant & timeless"]);
    expect(STORY_TONES.map((t) => STORY_TONE_LABELS[t])).toEqual(["Heartfelt & personal", "Joyful & playful", "Elegant & timeless"]);
    expect(radios.some((r) => r.checked)).toBe(false); // nothing preselected
    for (const r of radios) expect(r.closest("label")!.className).toContain("min-h-12");
    // The hint that it can be cleared is tied to the group.
    const hint = document.getElementById(group.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toMatch(/again to clear/i);
  });

  it("Back, Skip for now and Continue: three real buttons, ≥ 44 px, in that focus order", async () => {
    await mount();
    const nav = $("wizard-nav");
    const buttons = [...nav.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Back", "Skip for now", "Continue"]);
    expect(buttons.map((b) => b.type)).toEqual(["button", "button", "submit"]);
    for (const b of buttons) expect(b.className).toMatch(/min-h-1[12]/);
    expect($("story-skip").className).toContain("underline"); // not colour alone
    // DOM (= tab) order: questions, their chips, tone, then the actions.
    const order = [...container.querySelectorAll<HTMLElement>("textarea, button, input")].map(
      (el) => el.getAttribute("data-testid") ?? el.closest("[data-testid]")!.getAttribute("data-testid")!,
    );
    const firstTone = order.findIndex((id) => id.startsWith("story-tone-"));
    const lastField = order.map((id) => id.startsWith("story-answer-")).lastIndexOf(true);
    expect(lastField).toBeLessThan(firstTone);
    expect(order.slice(-3)).toEqual(["wizard-back", "story-skip", "story-continue"]);
    await click($("wizard-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("StepStory — answering", () => {
  // q1 = who is in the photos (with chips), q2 = one short memory (the occasion field is tested above)
  const [, q1, q2] = storyQuestionsFor("travel");

  it("a chip fills its own field only when tapped (pressed state + check mark); typing clears the pressed state", async () => {
    await mount();
    expect(field(q1.id).value).toBe("");
    const chip = () => $(`story-question-${q1.id}`).querySelectorAll<HTMLButtonElement>('[data-testid="story-chip"]')[1];
    await click(chip());
    expect(field(q1.id).value).toBe(q1.suggestions[1]);
    expect(field(q2.id).value).toBe(""); // the other question is untouched
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().querySelector("svg")).toBeTruthy(); // a mark, not colour alone
    expect($$("story-chip").filter((c) => c.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    await type(field(q1.id), "My two cousins");
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(field(q1.id).value).toBe("My two cousins");
    // a chip is not a submit
    expect(actions.save).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("Continue saves the user's words (trimmed, blanks left out) with skipped: false, then goes on", async () => {
    await mount();
    await type(field(q1.id), "  My sister  ");
    await type(field(q2.id), "   ");
    await click(toneRadio("joyful"));
    await click($("story-continue"));
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(lastSave()).toEqual([BOOK, { storyTone: "joyful", answers: [{ questionId: q1.id, text: "My sister" }], skipped: false }]);
    // strict contract: only questionId + text on an answer
    expect(Object.keys(lastSave()[1].answers[0]).sort()).toEqual(["questionId", "text"]);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("nothing answered: Continue sends no answers and no tone — never an invented or suggested one", async () => {
    await mount();
    await click($("story-continue"));
    expect(lastSave()[1]).toEqual({ storyTone: null, answers: [], skipped: false });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("Skip for now sends skipped: true and no answers — even when something was typed", async () => {
    await mount();
    await type(field(q1.id), "My sister");
    await click($("story-skip"));
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(lastSave()).toEqual([BOOK, { storyTone: null, answers: [], skipped: true }]);
    expect(onContinue).toHaveBeenCalledTimes(1);
    // What was typed stays in the session copy (coming back shows it again).
    expect(value?.answers[q1.id]).toBe("My sister");
  });

  it("the tone can be chosen, changed and cleared again (tap the chosen one); the state is a check mark, not colour alone", async () => {
    await mount();
    await click(toneRadio("heartfelt"));
    expect(toneRadio("heartfelt").checked).toBe(true);
    expect($("story-tone-heartfelt").querySelector("svg")).toBeTruthy();
    await click(toneRadio("elegant"));
    expect(STORY_TONES.filter((t) => toneRadio(t).checked)).toEqual(["elegant"]);
    await click(toneRadio("elegant"));
    expect(STORY_TONES.filter((t) => toneRadio(t).checked)).toEqual([]);
    await click($("story-continue"));
    expect(lastSave()[1].storyTone).toBeNull();
  });

  it("keyboard: Space on the chosen tone clears it (Chromium fires no click there)", async () => {
    await mount();
    await click(toneRadio("heartfelt"));
    expect(toneRadio("heartfelt").checked).toBe(true);
    await act(async () => {
      toneRadio("heartfelt").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(STORY_TONES.filter((t) => toneRadio(t).checked)).toEqual([]);
    // Space on an unchosen tone is left to the browser (no clear, no change from the handler)
    await act(async () => {
      toneRadio("elegant").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(STORY_TONES.filter((t) => toneRadio(t).checked)).toEqual([]);
  });

  it("Enter in a field continues (keyboard); a field never grows a line break", async () => {
    await mount();
    await type(field(q1.id), "My\nsister");
    expect(field(q1.id).value).toBe("My sister");
    await act(async () => {
      field(q1.id).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await tick(10);
    });
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it(`answers stop at ${STORY_ANSWER_MAX} code points (emoji / Arabic counted as characters); the counter shows only near the limit`, async () => {
    await mount();
    await type(field(q1.id), "a".repeat(STORY_COUNTER_FROM - 1));
    expect($(`story-count-${q1.id}`)).toBeNull();
    await type(field(q1.id), "a".repeat(STORY_COUNTER_FROM));
    expect($(`story-count-${q1.id}`).textContent).toContain(`${STORY_COUNTER_FROM}/${STORY_ANSWER_MAX}`);
    expect(field(q1.id).getAttribute("aria-describedby")).toContain($(`story-count-${q1.id}`).id);
    await type(field(q1.id), "🌊".repeat(STORY_ANSWER_MAX + 25));
    expect(Array.from(field(q1.id).value)).toHaveLength(STORY_ANSWER_MAX);
    expect(field(q1.id).value.length).toBe(STORY_ANSWER_MAX * 2); // UTF-16 units: whole emoji kept, none cut in half
    expect($(`story-count-${q1.id}`).textContent).toContain(`${STORY_ANSWER_MAX}/${STORY_ANSWER_MAX}`);
    await type(field(q2.id), "م".repeat(STORY_ANSWER_MAX + 1));
    expect(Array.from(field(q2.id).value)).toHaveLength(STORY_ANSWER_MAX);
    await click($("story-continue"));
    for (const a of lastSave()[1].answers) expect(Array.from(a.text).length).toBeLessThanOrEqual(STORY_ANSWER_MAX);
  });
});

describe("StepStory — load, restore and failures", () => {
  const [, q1, q2] = storyQuestionsFor("travel");
  const storedView: StoryAnswersView = {
    storyTone: "elegant",
    answers: [{ questionId: q2.id, text: "The night market" }],
    skipped: false,
    rev: 3,
  };

  it("on entry the stored answers and tone are shown (a reload / a later visit)", async () => {
    actions.load.mockResolvedValue(ok(storedView));
    await mount();
    expect(actions.load).toHaveBeenCalledTimes(1);
    expect(actions.load).toHaveBeenCalledWith(BOOK);
    expect(field(q1.id).value).toBe("");
    expect(field(q2.id).value).toBe("The night market");
    expect(toneRadio("elegant").checked).toBe(true);
    expect(value).toMatchObject({ loaded: "loaded", touched: false });
  });

  it("coming back within the session shows the kept copy at once — no second load, nothing lost", async () => {
    await mount();
    await type(field(q1.id), "My sister");
    await click(toneRadio("joyful"));
    act(() => root.unmount()); // Back / Forward: the step unmounts, the wizard keeps `value`
    root = createRoot(container);
    await mount();
    expect(field(q1.id).value).toBe("My sister");
    expect(toneRadio("joyful").checked).toBe(true);
    expect(actions.load).toHaveBeenCalledTimes(1);
  });

  it("text typed before a slow load answers is never overwritten; untouched fields take the stored value", async () => {
    let release: (r: StoryAnswersResult) => void = () => {};
    actions.load.mockImplementation(() => new Promise<StoryAnswersResult>((r) => (release = r)));
    await mount();
    await type(field(q1.id), "Just me");
    await act(async () => {
      release(ok({ ...storedView, answers: [{ questionId: q1.id, text: "Old answer" }, { questionId: q2.id, text: "The night market" }] }));
      await tick(10);
    });
    expect(field(q1.id).value).toBe("Just me");
    expect(field(q2.id).value).toBe("The night market");
    expect(toneRadio("elegant").checked).toBe(true);
  });

  it("stored answers of questions that aren't asked now are ignored", () => {
    const draft = storyDraftFromView(
      { storyTone: "joyful", answers: [{ questionId: "wedding.moments", text: "The vows" }, { questionId: q1.id, text: "Us" }], skipped: false, rev: 1 },
      storyQuestionsFor("travel"),
    );
    expect(draft).toEqual({ storyTone: "joyful", answers: { [q1.id]: "Us" }, touched: false, loaded: "loaded" });
  });

  it("a failed save never traps the user: inline error (alert) with Try again and Continue without saving", async () => {
    actions.save.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    await mount();
    await type(field(q1.id), "My sister");
    await click($("story-continue"));
    expect(onContinue).not.toHaveBeenCalled();
    const err = $("story-save-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain(STORY_SAVE_FAILED);
    expect(field(q1.id).value).toBe("My sister"); // nothing lost
    for (const id of ["story-save-retry", "story-continue-unsaved"]) {
      expect($<HTMLButtonElement>(id).type).toBe("button");
      expect($(id).className).toContain("min-h-12");
    }
    // Try again repeats the same save and goes on when it works.
    await click($("story-save-retry"));
    expect(actions.save).toHaveBeenCalledTimes(2);
    expect(lastSave()[1]).toEqual({ storyTone: null, answers: [{ questionId: q1.id, text: "My sister" }], skipped: false });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("…or continue without saving (the story is optional); a thrown action is handled the same way", async () => {
    actions.save.mockRejectedValue(new Error("offline"));
    await mount();
    await click($("story-skip"));
    expect($("story-save-error")).toBeTruthy();
    expect(onContinue).not.toHaveBeenCalled();
    // Skip, Continue and Back all still work.
    expect($<HTMLButtonElement>("story-continue").disabled).toBe(false);
    expect($<HTMLButtonElement>("story-skip").disabled).toBe(false);
    await click($("story-continue-unsaved"));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(actions.save).toHaveBeenCalledTimes(1);
  });

  it("a failed load starts empty and never replaces the stored story with blanks on an untouched Continue", async () => {
    actions.load.mockResolvedValue({ ok: false, error: "unavailable" });
    await mount();
    expect(field(q1.id).value).toBe("");
    expect(value?.loaded).toBe("failed");
    await click($("story-continue"));
    expect(actions.save).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("…but once the user typed something, it is saved", async () => {
    actions.load.mockRejectedValue(new Error("offline"));
    await mount();
    await type(field(q1.id), "My sister");
    await click($("story-continue"));
    expect(lastSave()[1].answers).toEqual([{ questionId: q1.id, text: "My sister" }]);
  });

  it("while saving: one request, the buttons wait, Continue says so", async () => {
    let release: (r: StoryAnswersResult) => void = () => {};
    actions.save.mockImplementation(() => new Promise<StoryAnswersResult>((r) => (release = r)));
    await mount();
    await click($("story-continue"));
    await click($("story-continue"));
    await click($("story-skip"));
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect($("story-continue").textContent).toContain("Saving…");
    expect($("story-continue").getAttribute("aria-busy")).toBe("true");
    expect($<HTMLButtonElement>("story-skip").disabled).toBe(true);
    await act(async () => {
      release(ok());
      await tick(10);
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe("StepStory — pure helpers", () => {
  const questions = storyQuestionsFor("baby");

  it("clampStoryAnswer: code points, whole surrogate pairs, no line breaks", () => {
    expect(clampStoryAnswer("a\r\nb\n\nc")).toBe("a b c");
    expect(clampStoryAnswer("x".repeat(250))).toHaveLength(STORY_ANSWER_MAX);
    const emoji = clampStoryAnswer("👶".repeat(201));
    expect(Array.from(emoji)).toHaveLength(STORY_ANSWER_MAX);
    expect(emoji.endsWith("👶")).toBe(true);
    expect(clampStoryAnswer("short")).toBe("short");
  });

  it("storyInputFromDraft: asked questions only, in order; skip drops every answer", () => {
    const draft: StoryDraft = {
      ...EMPTY_STORY_DRAFT,
      storyTone: "heartfelt",
      answers: { [questions[1].id]: " B ", [questions[0].id]: "A", "travel.special": "not asked" },
    };
    expect(storyInputFromDraft(draft, questions, false)).toEqual({
      storyTone: "heartfelt",
      answers: [{ questionId: questions[0].id, text: "A" }, { questionId: questions[1].id, text: "B" }],
      skipped: false,
    });
    expect(storyInputFromDraft(draft, questions, true)).toEqual({ storyTone: "heartfelt", answers: [], skipped: true });
    expect(storyInputFromDraft(EMPTY_STORY_DRAFT, questions, false)).toEqual({ storyTone: null, answers: [], skipped: false });
  });
});

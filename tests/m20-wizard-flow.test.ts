// M20 T3 (D-072), re-derived for the Task 5 order (1 title, 2 occasion, 3 photos, 4 story, 5 design,
// 6 create, 7 preview): the pure wizard flow model — transitions, URL mapping, G2 locks, the build
// request's mapping, duplicate-book safety. The book is created on step-2 Continue; the build is asked
// for on step-5 Continue and never on step 3.
import { describe, expect, it } from "vitest";
import {
  canGoTo,
  FLOW_FORM_LAST_STEP,
  flowReducer,
  initFlowState,
  isStepLocked,
  parseFlowStep,
  transition,
  urlFor,
  urlForStep,
  type FlowAction,
  type FlowState,
  type FlowStep,
} from "@/lib/books/wizard-flow";
import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";

const BOOK = "11111111-2222-4333-8444-555555555555";
const RUN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const run = (state: FlowState, ...actions: FlowAction[]) => actions.reduce(flowReducer, state);
const create = (step: FlowStep = 1) => initFlowState({ step });
/** Create flow walked to step 2 (maxStep 2). */
const atStep2 = () => run(create(), { type: "continue" });
/** Book created, on step 3 (Photos), nothing picked yet. */
const atPhotos = () => run(atStep2(), { type: "created", bookId: BOOK });
/** A photo was picked and the upload settled. */
const withPhotos = () => run(atPhotos(), { type: "photosPicked" });
/** Mid-upload on step 3. */
const uploading = () => run(atPhotos(), { type: "photosPicked" }, { type: "uploadBusy", busy: true });
const atStory = () => run(withPhotos(), { type: "continue" });
const designing = () => run(atStory(), { type: "continue" });
const sorting = () => run(designing(), { type: "buildRequested" });
const reviewing = () => run(sorting(), { type: "buildDone" });
const auto = (outcome: AutoStartOutcome, retried = true, activeAtLoad = false): FlowAction => ({
  type: "autoStart",
  outcome,
  retried,
  activeAtLoad,
});

describe("urls + parsing", () => {
  it("maps create and edit modes", () => {
    expect(urlFor(create(2))).toBe("/books/new?step=2");
    expect(urlFor(atPhotos())).toBe(`/books/new?book=${BOOK}&step=3`);
    expect(urlFor(designing())).toBe(`/books/new?book=${BOOK}&step=5`);
    expect(urlForStep({ kind: "edit", bookId: "a b" }, 2)).toBe("/books/new?book=a%20b&step=2");
  });

  it("parses ?step=", () => {
    expect(parseFlowStep("7")).toBe(7);
    expect(parseFlowStep(["2", "5"])).toBe(2);
    expect(parseFlowStep(4)).toBe(4);
    for (const bad of ["0", "8", "1.0", " 3", "", null, undefined, 3.5, {}]) expect(parseFlowStep(bad)).toBeNull();
  });
});

describe("initFlowState", () => {
  it("the pre-book form is steps 1–2", () => {
    expect(FLOW_FORM_LAST_STEP).toBe(2);
  });

  it("create mode is clamped to the form steps (no book yet: never 3+)", () => {
    for (const step of [3, 4, 5, 6, 7] as const) {
      expect(initFlowState({ step })).toMatchObject({ mode: { kind: "create" }, step: 2, maxStep: 2 });
    }
    expect(initFlowState({ step: 1 })).toMatchObject({ step: 1, maxStep: 1 });
  });

  it("edit mode lifts past locked steps and implies flags", () => {
    // No photos yet: steps 1–2 are open and answered.
    expect(initFlowState({ bookId: BOOK, step: 1 })).toMatchObject({ step: 1, maxStep: 2, photosPicked: false });
    expect(initFlowState({ bookId: BOOK, step: 3 })).toMatchObject({ step: 3, maxStep: 3, photosPicked: false });
    // Photos in: 1–2 are locked → 3; 3–5 stay as asked.
    expect(initFlowState({ bookId: BOOK, step: 1, photosPicked: true })).toMatchObject({ step: 3, maxStep: 3 });
    expect(initFlowState({ bookId: BOOK, step: 2, photosPicked: true })).toMatchObject({ step: 3, maxStep: 3 });
    for (const step of [3, 4, 5] as const) {
      expect(initFlowState({ bookId: BOOK, step, photosPicked: true })).toMatchObject({ step, maxStep: step, runStarted: false });
    }
    // A run: ≤5 → 6.
    for (const step of [1, 3, 4, 5] as const) {
      expect(initFlowState({ bookId: BOOK, step, runStarted: true })).toMatchObject({
        step: 6,
        photosPicked: true,
        runStarted: true,
      });
    }
    expect(initFlowState({ bookId: BOOK, step: 6, done: true })).toMatchObject({
      step: 7,
      maxStep: 7,
      runStarted: true,
      done: true,
    });
  });
});

describe("steps 1–2 (the pre-book form)", () => {
  it("continue pushes the next step and raises maxStep", () => {
    const r = transition(create(), { type: "continue" });
    expect(r.state).toMatchObject({ step: 2, maxStep: 2 });
    expect(r.effect).toEqual({ kind: "push", url: "/books/new?step=2" });
  });

  it("the book is created on step-2 Continue: a submit intent, and the state doesn't move", () => {
    const s = atStep2();
    const r = transition(s, { type: "continue" });
    expect(r.state).toBe(s);
    expect(r.effect).toEqual({ kind: "none" });
    expect(r.intent).toEqual({ kind: "submit", mode: { kind: "create" } });
    // Step 1 never submits.
    expect(transition(create(), { type: "continue" }).intent).toBeUndefined();
  });

  it("continue from 2 in edit mode submits with the book", () => {
    const s = initFlowState({ bookId: BOOK, step: 2 });
    expect(transition(s, { type: "continue" }).intent).toEqual({ kind: "submit", mode: { kind: "edit", bookId: BOOK } });
  });

  it("back pushes the previous step (history.back preferred); step 1 back does nothing", () => {
    const r = transition(atStep2(), { type: "back" });
    expect(r.state.step).toBe(1);
    expect(r.state.maxStep).toBe(2);
    expect(r.effect).toEqual({ kind: "push", url: "/books/new?step=1", preferHistoryBack: true });
    expect(transition(create(), { type: "back" })).toMatchObject({ effect: { kind: "none" } });
  });

  it("stepper: reached steps only, never the current one", () => {
    const s = run(atStep2(), { type: "goTo", step: 1 });
    expect(s.step).toBe(1);
    expect(canGoTo(s, 2)).toBe(true);
    expect(canGoTo(s, 1)).toBe(false);
    expect(canGoTo(s, 3)).toBe(false);
    expect(run(s, { type: "goTo", step: 2 }).step).toBe(2);
  });

  it("goTo beyond maxStep is refused (replace with current)", () => {
    const s = create();
    const r = transition(s, { type: "goTo", step: 2 });
    expect(r.refused).toBe(true);
    expect(r.state).toBe(s);
    expect(r.effect).toEqual({ kind: "replace", url: "/books/new?step=1" });
  });

  it("goTo the current step is a no-op", () => {
    const s = create(1);
    expect(transition(s, { type: "goTo", step: 1 })).toEqual({ state: s, effect: { kind: "none" } });
  });

  it("goTo forward from the form into 3+ is refused (must Continue so edits are saved)", () => {
    const s = run(atPhotos(), { type: "back" }); // edit step 2, maxStep 3
    expect(s).toMatchObject({ step: 2, maxStep: 3 });
    expect(canGoTo(s, 3)).toBe(false);
    expect(transition(s, { type: "goTo", step: 3 }).refused).toBe(true);
  });
});

describe("created (duplicate-book safety)", () => {
  it("switches to edit mode, rewrites the step-2 entry and pushes step 3 (Photos)", () => {
    const r = transition(atStep2(), { type: "created", bookId: BOOK });
    expect(r.state).toMatchObject({ mode: { kind: "edit", bookId: BOOK }, step: 3, maxStep: 3, runStarted: false });
    expect(r.effect).toEqual({
      kind: "push",
      url: `/books/new?book=${BOOK}&step=3`,
      replaceCurrent: `/books/new?book=${BOOK}&step=2`,
    });
    // Creating the book asks for nothing else (no build).
    expect(r.intent).toBeUndefined();
  });

  it("a late created answer after step 3 is ignored", () => {
    const s = atPhotos();
    expect(transition(s, { type: "created", bookId: "other" })).toEqual({ state: s, effect: { kind: "none" } });
  });

  it("after created, popstate to 1 (old create entry) shows edit mode step 1 and fixes the URL", () => {
    const r = transition(atPhotos(), { type: "popstate", step: "1", bookId: null });
    expect(r.state).toMatchObject({ mode: { kind: "edit", bookId: BOOK }, step: 1 });
    expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=1` });
    // Continue from 2 then saves this book (never a second createBookAction).
    const s2 = run(r.state, { type: "continue" });
    expect(s2.step).toBe(2);
    expect(transition(s2, { type: "continue" }).intent).toEqual({ kind: "submit", mode: { kind: "edit", bookId: BOOK } });
  });

  it("popstate to an edit entry of the same book just follows the URL", () => {
    const r = transition(atPhotos(), { type: "popstate", step: "2", bookId: BOOK });
    expect(r.state.step).toBe(2);
    expect(r.effect).toEqual({ kind: "none" });
  });

  it("a URL naming a book while creating, or another book, reloads", () => {
    expect(transition(atStep2(), { type: "popstate", step: "2", bookId: BOOK }).effect).toEqual({ kind: "reload" });
    expect(transition(atPhotos(), { type: "popstate", step: "2", bookId: "other" }).effect).toEqual({ kind: "reload" });
  });
});

describe("popstate", () => {
  it("follows reached steps without touching history", () => {
    const s = atStep2();
    const r = transition(s, { type: "popstate", step: "1" });
    expect(r.state).toMatchObject({ step: 1, maxStep: 2 });
    expect(r.effect).toEqual({ kind: "none" });
  });

  it("refuses steps above maxStep, 3+ in create mode and junk", () => {
    const s = atStep2();
    for (const step of ["3", "5", "7", "x", undefined]) {
      const r = transition(s, { type: "popstate", step });
      expect(r.refused).toBe(true);
      expect(r.state).toBe(s);
      expect(r.effect).toEqual({ kind: "replace", url: "/books/new?step=2" });
    }
    const one = create();
    expect(transition(one, { type: "popstate", step: "2" }).refused).toBe(true);
  });

  it("an old bookmark's step number can't crash the flow: an unreached step is refused", () => {
    const s = atPhotos();
    const r = transition(s, { type: "popstate", step: "5", bookId: BOOK });
    expect(r).toMatchObject({ refused: true, state: s, effect: { kind: "replace", url: `/books/new?book=${BOOK}&step=3` } });
  });
});

describe("G2 locks", () => {
  it("once a photo is picked steps 1–2 are locked: back, popstate and stepper are refused", () => {
    const s = withPhotos();
    expect(transition(s, { type: "back" })).toMatchObject({ refused: true, state: s });
    for (const step of [1, 2] as const) {
      expect(isStepLocked(s, step)).toBe(true);
      expect(canGoTo(s, step)).toBe(false);
      expect(transition(s, { type: "goTo", step }).refused).toBe(true);
      const r = transition(s, { type: "popstate", step: String(step), bookId: BOOK });
      expect(r.refused).toBe(true);
      expect(r.state).toBe(s);
      expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=3` });
    }
    // From Story / Design too.
    for (const later of [atStory(), designing()]) {
      for (const step of [1, 2] as const) {
        expect(canGoTo(later, step)).toBe(false);
        expect(transition(later, { type: "popstate", step: String(step), bookId: BOOK }).refused).toBe(true);
      }
    }
  });

  it("before a photo is picked, back from 3 re-opens step 2 in edit mode", () => {
    const r = transition(atPhotos(), { type: "back" });
    expect(r.state).toMatchObject({ mode: { kind: "edit", bookId: BOOK }, step: 2 });
    expect(r.effect).toMatchObject({ kind: "push", url: `/books/new?book=${BOOK}&step=2` });
  });

  it("steps 3–5 stay open until a run starts: Back / Forward / stepper move freely", () => {
    const d = designing();
    expect(d).toMatchObject({ step: 5, maxStep: 5, runStarted: false });
    for (const step of [3, 4] as const) {
      expect(isStepLocked(d, step)).toBe(false);
      expect(canGoTo(d, step)).toBe(true);
    }
    const back = transition(d, { type: "back" });
    expect(back.state.step).toBe(4);
    expect(back.effect).toEqual({ kind: "push", url: `/books/new?book=${BOOK}&step=4`, preferHistoryBack: true });
    const three = transition(back.state, { type: "popstate", step: "3", bookId: BOOK });
    expect(three.state.step).toBe(3);
    expect(three.effect).toEqual({ kind: "none" });
    // Browser Forward to steps already reached.
    const fwd = transition(three.state, { type: "popstate", step: "5", bookId: BOOK });
    expect(fwd.state).toMatchObject({ step: 5, maxStep: 5 });
    expect(fwd.refused).toBeUndefined();
    // … and the stepper back from Design to Photos.
    expect(run(d, { type: "goTo", step: 3 }).step).toBe(3);
  });

  it("while photos upload the wizard stays on step 3 (leaving would cancel the upload)", () => {
    const visited = run(designing(), { type: "goTo", step: 3 }, { type: "uploadBusy", busy: true });
    expect(visited).toMatchObject({ step: 3, maxStep: 5, uploading: true });
    for (const step of ["4", "5", "2"]) {
      const r = transition(visited, { type: "popstate", step, bookId: BOOK });
      expect(r).toMatchObject({ refused: true, state: visited, effect: { kind: "replace", url: `/books/new?book=${BOOK}&step=3` } });
    }
    expect(transition(visited, { type: "continue" })).toMatchObject({ state: visited, effect: { kind: "none" } });
    // Settled → open again.
    const settled = run(visited, { type: "uploadBusy", busy: false });
    expect(settled.uploading).toBe(false);
    expect(transition(settled, { type: "popstate", step: "5", bookId: BOOK }).state.step).toBe(5);
  });

  it("once a run started steps ≤ 5 are locked: popstate / back / stepper stay on 6", () => {
    const s = sorting();
    expect(s.step).toBe(6);
    for (const step of ["5", "4", "3", "1"]) {
      const r = transition(s, { type: "popstate", step, bookId: BOOK });
      expect(r).toMatchObject({ refused: true, state: s, effect: { kind: "replace", url: `/books/new?book=${BOOK}&step=6` } });
    }
    expect(transition(s, { type: "back" }).refused).toBe(true);
    for (const step of [1, 2, 3, 4, 5] as const) {
      expect(isStepLocked(s, step)).toBe(true);
      expect(canGoTo(s, step)).toBe(false);
    }
  });

  it("a finished run never shows step 6 again: popstate to ≤ 6 stays on 7", () => {
    const s = reviewing();
    for (const step of ["6", "5", "4", "3", "2"]) {
      const r = transition(s, { type: "popstate", step, bookId: BOOK });
      expect(r).toMatchObject({ refused: true, state: s, effect: { kind: "replace", url: `/books/new?book=${BOOK}&step=7` } });
    }
    expect(transition(s, { type: "back" }).refused).toBe(true);
    for (const step of [1, 2, 3, 4, 5, 6] as const) expect(canGoTo(s, step)).toBe(false);
  });
});

describe("step 3 (Photos): uploads only, never a build", () => {
  it("photosPicked only counts on step 3", () => {
    expect(run(atStep2(), { type: "photosPicked" }).photosPicked).toBe(false);
    expect(withPhotos().photosPicked).toBe(true);
    expect(uploading()).toMatchObject({ photosPicked: true, uploading: true });
    // uploadBusy elsewhere is ignored.
    expect(run(atStory(), { type: "uploadBusy", busy: true }).uploading).toBe(false);
  });

  it("Continue needs a photo and a settled upload, then goes to the Story step — no build intent, no run flag", () => {
    expect(transition(atPhotos(), { type: "continue" })).toMatchObject({ state: { step: 3 }, effect: { kind: "none" } });
    expect(transition(uploading(), { type: "continue" })).toMatchObject({ state: { step: 3 }, effect: { kind: "none" } });
    const r = transition(withPhotos(), { type: "continue" });
    expect(r.state).toMatchObject({ step: 4, maxStep: 4, runStarted: false, done: false });
    expect(r.effect).toEqual({ kind: "push", url: `/books/new?book=${BOOK}&step=4` });
    expect(r.intent).toBeUndefined();
  });

  it("build actions are ignored on step 3 (and on the Story step)", () => {
    for (const s of [withPhotos(), atStory()]) {
      for (const action of [
        { type: "buildRequested" },
        { type: "autoStartPending" },
        auto({ kind: "started", runId: RUN, mode: "live", state: "queued" }),
      ] as FlowAction[]) {
        expect(transition(s, action)).toEqual({ state: s, effect: { kind: "none" } });
      }
    }
  });

  it("runStarted (another tab started the build) moves an open step to 6", () => {
    for (const s of [withPhotos(), atStory(), designing()]) {
      const r = transition(s, { type: "runStarted" });
      expect(r.state).toMatchObject({ step: 6, runStarted: true });
      expect(r.effect).toEqual({ kind: "push", url: `/books/new?book=${BOOK}&step=6` });
    }
    expect(transition(atStep2(), { type: "runStarted" }).state.runStarted).toBe(false);
  });
});

describe("step 4 (Story): optional", () => {
  it("Continue always goes on to Design (the step saves itself; skipping is the same move)", () => {
    const r = transition(atStory(), { type: "continue" });
    expect(r.state).toMatchObject({ step: 5, maxStep: 5, runStarted: false });
    expect(r.effect).toEqual({ kind: "push", url: `/books/new?book=${BOOK}&step=5` });
    expect(r.intent).toBeUndefined();
  });

  it("Back returns to Photos", () => {
    expect(transition(atStory(), { type: "back" }).state.step).toBe(3);
  });
});

describe("step 5 (Design): the build is requested on its Continue", () => {
  it("Continue returns the startBuild intent and doesn't move", () => {
    const s = designing();
    const r = transition(s, { type: "continue" });
    expect(r.state).toBe(s);
    expect(r.effect).toEqual({ kind: "none" });
    expect(r.intent).toEqual({ kind: "startBuild", bookId: BOOK });
  });

  it("buildRequested goes to step 6 and locks steps ≤ 5 at once (step 6 always starts / resumes a run)", () => {
    const r = transition(designing(), { type: "buildRequested" });
    expect(r.state).toMatchObject({ step: 6, maxStep: 6, runStarted: true, photosPicked: true });
    expect(r.effect).toEqual({ kind: "push", url: `/books/new?book=${BOOK}&step=6` });
    expect(isStepLocked(r.state, 5)).toBe(true);
    expect(canGoTo(r.state, 5)).toBe(false);
    // Back / browser Back / stepper can't reopen a stale Design step while the run is starting.
    const back = transition(r.state, { type: "back" });
    expect(back.refused).toBe(true);
    expect(back.state.step).toBe(6);
    const pop = transition(r.state, { type: "popstate", step: "5", bookId: BOOK });
    expect(pop.refused).toBe(true);
    expect(pop.state.step).toBe(6);
    expect(transition(r.state, { type: "goTo", step: 5 }).refused).toBe(true);
    // A second request (e.g. a late tap) does nothing.
    expect(transition(r.state, { type: "buildRequested" })).toMatchObject({ state: r.state, effect: { kind: "none" } });
    // The run then reports in: stays on 6.
    const started = run(r.state, { type: "runStarted" });
    expect(started).toMatchObject({ step: 6, runStarted: true });
  });

  it("buildRequested from a hard-loaded step 5 also locks everything before it", () => {
    const r = transition(initFlowState({ bookId: BOOK, step: 5, photosPicked: true }), { type: "buildRequested" });
    expect(r.state).toMatchObject({ step: 6, runStarted: true, photosPicked: true });
    for (const step of [1, 2, 3, 4, 5] as const) expect(isStepLocked(r.state, step)).toBe(true);
  });
});

describe("autoStart mapping (the build request's answer on step 5)", () => {
  const s = designing();
  const step6 = { kind: "push", url: `/books/new?book=${BOOK}&step=6` };
  const editor = `/books/${BOOK}/edit`;

  it("started (AI) and already_running → step 6", () => {
    for (const outcome of [
      { kind: "started", runId: RUN, mode: "live", state: "queued" },
      { kind: "started", runId: RUN, mode: "rule", state: "curating" },
      { kind: "already_running", runId: null },
    ] as AutoStartOutcome[]) {
      const r = transition(s, auto(outcome));
      expect(r.state).toMatchObject({ step: 6, runStarted: true });
      expect(r.effect).toEqual(step6);
    }
  });

  it("M20b: a rule run finished (or failed) inside the POST → step 6, never the editor", () => {
    for (const state of ["done", "failed"] as const) {
      const r = transition(s, auto({ kind: "started", runId: RUN, mode: "rule", state }));
      expect(r.state).toMatchObject({ step: 6, runStarted: true, photosPicked: true, done: false });
      expect(r.effect).toEqual(step6);
    }
  });

  it("M20b: autoStartPending (answer still on its way) → step 6, step 5 locked; ignored elsewhere", () => {
    const r = transition(s, { type: "autoStartPending" });
    expect(r.state).toMatchObject({ step: 6, runStarted: true, photosPicked: true });
    expect(r.effect).toEqual(step6);
    expect(isStepLocked(r.state, 5)).toBe(true);
    // a late known answer after the hand-over changes nothing
    expect(transition(r.state, auto({ kind: "started", runId: RUN, mode: "rule", state: "done" })).effect).toEqual({ kind: "none" });
    // not on step 5 / already running
    expect(transition(r.state, { type: "autoStartPending" }).effect).toEqual({ kind: "none" });
  });

  it("not_first → step 6 when a run was active at load, else step 7 preview", () => {
    expect(transition(s, auto({ kind: "not_first" }, true, true)).effect).toEqual(step6);
    const r = transition(s, auto({ kind: "not_first" }));
    expect(r.state).toMatchObject({ step: 7, done: true, runStarted: true });
    expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=7` });
  });

  it("user_edited → editor", () => {
    expect(transition(s, auto({ kind: "user_edited" })).effect).toEqual({ kind: "navigate", target: "editor", href: editor });
  });

  it("not_ready (fewer photos than the automatic build wants) → step 6, where the build starts the plain way", () => {
    const r = transition(s, auto({ kind: "not_ready" }));
    expect(r.state).toMatchObject({ step: 6, runStarted: true, autoStartError: null });
    expect(r.effect).toEqual(step6);
    expect(r.intent).toBeUndefined();
  });

  it("limit / signed_out / error → stay on 5 with the reason; nothing is locked", () => {
    expect(transition(s, auto({ kind: "limit", limit: "rebuilds" })).state).toMatchObject({
      step: 5,
      runStarted: false,
      autoStartError: { kind: "fallback", limit: "rebuilds" },
    });
    for (const kind of ["signed_out", "error"] as const) {
      const r = transition(s, auto({ kind }));
      expect(r.state).toMatchObject({ step: 5, runStarted: false, autoStartError: { kind: "fallback" } });
      expect(r.effect).toEqual({ kind: "none" });
      // Continue asks again; Back is still open.
      expect(transition(r.state, { type: "continue" }).intent).toEqual({ kind: "startBuild", bookId: BOOK });
      expect(transition(r.state, { type: "back" }).state.step).toBe(4);
    }
  });

  it("is ignored off step 5 or once a run exists", () => {
    const six = sorting();
    expect(transition(six, auto({ kind: "error" })).state).toBe(six);
    const two = atStep2();
    expect(transition(two, auto({ kind: "already_running", runId: null })).state).toBe(two);
  });

  it("leaving the step clears the reason", () => {
    const failed = run(s, auto({ kind: "error" }));
    expect(failed.autoStartError).toEqual({ kind: "fallback" });
    expect(run(failed, { type: "back" }).autoStartError).toBeNull();
    // … and a later answer that starts the run moves on.
    expect(run(failed, auto({ kind: "started", runId: RUN, mode: "live", state: "queued" }))).toMatchObject({
      step: 6,
      autoStartError: null,
    });
  });
});

describe("steps 6–7", () => {
  it("buildDone → 7 (replace) and locks 6", () => {
    const r = transition(sorting(), { type: "buildDone" });
    expect(r.state).toMatchObject({ step: 7, maxStep: 7, done: true });
    expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=7` });
    expect(transition(atStep2(), { type: "buildDone" }).state.done).toBe(false);
  });

  it("buildStopped keeps step 6 with the stop flag; leaving 6 clears it", () => {
    const stopped = run(sorting(), { type: "buildStopped", reason: "limit" });
    expect(stopped).toMatchObject({ step: 6, stop: "limit" });
    expect(run(stopped, { type: "buildDone" }).stop).toBeNull();
    expect(run(designing(), { type: "buildStopped", reason: "failed" }).stop).toBeNull();
  });

  it("buildResumed (Try again) clears the stop flag on step 6 only", () => {
    const stopped = run(sorting(), { type: "buildStopped", reason: "failed" });
    const resumed = transition(stopped, { type: "buildResumed" });
    expect(resumed.state).toMatchObject({ step: 6, stop: null });
    expect(resumed.effect).toEqual({ kind: "none" });
    // A later stop is recorded again.
    expect(run(resumed.state, { type: "buildStopped", reason: "unavailable" }).stop).toBe("unavailable");
    // No stop → same state object; other steps untouched.
    const s6 = sorting();
    expect(transition(s6, { type: "buildResumed" }).state).toBe(s6);
    const r7 = reviewing();
    expect(transition(r7, { type: "buildResumed" }).state).toBe(r7);
  });

  it("continue on 6 does nothing; on 7 asks to confirm", () => {
    expect(transition(sorting(), { type: "continue" })).toMatchObject({ effect: { kind: "none" } });
    expect(transition(sorting(), { type: "continue" }).intent).toBeUndefined();
    expect(transition(reviewing(), { type: "continue" }).intent).toEqual({ kind: "confirm", bookId: BOOK });
  });

  it("confirm → editor; only on step 7", () => {
    expect(transition(reviewing(), { type: "confirm" }).effect).toEqual({
      kind: "navigate",
      target: "editor",
      href: `/books/${BOOK}/edit`,
    });
    expect(transition(sorting(), { type: "confirm" }).effect).toEqual({ kind: "none" });
  });

  it("hard load of step 7 can confirm straight away", () => {
    const s = initFlowState({ bookId: BOOK, step: 7, done: true });
    expect(transition(s, { type: "continue" }).intent).toEqual({ kind: "confirm", bookId: BOOK });
  });
});

// M20 T3 (D-072): the pure wizard flow model — transitions, URL mapping, G2 locks, auto-start
// mapping, duplicate-book safety.
import { describe, expect, it } from "vitest";
import {
  AUTO_START_RETRY_MS,
  canGoTo,
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
/** Create flow walked to step 4 (maxStep 4). */
const atStep4 = () => run(create(), { type: "continue" }, { type: "continue" }, { type: "continue" });
/** Book created, on step 5. */
const atStep5 = () => run(atStep4(), { type: "created", bookId: BOOK });
const uploading = () => run(atStep5(), { type: "photosPicked" });
const sorting = () => run(uploading(), { type: "runStarted" });
const reviewing = () => run(sorting(), { type: "buildDone" });
const auto = (outcome: AutoStartOutcome, retried = false, activeAtLoad = false): FlowAction => ({
  type: "autoStart",
  outcome,
  retried,
  activeAtLoad,
});

describe("urls + parsing", () => {
  it("maps create and edit modes", () => {
    expect(urlFor(create(3))).toBe("/books/new?step=3");
    expect(urlFor(atStep5())).toBe(`/books/new?book=${BOOK}&step=5`);
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
  it("create mode is clamped to the form steps", () => {
    const s = initFlowState({ step: 6 });
    expect(s).toMatchObject({ mode: { kind: "create" }, step: 4, maxStep: 4 });
  });

  it("edit mode lifts past locked steps and implies flags", () => {
    expect(initFlowState({ bookId: BOOK, step: 2 })).toMatchObject({ step: 2, maxStep: 4, photosPicked: false });
    expect(initFlowState({ bookId: BOOK, step: 3, photosPicked: true })).toMatchObject({ step: 5, maxStep: 5 });
    expect(initFlowState({ bookId: BOOK, step: 5, runStarted: true })).toMatchObject({
      step: 6,
      photosPicked: true,
      runStarted: true,
    });
    expect(initFlowState({ bookId: BOOK, step: 6, done: true })).toMatchObject({
      step: 7,
      maxStep: 7,
      runStarted: true,
      done: true,
    });
  });
});

describe("steps 1–4", () => {
  it("continue pushes the next step and raises maxStep", () => {
    const r = transition(create(), { type: "continue" });
    expect(r.state).toMatchObject({ step: 2, maxStep: 2 });
    expect(r.effect).toEqual({ kind: "push", url: "/books/new?step=2" });
  });

  it("continue from 4 in create mode returns a submit intent and doesn't move", () => {
    const s = atStep4();
    const r = transition(s, { type: "continue" });
    expect(r.state).toBe(s);
    expect(r.effect).toEqual({ kind: "none" });
    expect(r.intent).toEqual({ kind: "submit", mode: { kind: "create" } });
  });

  it("continue from 4 in edit mode submits with the book", () => {
    const s = initFlowState({ bookId: BOOK, step: 4 });
    expect(transition(s, { type: "continue" }).intent).toEqual({ kind: "submit", mode: { kind: "edit", bookId: BOOK } });
  });

  it("back pushes the previous step (history.back preferred); step 1 back does nothing", () => {
    const r = transition(run(create(), { type: "continue" }), { type: "back" });
    expect(r.state.step).toBe(1);
    expect(r.state.maxStep).toBe(2);
    expect(r.effect).toEqual({ kind: "push", url: "/books/new?step=1", preferHistoryBack: true });
    expect(transition(create(), { type: "back" })).toMatchObject({ effect: { kind: "none" } });
  });

  it("stepper: reached steps only, never the current one", () => {
    const s = run(atStep4(), { type: "goTo", step: 2 });
    expect(s.step).toBe(2);
    expect(canGoTo(s, 4)).toBe(true);
    expect(canGoTo(s, 2)).toBe(false);
    expect(canGoTo(s, 5)).toBe(false);
    expect(run(s, { type: "goTo", step: 4 }).step).toBe(4);
  });

  it("goTo beyond maxStep is refused (replace with current)", () => {
    const s = run(create(), { type: "continue" });
    const r = transition(s, { type: "goTo", step: 3 });
    expect(r.refused).toBe(true);
    expect(r.state).toBe(s);
    expect(r.effect).toEqual({ kind: "replace", url: "/books/new?step=2" });
  });

  it("goTo the current step is a no-op", () => {
    const s = create(1);
    expect(transition(s, { type: "goTo", step: 1 })).toEqual({ state: s, effect: { kind: "none" } });
  });

  it("goTo forward from the form into 5+ is refused (must Continue so edits are saved)", () => {
    const s = run(atStep5(), { type: "back" }); // edit step 4, maxStep 5
    expect(s).toMatchObject({ step: 4, maxStep: 5 });
    expect(canGoTo(s, 5)).toBe(false);
    expect(transition(s, { type: "goTo", step: 5 }).refused).toBe(true);
  });
});

describe("created (duplicate-book safety)", () => {
  it("switches to edit mode, rewrites the step-4 entry and pushes step 5", () => {
    const r = transition(atStep4(), { type: "created", bookId: BOOK });
    expect(r.state).toMatchObject({ mode: { kind: "edit", bookId: BOOK }, step: 5, maxStep: 5 });
    expect(r.effect).toEqual({
      kind: "push",
      url: `/books/new?book=${BOOK}&step=5`,
      replaceCurrent: `/books/new?book=${BOOK}&step=4`,
    });
  });

  it("a late created answer after step 5 is ignored", () => {
    const s = atStep5();
    expect(transition(s, { type: "created", bookId: "other" })).toEqual({ state: s, effect: { kind: "none" } });
  });

  it("after created, popstate to 1 (old create entry) shows edit mode step 1 and fixes the URL", () => {
    const r = transition(atStep5(), { type: "popstate", step: "1", bookId: null });
    expect(r.state).toMatchObject({ mode: { kind: "edit", bookId: BOOK }, step: 1 });
    expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=1` });
    // Continue from 4 then saves this book (never a second createBookAction).
    const s4 = run(r.state, { type: "goTo", step: 4 });
    expect(transition(s4, { type: "continue" }).intent).toEqual({ kind: "submit", mode: { kind: "edit", bookId: BOOK } });
  });

  it("popstate to an edit entry of the same book just follows the URL", () => {
    const r = transition(atStep5(), { type: "popstate", step: "4", bookId: BOOK });
    expect(r.state.step).toBe(4);
    expect(r.effect).toEqual({ kind: "none" });
  });

  it("a URL naming a book while creating, or another book, reloads", () => {
    expect(transition(atStep4(), { type: "popstate", step: "4", bookId: BOOK }).effect).toEqual({ kind: "reload" });
    expect(transition(atStep5(), { type: "popstate", step: "4", bookId: "other" }).effect).toEqual({ kind: "reload" });
  });
});

describe("popstate", () => {
  it("follows reached steps without touching history", () => {
    const s = atStep4();
    const r = transition(s, { type: "popstate", step: "2" });
    expect(r.state).toMatchObject({ step: 2, maxStep: 4 });
    expect(r.effect).toEqual({ kind: "none" });
  });

  it("refuses steps above maxStep, 5+ in create mode and junk", () => {
    const s = run(create(), { type: "continue" });
    for (const step of ["3", "5", "x", undefined]) {
      const r = transition(s, { type: "popstate", step });
      expect(r.refused).toBe(true);
      expect(r.state).toBe(s);
      expect(r.effect).toEqual({ kind: "replace", url: "/books/new?step=2" });
    }
  });
});

describe("G2 locks", () => {
  it("popstate to 3 while uploading stays on 5 (replace)", () => {
    const s = uploading();
    const r = transition(s, { type: "popstate", step: "3", bookId: BOOK });
    expect(r.refused).toBe(true);
    expect(r.state).toBe(s);
    expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=5` });
  });

  it("back and stepper ≤4 are refused once a photo is picked", () => {
    const s = uploading();
    expect(transition(s, { type: "back" })).toMatchObject({ refused: true, state: s });
    for (const step of [1, 2, 3, 4] as const) {
      expect(isStepLocked(s, step)).toBe(true);
      expect(canGoTo(s, step)).toBe(false);
      expect(transition(s, { type: "goTo", step }).refused).toBe(true);
    }
  });

  it("before a photo is picked, back from 5 re-opens step 4 in edit mode", () => {
    const r = transition(atStep5(), { type: "back" });
    expect(r.state).toMatchObject({ mode: { kind: "edit", bookId: BOOK }, step: 4 });
    expect(r.effect).toMatchObject({ kind: "push", url: `/books/new?book=${BOOK}&step=4` });
  });

  it("after the run started, popstate to 5 stays on 6", () => {
    const s = sorting();
    expect(s.step).toBe(6);
    const r = transition(s, { type: "popstate", step: "5", bookId: BOOK });
    expect(r).toMatchObject({ refused: true, state: s, effect: { kind: "replace", url: `/books/new?book=${BOOK}&step=6` } });
    expect(transition(s, { type: "back" }).refused).toBe(true);
    expect(canGoTo(s, 5)).toBe(false);
  });

  it("after the build, popstate to 5 or 6 stays on 7", () => {
    const s = reviewing();
    for (const step of ["5", "6", "2"]) {
      const r = transition(s, { type: "popstate", step, bookId: BOOK });
      expect(r).toMatchObject({ refused: true, state: s, effect: { kind: "replace", url: `/books/new?book=${BOOK}&step=7` } });
    }
    expect(transition(s, { type: "back" }).refused).toBe(true);
    for (const step of [1, 2, 3, 4, 5, 6] as const) expect(canGoTo(s, step)).toBe(false);
  });
});

describe("step 5", () => {
  it("photosPicked only counts on step 5", () => {
    expect(run(atStep4(), { type: "photosPicked" }).photosPicked).toBe(false);
    expect(uploading().photosPicked).toBe(true);
  });

  it("uploadsSettled asks for the auto build once photos exist", () => {
    expect(transition(atStep5(), { type: "uploadsSettled" }).intent).toBeUndefined();
    expect(transition(uploading(), { type: "uploadsSettled" }).intent).toEqual({ kind: "autoStart", bookId: BOOK });
    expect(transition(uploading(), { type: "continue" }).intent).toEqual({ kind: "autoStart", bookId: BOOK });
    expect(transition(atStep5(), { type: "continue" }).intent).toBeUndefined();
  });

  it("fallback button goes to step 6 without locking 5 until the run exists", () => {
    const r = transition(uploading(), { type: "buildRequested" });
    expect(r.state).toMatchObject({ step: 6, maxStep: 6, runStarted: false });
    expect(r.effect).toEqual({ kind: "push", url: `/books/new?book=${BOOK}&step=6` });
    const started = run(r.state, { type: "runStarted" });
    expect(started).toMatchObject({ step: 6, runStarted: true });
    expect(canGoTo(started, 5)).toBe(false);
  });

  it("runStarted on step 5 moves to 6", () => {
    const r = transition(uploading(), { type: "runStarted" });
    expect(r.state).toMatchObject({ step: 6, runStarted: true });
    expect(r.effect).toEqual({ kind: "push", url: `/books/new?book=${BOOK}&step=6` });
    expect(transition(atStep4(), { type: "runStarted" }).state.runStarted).toBe(false);
  });
});

describe("autoStart mapping", () => {
  const s = uploading();
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

  it("a rule run finished inside the POST → editor with the rules outcome", () => {
    expect(transition(s, auto({ kind: "started", runId: RUN, mode: "rule", state: "done" })).effect).toEqual({
      kind: "navigate",
      target: "editor",
      href: editor,
      rules: { outcome: "ok" },
    });
    expect(transition(s, auto({ kind: "started", runId: RUN, mode: "rule", state: "failed" })).effect).toMatchObject({
      rules: { outcome: "failed" },
    });
  });

  it("not_first → step 6 when a run was active at load, else step 7 review", () => {
    expect(transition(s, auto({ kind: "not_first" }, false, true)).effect).toEqual(step6);
    const r = transition(s, auto({ kind: "not_first" }));
    expect(r.state).toMatchObject({ step: 7, done: true, runStarted: true });
    expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=7` });
  });

  it("user_edited → editor", () => {
    expect(transition(s, auto({ kind: "user_edited" })).effect).toEqual({ kind: "navigate", target: "editor", href: editor });
  });

  it("not_ready → retry once, then fallback on 5", () => {
    const first = transition(s, auto({ kind: "not_ready" }));
    expect(first.state).toBe(s);
    expect(first.intent).toEqual({ kind: "retryAutoStart", bookId: BOOK, afterMs: AUTO_START_RETRY_MS });
    const second = transition(s, auto({ kind: "not_ready" }, true));
    expect(second.state).toMatchObject({ step: 5, autoStartError: { kind: "fallback" } });
  });

  it("limit / signed_out / error → stay on 5 with the fallback", () => {
    expect(transition(s, auto({ kind: "limit", limit: "rebuilds" })).state).toMatchObject({
      step: 5,
      autoStartError: { kind: "fallback", limit: "rebuilds" },
    });
    for (const kind of ["signed_out", "error"] as const) {
      const r = transition(s, auto({ kind }));
      expect(r.state).toMatchObject({ step: 5, autoStartError: { kind: "fallback" } });
      expect(r.effect).toEqual({ kind: "none" });
    }
  });

  it("is ignored off step 5 or once a run exists", () => {
    const six = sorting();
    expect(transition(six, auto({ kind: "error" })).state).toBe(six);
    const four = atStep4();
    expect(transition(four, auto({ kind: "already_running", runId: null })).state).toBe(four);
  });

  it("a new settle clears the fallback", () => {
    const failed = run(s, auto({ kind: "error" }));
    expect(run(failed, { type: "uploadsSettled" }).autoStartError).toBeNull();
  });
});

describe("steps 6–7", () => {
  it("buildDone → 7 (replace) and locks 6", () => {
    const r = transition(sorting(), { type: "buildDone" });
    expect(r.state).toMatchObject({ step: 7, maxStep: 7, done: true });
    expect(r.effect).toEqual({ kind: "replace", url: `/books/new?book=${BOOK}&step=7` });
    expect(transition(atStep4(), { type: "buildDone" }).state.done).toBe(false);
  });

  it("buildStopped keeps step 6 with the stop flag; leaving 6 clears it", () => {
    const stopped = run(sorting(), { type: "buildStopped", reason: "limit" });
    expect(stopped).toMatchObject({ step: 6, stop: "limit" });
    expect(run(stopped, { type: "buildDone" }).stop).toBeNull();
    expect(run(uploading(), { type: "buildStopped", reason: "failed" }).stop).toBeNull();
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
